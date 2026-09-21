import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configureLogging,
  debugLog,
  normalizeLogLevel,
  resolveLogPath,
} from "../src/log.mjs";

test("normalizeLogLevel: only debug enables debug logging", () => {
  assert.equal(normalizeLogLevel(undefined), "info");
  assert.equal(normalizeLogLevel("info"), "info");
  assert.equal(normalizeLogLevel("DEBUG"), "debug");
  assert.equal(normalizeLogLevel("trace"), "info");
});

test("resolveLogPath: supports explicit paths and the default shortcut", () => {
  const home = path.join(os.tmpdir(), "ccdx-log-home");
  assert.equal(resolveLogPath("", { home }), null);
  assert.equal(resolveLogPath("1", { home }), path.join(home, ".local", "share", "codex-copilot-dx", "debug.log"));
  assert.equal(resolveLogPath("true", { home }), path.join(home, ".local", "share", "codex-copilot-dx", "debug.log"));
  assert.equal(resolveLogPath("~/dx.log", { home }), path.join(home, "dx.log"));
  assert.equal(resolveLogPath("/tmp/dx.log", { home }), "/tmp/dx.log");
});

test("configureLogging: mirrors console output to CCDX_LOG_PATH", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-log-"));
  const logPath = path.join(dir, "debug.log");
  const terminalLines = [];
  const fakeConsole = {
    log: (...args) => terminalLines.push(["log", ...args]),
    warn: (...args) => terminalLines.push(["warn", ...args]),
    error: (...args) => terminalLines.push(["error", ...args]),
    debug: (...args) => terminalLines.push(["debug", ...args]),
  };

  const configured = configureLogging({
    env: { CCDX_LOG_PATH: logPath, CCDX_LOG_LEVEL: "debug" },
    consoleObj: fakeConsole,
  });
  try {
    fakeConsole.log("hello", { ok: true });
    fakeConsole.warn("line one\nline two");
  } finally {
    await configured.cleanup();
  }

  assert.equal(configured.filePath, logPath);
  assert.equal(configured.level, "debug");
  assert.equal(terminalLines.length, 2);
  const text = fs.readFileSync(logPath, "utf8");
  assert.match(text, /hello/);
  assert.match(text, /ok: true/);
  assert.match(text, /line one/);
  assert.match(text, /line two/);
});

test("debugLog: writes only when CCDX_LOG_LEVEL is debug", () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    debugLog("hidden", { CCDX_LOG_LEVEL: "info" });
    debugLog("shown", { CCDX_LOG_LEVEL: "debug" });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(lines, ["[DEBUG] shown"]);
});

test("configureLogging: rotates an oversized debug log before appending", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-log-rotate-"));
  const logPath = path.join(dir, "debug.log");
  fs.writeFileSync(logPath, "old-log-content".repeat(10));
  const fakeConsole = { log() {}, warn() {}, error() {}, debug() {} };
  const configured = configureLogging({
    env: { CCDX_LOG_PATH: logPath, CCDX_LOG_MAX_BYTES: "170" },
    consoleObj: fakeConsole,
  });
  try {
    fakeConsole.log("new content");
  } finally {
    await configured.cleanup();
  }

  assert.match(fs.readFileSync(`${logPath}.1`, "utf8"), /old-log-content/);
  assert.match(fs.readFileSync(logPath, "utf8"), /new content/);
});

test("debug logging batches asynchronously, bounds pending bytes, and reports overload without blocking the console", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-log-bound-"));
  const gate = Promise.withResolvers();
  let writes = 0;
  let terminal = 0;
  const errors = [];
  const fakeConsole = { log() { terminal += 1; }, error: message => errors.push(message) };
  const configured = configureLogging({
    env: { CCDX_LOG_PATH: path.join(dir, "debug.log") },
    consoleObj: fakeConsole,
    appendLines: async () => { writes += 1; await gate.promise; },
  });
  try {
    // Non-token-shaped data exercises the byte budget after redaction.
    for (let index = 0; index < 5000; index += 1) fakeConsole.log('line with spaces '.repeat(100));
    assert.equal(writes, 0, "console calls must not synchronously write files");
    assert.equal(terminal, 5000);
    assert.ok(configured.stats().pending_bytes <= configured.stats().max_bytes);
    assert.ok(configured.stats().pending_records <= configured.stats().max_records);
    assert.ok(configured.stats().dropped_records > 0);
    await configured.flush({ timeoutMs: 5 });
    assert.equal(errors.length, 2, "one overload warning and one flush deadline warning");
    gate.resolve();
    await configured.cleanup();
    assert.equal(configured.stats().pending_records, 0);
    assert.equal(writes, 1, "adjacent lines should be batched");
  } finally {
    gate.resolve();
    await configured.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("debug file diagnostics redact credentials while retaining ordinary error codes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-log-redact-"));
  const fakeConsole = { log() {} };
  const configured = configureLogging({ env: { CCDX_LOG_PATH: path.join(dir, "debug.log") }, consoleObj: fakeConsole });
  try {
    fakeConsole.log('invalid_request Bearer fixture-secret api_key="fixture-key" prompt="private fixture"');
    await configured.cleanup();
    const text = fs.readFileSync(configured.filePath, "utf8");
    assert.match(text, /invalid_request/);
    assert.doesNotMatch(text, /fixture-secret|fixture-key|private fixture/);
  } finally { await configured.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});
