// Test-only xterm replay. No terminal package is shipped with CCDX.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { createTerminalConsole } from "../src/terminal-console.mjs";

const args = process.argv.slice(2), options = new Map();
for (let index = 0; index < args.length; index += 2) options.set(args[index], args[index + 1]);
assert.ok(path.isAbsolute(options.get("--xterm") || ""), "Supply --xterm /absolute/path/to/@xterm/headless/lib-headless/xterm-headless.js");
const imported = await import(pathToFileURL(options.get("--xterm")));
const { Terminal } = imported.default || imported;
const results = [];
for (const columns of [40, 80, 120]) for (const color of [false, true]) {
  const screen = new Terminal({ cols: columns, rows: 24, allowProposedApi: true });
  const output = new EventEmitter(), pending = [], timers = new Map();let time = 1000, bytes = 0;
  Object.assign(output, { isTTY: true, columns, rows: 24, write(value) { bytes += Buffer.byteLength(value);pending.push(value); } });
  const data = { uptime_ms: 240000, profiles: { codex: { models: { source: "cache", models: 41 } } },
    providers: { m365: { enabled: true, state: "ready", models: { source: "live", total: 15 },
      claude: { gateway: "running", clients: { code: "configured", app: "configured" } } } },
    runtime_usage: { records: 5, input_tokens: 1700000, cached_input_tokens: 1100000, output_tokens: 5600, partial_records: 0 },
    requests: { by_route: { responses: { total: 7, active: 2 }, image_mcp: { total: 9, active: 5 } } },
    stream_performance: { by_route: { responses: { terminal_outcomes: { totals: { completed: 5 } } } } } };
  const terminal = createTerminalConsole({ output, errorOutput: output, env: color ? { CI: "0" } : { NO_COLOR: "" },
    baseUrl: "http://127.0.0.1:2026", now: () => time, snapshot: () => data,
    timers: { setTimeout(fn, ms) { timers.set(fn, ms);return fn; }, clearTimeout(fn) { timers.delete(fn); } } });
  const flush = async () => { while (pending.length) await new Promise(resolve => screen.write(pending.shift(), resolve)); };
  const lines = () => {
    const buffer = screen.buffer.active, end = buffer.baseY + buffer.cursorY;
    return Array.from({ length: 15 }, (_, index) => buffer.getLine(end - 14 + index)?.translateToString(true) || "");
  };
  const step = async () => {
    const [fn, ms] = [...timers][0];timers.delete(fn);time += ms;fn();await flush();
  };
  const finish = terminal.beginRequest(), finishSecond = terminal.beginRequest();
  for (let index = 0; index < 11; index++) terminal.log("warn", ["Synthetic notice"]);
  terminal.start();await flush();
  const initialScroll = screen.buffer.active.baseY;
  for (let frame = 0; frame < 200; frame++) await step();
  assert.equal(screen.buffer.active.baseY, initialScroll, "Animation/request updates must not scroll the region");
  const visible = lines();
  assert.match(visible[3], /^┌.*┬.*┐$/);assert.match(visible[12], /^└.*┴.*┘$/);
  assert.match(visible[7], /Input total\s+1\.7M.*Active\s+2/);
  assert.match(visible[8], /Cache read\s+1\.1M.*Completed\s+5/);
  assert.match(visible[13], /^11 notices/);assert.match(visible[14], /^\[.*\] Working$/);
  if (columns === 80 && !color && options.get("--output")) await fs.writeFile(options.get("--output"), visible.join("\n") + "\n");
  finish();finishSecond();data.runtime_usage.output_tokens = 6000;
  data.requests.by_route.responses.active = 0;
  time += 1000;await step();assert.match(lines()[9], /Output\s+6K/);assert.equal(lines()[14], "○ Idle");
  // Real terminal reflow, then the production resize handler, then new status.
  screen.resize(60, 24);output.columns = 60;output.emit("resize");await step();
  assert.match(lines()[3], /^┌.*┬.*┐$/);assert.equal(lines()[3].length, 59);assert.equal(lines()[14], "○ Idle");
  screen.resize(30, 10);Object.assign(output, { columns: 30, rows: 10 });output.emit("resize");await flush();
  const before = bytes;await step();assert.equal(bytes, before);assert.equal(terminal.snapshot().mode, "plain");
  screen.resize(80, 24);Object.assign(output, { columns: 80, rows: 24 });output.emit("resize");await step();
  assert.match(lines()[3], /^┌.*┬.*┐$/);assert.equal(lines()[14], "○ Idle");
  terminal.cleanup();await flush();screen.dispose();
  results.push({ columns, color, frames: 200, passed: true, written_bytes: bytes });
}
console.log(JSON.stringify({ emulator: "xterm", results }, null, 2));
