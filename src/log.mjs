import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { format } from "node:util";
import { status } from "./status.mjs";
import { appendRotatingLines, parseByteLimit } from "./file-rotation.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";

let globalInstall = null;
const DEFAULT_LOG_MAX_BYTES = 16 * 1024 * 1024;
const LOG_QUEUE_MAX_BYTES = 2 * 1024 * 1024;
const LOG_QUEUE_MAX_RECORDS = 4096;

export function debugLoggingStats() {
  return globalInstall?.stats() || { enabled: false };
}

export function normalizeLogLevel(value) {
  return String(value || "info").trim().toLowerCase() === "debug" ? "debug" : "info";
}

export function defaultLogPath({ home = os.homedir() } = {}) {
  return path.join(home, ".local", "share", "codex-copilot-dx", "debug.log");
}

export function resolveLogPath(value, { home = os.homedir() } = {}) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (["1", "true", "yes"].includes(raw.toLowerCase())) return defaultLogPath({ home });
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  return raw;
}

export function isDebugLoggingEnabled(env = process.env) {
  return normalizeLogLevel(env.CCDX_LOG_LEVEL) === "debug";
}

export function debugLogMaxBytes(env = process.env) {
  return parseByteLimit(env.CCDX_LOG_MAX_BYTES, DEFAULT_LOG_MAX_BYTES);
}

function renderLogPayload(args) {
  const stamp = new Date().toISOString();
  const text = redactDiagnosticText(format(...args));
  return `${text.split(/\r?\n/).map((line) => `${stamp} ${line}`).join("\n")}\n`;
}

export function configureLogging({
  env = process.env,
  consoleObj = console,
  home = os.homedir(),
  appendLines = appendRotatingLines,
} = {}) {
  const level = normalizeLogLevel(env.CCDX_LOG_LEVEL);
  const filePath = resolveLogPath(env.CCDX_LOG_PATH, { home });
  if (!filePath) return { level, filePath: null, cleanup: () => {} };
  if (consoleObj === console && globalInstall) {
    return { level, ...globalInstall };
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });

  const methods = ["log", "warn", "error", "debug"];
  const originals = Object.fromEntries(methods.map((method) => [
    method,
    typeof consoleObj[method] === "function" ? consoleObj[method].bind(consoleObj) : () => {},
  ]));
  let writeFailed = false;
  const pending = [];
  let drain = null;
  let pendingBytes = 0;
  let pendingRecords = 0;
  let droppedRecords = 0;
  let writeFailures = 0;
  const stats = () => ({ enabled: true, pending_bytes: pendingBytes, pending_records: pendingRecords,
    dropped_records: droppedRecords, write_failures: writeFailures,
    max_bytes: LOG_QUEUE_MAX_BYTES, max_records: LOG_QUEUE_MAX_RECORDS });

  function scheduleDrain() {
    if (drain) return;
    drain = Promise.resolve().then(async () => {
      while (pending.length) {
        const batch = pending.splice(0);
        try {
          await appendLines(filePath, batch.map(({ payload }) => payload), debugLogMaxBytes(env));
        } catch (error) {
          writeFailures += 1;
          if (!writeFailed) originals.error(`codex-copilot-dx log write failed: ${redactDiagnosticText(error.message)}`);
          writeFailed = true;
        } finally {
          pendingRecords -= batch.length;
          pendingBytes -= batch.reduce((sum, entry) => sum + entry.bytes, 0);
        }
      }
    }).finally(() => { drain = null; if (pending.length) scheduleDrain(); });
  }

  function append(args) {
    try {
      const payload = renderLogPayload(args);
      const bytes = Buffer.byteLength(payload);
      if (pendingRecords >= LOG_QUEUE_MAX_RECORDS || pendingBytes + bytes > LOG_QUEUE_MAX_BYTES) {
        droppedRecords += 1;
        if (droppedRecords === 1) originals.error("codex-copilot-dx log queue is full; excess file records are dropped, terminal output is unchanged (see ccdx status)");
        return;
      }
      pending.push({ payload, bytes });
      pendingRecords += 1;
      pendingBytes += bytes;
      scheduleDrain();
    } catch (e) {
      if (writeFailed) return;
      writeFailed = true;
      originals.error(`codex-copilot-dx log write failed: ${redactDiagnosticText(e.message)}`);
    }
  }

  for (const method of methods) {
    consoleObj[method] = (...args) => {
      originals[method](...args);
      append(args);
    };
  }

  const flush = async ({ timeoutMs = 1500 } = {}) => {
    let timer;
    const completed = await Promise.race([
      (async () => { while (drain) await drain; return true; })(),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    clearTimeout(timer);
    if (!completed) originals.error(`codex-copilot-dx log flush timed out after ${timeoutMs}ms`);
  };
  const cleanup = () => {
    for (const method of methods) consoleObj[method] = originals[method];
    if (consoleObj === console && globalInstall?.cleanup === cleanup) globalInstall = null;
    return flush();
  };

  if (consoleObj === console) globalInstall = { filePath, cleanup, flush, stats };
  return { level, filePath, cleanup, flush, stats };
}

export function debugLog(message, env = process.env) {
  if (isDebugLoggingEnabled(env)) console.log(status("debug", message));
}
