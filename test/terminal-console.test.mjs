import test from "node:test";
import assert from "node:assert/strict";
import { createTerminalConsole } from "../src/terminal-console.mjs";
import { configureLogging } from "../src/log.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { stripVTControlCharacters } from "node:util";
import { displayWidth } from "../src/cli-table.mjs";
import { EventEmitter } from "node:events";

function fixture(tty = true) {
  const writes = [], errors = [], timers = new Map();let time = 1000;
  const terminal = createTerminalConsole({ env: {}, output: { isTTY: tty, columns: 100, write: value => writes.push(value) },
    errorOutput: { isTTY: tty, write: value => errors.push(value) }, baseUrl: "http://127.0.0.1:2026",
    now: () => time, snapshot: () => ({ runtime_usage: { records: 1, input_tokens: 20, output_tokens: 2 }, uptime_ms: 1000 }),
    timers: { setTimeout(fn, ms) { timers.set(fn, ms);return fn; }, clearTimeout(fn) { timers.delete(fn); } } });
  return { terminal, writes, errors, tick() { const [fn, ms] = [...timers][0];timers.delete(fn);time += ms;fn(); } };
}

test("live cache hit keeps zero, partial and unknown evidence aligned without adding rows", () => {
  for (const columns of [40, 80, 120]) for (const [rate, partial, expected] of [[0, false, "0.0%"], [2 / 3, true, "~66.7%"], [1, false, "100.0%"], [null, false, "—"], [undefined, true, "—"], [1.1, false, "—"]]) {
    const writes = [];
    const terminal = createTerminalConsole({ output: { isTTY: true, columns, rows: 24, write: value => writes.push(value) }, errorOutput: { isTTY: true }, env: {},
      snapshot: () => ({ runtime_usage: { cache_hit_rate: rate, cache_hit_rate_partial: partial } }),
      timers: { setTimeout() { return null; }, clearTimeout() {} } });
    terminal.start();terminal.cleanup();
    const lines = stripVTControlCharacters(writes.join("")).replace(/\r/g, "").split("\n");
    const row = lines.find(line => line.includes("Cache hit"));
    assert.ok(row.includes(expected), row);
    assert.ok(lines.every(line => displayWidth(line) < columns));
    assert.equal(lines.filter(line => line.startsWith("│") && !line.includes("Usage / this run")).length, 6);
  }
});
test("terminal uses a fixed region, suppresses request detail and restores output on cleanup", () => {
  const f = fixture();f.terminal.start();const finish = f.terminal.beginRequest();f.tick();
  for (let index = 0; index < 100; index++) f.terminal.log("log", ["responses model=private-request-detail"]);
  f.terminal.log("warn", ["Provider temporarily unavailable"]);f.tick();
  assert.match(f.writes.join(""), /\x1b\[1A/);assert.doesNotMatch(f.writes.join(""), /private-request-detail/);
  assert.equal(f.terminal.snapshot().notices, 1);finish();finish();f.terminal.cleanup();assert.equal(f.writes.at(-1), "\n");
});

test("status table fits supported widths, separates notices and motion, and redraws only the motion row between snapshots", () => {
  for (const columns of [40, 80, 120]) {
    const writes = [], scheduled = new Map(), output = new EventEmitter();let time = 1000;
    Object.assign(output, { isTTY: true, columns, rows: 24, write: value => writes.push(value) });
    const data = { runtime_usage: { records: 5, input_tokens: 1700000, cached_input_tokens: 1100000, output_tokens: 5600, partial_records: 2 },
      requests: { by_route: { responses: { total: 5, active: 2 }, messages: { total: 2 }, models: { total: 99 }, image_mcp: { total: 9, active: 5 } } },
      stream_performance: { by_route: { responses: { terminal_outcomes: { totals: { completed: 4, cancelled: 1 } } } } },
      providers: { m365: { claude: { requests: { performance: { by_route: { messages: { terminal_outcomes: { totals: { completed: 1, failed: 1 } } } } } } } } } };
    const terminal = createTerminalConsole({ env: { NO_COLOR: "" }, output, errorOutput: { isTTY: true }, snapshot: () => data,
      now: () => time, timers: { setTimeout(fn, ms) { scheduled.set(fn, ms);return fn; }, clearTimeout(fn) { scheduled.delete(fn); } } });
    const finish = terminal.beginRequest();terminal.log("warn", ["Synthetic notice"]);terminal.start();
    const screen = stripVTControlCharacters(writes[0]).replace(/\r/g, "").split("\n");
    assert.ok(screen.length >= 15 && screen.length < 24);
    for (const line of screen) assert.ok(displayWidth(line.trim()) < columns, `${columns}: ${line}`);
    const borders = screen.filter(line => /^[┌├└│]/.test(line));
    assert.equal(borders.length, 10);assert.ok(borders.every(line => displayWidth(line.trim()) === columns - 1));
    assert.match(screen.join("\n"), /Input\s+1\.7M/);assert.match(screen.join("\n"), /Reused(?: input)?\s+1\.1M/);
    assert.match(screen.join("\n"), /Total\s+7/);assert.match(screen.join("\n"), /Completed\s+5/);assert.match(screen.join("\n"), /Failed\s+1/);
    assert.match(screen.join("\n"), /Active\s+2/);
    assert.match(screen.at(-2), /^\r?1 notice/);assert.match(screen.at(-1), /^\r?\[.*\] Active/);
    assert.doesNotMatch(writes[0], /\x1b\[(?:97|38;5;)/);
    const [tick, ms] = [...scheduled][0];scheduled.delete(tick);time += ms;tick();
    assert.doesNotMatch(writes.at(-1), /Usage|│|notices|\n/);
    finish();data.requests.by_route.responses.active = 0;output.columns = 60;output.emit("resize");
    const [next, delay] = [...scheduled][0];scheduled.delete(next);time += Math.max(delay, 1000);next();
    assert.match(stripVTControlCharacters(writes.at(-1)), /○ Idle/);assert.doesNotMatch(writes.at(-1), /\x1b\[\d+A/);
    output.rows = 10;output.emit("resize");assert.equal(terminal.enabled, false);terminal.cleanup();
  }
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
  const colored = createTerminalConsole({ snapshot: () => ({ model_activity: { active: 1 } }), env: {}, output: { isTTY: true, columns: 80, write: value => writes.push(value) }, errorOutput: { isTTY: true, write() {} },
    timers: { setTimeout(fn, ms) { timers.push(ms);return 1; }, clearTimeout() {} } });
  colored.beginRequest();colored.start();assert.match(writes.join(""), /\x1b\[(?:97|38;5;)/);
  assert.ok(timers[0] > 0);colored.cleanup();
});

test("failed status reads retain prior data with an explicit timestamp and recover on the next read", () => {
  const writes = [], scheduled = new Map();let time = 1000, fail = false;
  const terminal = createTerminalConsole({ env: {}, output: { isTTY: true, columns: 40, rows: 24, write: value => writes.push(value) }, errorOutput: { isTTY: true },
    now: () => time, snapshot() { if (fail) throw Error("fixture read failure");return { runtime_usage: { input_tokens: 17 } }; },
    timers: { setTimeout(fn, ms) { scheduled.set(fn, ms);return fn; }, clearTimeout(fn) { scheduled.delete(fn); } } });
  const tick = () => { const [fn, ms] = [...scheduled][0];scheduled.delete(fn);time += Math.max(ms, 1000);fn(); };
  terminal.start();assert.equal(terminal.snapshot().data_state, "current");const updated = terminal.snapshot().updated_at;
  fail = true;tick();assert.equal(terminal.snapshot().data_state, "stale");assert.equal(terminal.snapshot().updated_at, updated);
  assert.match(writes.at(-1), /Previous data.*\d\d:\d\d:\d\d/);assert.doesNotMatch(writes.at(-1), /read failure/);
  fail = false;tick();assert.equal(terminal.snapshot().data_state, "current");terminal.cleanup();
});

test("40 and 80 column terminals retain live usage at the supported 16-row height", () => {
  for (const columns of [40, 80]) {
    const writes = [], scheduled = new Map();let time = 1000;
    const data = { runtime_usage: { records: 2, input_tokens: 500 }, profiles: { codex: { models: { source: "cache", models: 41 } } },
      providers: { m365: { enabled: false, state: "disabled", claude: { clients: { code: "not_configured", app: "not_configured" } } } } };
    const terminal = createTerminalConsole({ env: {}, output: { isTTY: true, columns, rows: 16, write: value => writes.push(value) }, errorOutput: { isTTY: true },
      now: () => time, snapshot: () => data, timers: { setTimeout(fn, ms) { scheduled.set(fn, ms);return fn; }, clearTimeout(fn) { scheduled.delete(fn); } } });
    terminal.start();const screen = stripVTControlCharacters(writes[0]).replace(/\r/g, "").split("\n");
    assert.ok(screen.length < 16);assert.ok(screen.every(line => displayWidth(line) < columns));
    assert.match(screen.join("\n"), /Input\s+500/);assert.match(screen.join("\n"), /Apps: .*not checked/);
    data.runtime_usage.input_tokens = 600;data.providers.m365.claude.clients = { code: "preserved", app: "configuration_unavailable" };
    const [tick] = [...scheduled][0];time += 1000;tick();assert.match(stripVTControlCharacters(writes.at(-1)), /Input\s+600/);
    assert.equal(terminal.snapshot().mode, "status");terminal.cleanup();
  }
});
