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

test("configureLogging: mirrors console output to CCDX_LOG_PATH", () => {
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
    configured.cleanup();
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
