import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { format } from "node:util";
import { status } from "./status.mjs";

let globalInstall = null;

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

function renderLogPayload(args) {
  const stamp = new Date().toISOString();
  const text = format(...args);
  return `${text.split(/\r?\n/).map((line) => `${stamp} ${line}`).join("\n")}\n`;
}

export function configureLogging({
  env = process.env,
  consoleObj = console,
  home = os.homedir(),
} = {}) {
  const level = normalizeLogLevel(env.CCDX_LOG_LEVEL);
  const filePath = resolveLogPath(env.CCDX_LOG_PATH, { home });
  if (!filePath) return { level, filePath: null, cleanup: () => {} };
  if (consoleObj === console && globalInstall) {
    return { level, filePath: globalInstall.filePath, cleanup: globalInstall.cleanup };
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });

  const methods = ["log", "warn", "error", "debug"];
  const originals = Object.fromEntries(methods.map((method) => [
    method,
    typeof consoleObj[method] === "function" ? consoleObj[method].bind(consoleObj) : () => {},
  ]));
  let writeFailed = false;

  function append(args) {
    try {
      fs.appendFileSync(filePath, renderLogPayload(args), { encoding: "utf8", mode: 0o600 });
    } catch (e) {
      if (writeFailed) return;
      writeFailed = true;
      originals.error(`codex-copilot-dx log write failed: ${e.message}`);
    }
  }

  for (const method of methods) {
    consoleObj[method] = (...args) => {
      originals[method](...args);
      append(args);
    };
  }

  const cleanup = () => {
    for (const method of methods) consoleObj[method] = originals[method];
    if (consoleObj === console && globalInstall?.cleanup === cleanup) globalInstall = null;
  };

  if (consoleObj === console) globalInstall = { filePath, cleanup };
  return { level, filePath, cleanup };
}

export function debugLog(message, env = process.env) {
  if (isDebugLoggingEnabled(env)) console.log(status("debug", message));
}
