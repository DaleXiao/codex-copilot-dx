import test from "node:test";
import assert from "node:assert/strict";
import { createTerminalConsole } from "../src/terminal-console.mjs";
import { configureLogging } from "../src/log.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function fixture(tty = true) {
  const writes = [], errors = [], timers = new Map();let time = 1000;
  const terminal = createTerminalConsole({ env: {}, output: { isTTY: tty, columns: 100, write: value => writes.push(value) },
    errorOutput: { isTTY: tty, write: value => errors.push(value) }, baseUrl: "http://127.0.0.1:2026",
    now: () => time, snapshot: () => ({ runtime_usage: { records: 1, input_tokens: 20, output_tokens: 2 }, uptime_ms: 1000 }),
    timers: { setTimeout(fn, ms) { timers.set(fn, ms);return fn; }, clearTimeout(fn) { timers.delete(fn); } } });
  return { terminal, writes, errors, tick() { const [fn, ms] = [...timers][0];timers.delete(fn);time += ms;fn(); } };
}
test("terminal uses a fixed region, suppresses request detail and restores output on cleanup", () => {
  const f = fixture();f.terminal.start();const finish = f.terminal.beginRequest();f.tick();
  for (let index = 0; index < 100; index++) f.terminal.log("log", ["responses model=private-request-detail"]);
  f.terminal.log("warn", ["Provider temporarily unavailable"]);f.tick();
  assert.match(f.writes.join(""), /\x1b\[3A/);assert.doesNotMatch(f.writes.join(""), /private-request-detail/);
  assert.equal(f.terminal.snapshot().notices, 1);finish();finish();f.terminal.cleanup();assert.equal(f.writes.at(-1), "\n");
});
test("plain output has no cursor controls and coalesces repeated notices", () => {
  const f = fixture(false);f.terminal.start();f.terminal.log("log", ["request"]);
  f.terminal.log("error", ["unavailable"]);f.terminal.log("error", ["unavailable"]);
  assert.equal(f.writes.length, 0);assert.deepEqual(f.errors, ["unavailable\n"]);f.terminal.cleanup();
});
test("quiet terminal filtering retains redacted optional file diagnostics", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-console-log-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const output = [], consoleObj = { log: value => output.push(value), error() {} };
  const logging = configureLogging({ env: { CCDX_LOG_PATH: path.join(home, "debug.log") }, consoleObj });
  logging.setTerminalSink(() => {});consoleObj.log('request detail Bearer synthetic-secret');await logging.cleanup();
  assert.equal(output.length, 0);const file = fs.readFileSync(path.join(home, "debug.log"), "utf8");assert.match(file, /request detail/);assert.doesNotMatch(file, /synthetic-secret/);
});

test("very narrow TTY uses plain mode, while supported themes retain their colors and timing", () => {
  const writes = [], timers = [];
  const tiny = createTerminalConsole({ env: {}, output: { isTTY: true, columns: 10, write: value => writes.push(value) }, errorOutput: { isTTY: true, write() {} },
    timers: { setTimeout() { return 1; }, clearTimeout() {} } });
  tiny.start();assert.equal(tiny.enabled, false);assert.equal(tiny.snapshot().mode, "plain");assert.equal(writes.length, 0);tiny.cleanup();
  const colored = createTerminalConsole({ env: {}, output: { isTTY: true, columns: 80, write: value => writes.push(value) }, errorOutput: { isTTY: true, write() {} },
    timers: { setTimeout(fn, ms) { timers.push(ms);return 1; }, clearTimeout() {} } });
  colored.beginRequest();colored.start();assert.match(writes.join(""), /\x1b\[(?:97|38;5;)/);
  assert.ok(timers[0] > 0);colored.cleanup();
});
