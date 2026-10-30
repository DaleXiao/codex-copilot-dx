// Test-only xterm replay. No terminal package is shipped with CCDX.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { createTerminalConsole } from "../src/terminal-console.mjs";
import { TERMINAL_COLOR_THEMES } from "../src/terminal-colors.mjs";

const args = process.argv.slice(2), options = new Map();
for (let index = 0; index < args.length; index += 2) options.set(args[index], args[index + 1]);
assert.ok(path.isAbsolute(options.get("--xterm") || ""), "Supply --xterm /absolute/path/to/@xterm/headless/lib-headless/xterm-headless.js");
const imported = await import(pathToFileURL(options.get("--xterm")));
const { Terminal } = imported.default || imported;
const results = [];
for (const columns of [40, 80, 120]) for (const rows of [16, 24]) for (const color of [false, true]) for (const palette of TERMINAL_COLOR_THEMES) {
  const screen = new Terminal({ cols: columns, rows, allowProposedApi: true });
  const output = new EventEmitter(), pending = [], timers = new Map();let time = 1000, bytes = 0;
  Object.assign(output, { isTTY: true, columns, rows, write(value) { bytes += Buffer.byteLength(value);pending.push(value); } });
  const data = { uptime_ms: 240000, profiles: { codex: { models: { source: "cache", models: 41 } } },
    providers: { m365: { enabled: true, state: "ready", models: { source: "live", total: 15 },
      claude: { gateway: "running", clients: { code: "configured", app: "configured" } } } },
    runtime_usage: { records: 5, input_tokens: 1700000, cached_input_tokens: 1100000, output_tokens: 5600, partial_records: 0, cache_hit_rate: 11 / 17, cache_hit_rate_partial: false },
    requests: { by_route: { responses: { total: 7, active: 2 }, image_mcp: { total: 9, active: 5 } } },
    stream_performance: { by_route: { responses: { terminal_outcomes: { totals: { completed: 5 } } } } } };
  const terminal = createTerminalConsole({ output, errorOutput: output, env: color ? { CI: "0" } : { NO_COLOR: "" },
    preferences: () => ({ color_theme: palette }), baseUrl: "http://127.0.0.1:2026", now: () => time, snapshot: () => data,
    timers: { setTimeout(fn, ms) { timers.set(fn, ms);return fn; }, clearTimeout(fn) { timers.delete(fn); } } });
  const flush = async () => { while (pending.length) await new Promise(resolve => screen.write(pending.shift(), resolve)); };
  const lines = () => {
    const buffer = screen.buffer.active, end = buffer.baseY + buffer.cursorY;
    let start = end;
    while (start > Math.max(0, end - 23) && !/^(?:Running|Web UI:|Previous data|Status unavailable)/.test(buffer.getLine(start)?.translateToString(true) || "")) start--;
    return Array.from({ length: end - start + 1 }, (_, index) => buffer.getLine(start + index)?.translateToString(true) || "");
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
  const tableStart = visible.findIndex(line => line.startsWith("┌"));
  const offset = visible[tableStart + 1].includes("Usage / this run") ? 3 : 1;
  assert.ok(tableStart > 0);assert.match(visible[tableStart + offset + 6], /^└.*┴.*┘$/);
  if (offset === 1) assert.match(visible.join("\n"), /Apps:.*configured/);
  else { assert.match(visible.join("\n"), /Claude App\s+Configured/);assert.match(visible.join("\n"), /Claude Code\s+Configured/); }
  assert.match(visible.join("\n"), /Enabled sources: 2/);
  assert.match(visible[tableStart + offset + 1], /Input\s+1\.7M.*Active\s+2/);
  assert.match(visible[tableStart + offset + 2], /Reused(?: input)?\s+1\.1M.*Completed\s+5/);
  assert.match(visible[tableStart + offset + 5], /Cache hit\s+64\.7%.*Cancelled\s+0/);
  assert.match(visible.at(-2), /^11 notices/);assert.match(visible.at(-1), /^\[.*\] Active$/);
  if (columns === 80 && rows === 24 && !color && options.get("--output")) await fs.writeFile(options.get("--output"), visible.join("\n") + "\n");
  finish();finishSecond();data.runtime_usage.output_tokens = 6000;
  data.requests.by_route.responses.active = 0;
  time += 1000;await step();assert.match(lines().join("\n"), /Output\s+6K/);assert.equal(lines().at(-1), "○ Idle");
  // Real terminal reflow, then the production resize handler, then new status.
  screen.resize(60, 24);output.columns = 60;output.rows = 24;output.emit("resize");await step();
  assert.ok(lines().some(line => /^┌.*┬.*┐$/.test(line) && line.length === 59));assert.equal(lines().at(-1), "○ Idle");
  screen.resize(30, 10);Object.assign(output, { columns: 30, rows: 10 });output.emit("resize");await flush();
  const before = bytes;await step();assert.equal(bytes, before);assert.equal(terminal.snapshot().mode, "plain");
  screen.resize(80, 24);Object.assign(output, { columns: 80, rows: 24 });output.emit("resize");await step();
  assert.ok(lines().some(line => /^┌.*┬.*┐$/.test(line)));assert.equal(lines().at(-1), "○ Idle");
  terminal.cleanup();await flush();screen.dispose();
  results.push({ columns, rows, color, palette, frames: 200, passed: true, written_bytes: bytes });
}
console.log(JSON.stringify({ emulator: "xterm", results }, null, 2));
