import { format, stripVTControlCharacters } from "node:util";
import { terminalCell } from "./terminal-text.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";
import { DEFAULT_TERMINAL_ANIMATION_THEME, TERMINAL_ANIMATION_THEMES, isTerminalAnimationTheme, renderTerminalAnimationFrame,
  getTerminalAnimationCycleLength, getTerminalAnimationFrameDelay } from "./terminal-animation.mjs";
import { displayWidth } from "./cli-table.mjs";
import { providerStartupSummary } from "./startup-ui.mjs";
import { colorTerminalText, colorTerminalMotion } from "./terminal-colors.mjs";

const clear = "\r\x1b[2K";
const flagOff = value => /^(0|false|no|off)$/i.test(String(value || ""));

// A bounded status region, independent of file logging and inference delivery.
export function createTerminalConsole({ output = process.stdout, errorOutput = process.stderr, env = process.env,
  snapshot = () => ({}), preferences = () => ({}), baseUrl = "", verbose = false,
  timers = { setTimeout, clearTimeout }, now = Date.now } = {}) {
  let running = false, timer = null, lines = 0, active = 0, frame = 0, lastRead = 0, data = {};
  let notices = 0, lastNotice = "", lastPrintedNotice = "", previous = [];
  let content = [], dirty = true, readFailed = false, updatedAt = null, fits = true;
  let current = { theme: DEFAULT_TERMINAL_ANIMATION_THEME, color_theme: "green", terminal_animation_enabled: true };
  let frameDelay = 1000;
  const tty = output.isTTY === true && errorOutput.isTTY === true && (!env.CI || flagOff(env.CI)) && env.TERM !== "dumb";
  const supported = () => tty && (Number(output.columns) || 80) >= 40 && (Number(output.rows) || 24) >= 16;
  const resized = () => { if (lines) output.write("\n");lines = 0;previous = [];frame = 0;dirty = true; };
  output.on?.("resize", resized);
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const clip = (value, width) => {
    let text = "";
    for (const { segment } of segmenter.segment(terminalCell(value, { fallback: "" }))) {
      if (displayWidth(text + segment) > width) break;text += segment;
    }
    return text;
  };
  const numbers = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  const compact = value => numbers.format(Number(value) || 0);
  const wrap = (value, width) => {
    const rows = [];let row = "";
    for (const word of terminalCell(value, { fallback: "" }).split(/\s+/)) {
      if (row && displayWidth(`${row} ${word}`) > width) { rows.push(row);row = ""; }
      row += `${row ? " " : ""}${word}`;
    }
    if (row) rows.push(clip(row, width));return rows;
  };
  function table(width, usage, requests, inferenceActive, sum, compactTitle = false) {
    const left = Math.floor((width - 3) / 2), right = width - 3 - left;
    const cell = (label, value, size) => {
      const number = value === undefined ? "" : updatedAt === null && readFailed ? "—" : typeof value === "string" ? value : compact(value), inner = size - 2;
      const text = clip(label, Math.max(0, inner - displayWidth(number) - (number ? 1 : 0)));
      return ` ${text}${" ".repeat(Math.max(0, inner - displayWidth(text) - displayWidth(number)))}${number} `;
    };
    const row = (a, b) => `│${a}│${b}│`;
    const rule = (a, b, c) => `${a}${"─".repeat(left)}${b}${"─".repeat(right)}${c}`;
    const rate = usage.cache_hit_rate;
    const cacheHit = Number.isFinite(rate) && rate >= 0 && rate <= 1 ? `${usage.cache_hit_rate_partial ? "~" : ""}${(rate * 100).toFixed(1)}%` : "—";
    const usageRows = [[left < 23 ? "Records" : "Usage records", usage.records || 0], ["Input", usage.input_tokens], [left < 23 ? "Reused" : "Reused input", usage.cached_input_tokens],
      ["Output", usage.output_tokens], ["Partial usage", usage.partial_records || 0], ["Cache hit", cacheHit]];
    const requestRows = [["Requests", requests], ["Active", inferenceActive], ["Completed", sum("completed")], ["Incomplete", sum("incomplete")], ["Failed", sum("failed")], ["Cancelled", sum("cancelled")]];
    const title = compactTitle ? [`┌─ Usage ${"─".repeat(left - 8)}┬─ Inference ${"─".repeat(right - 12)}┐`]
      : [rule("┌", "┬", "┐"), row(cell("Usage / this run", undefined, left), cell("Inference", undefined, right)), rule("├", "┼", "┤")];
    return [...title,
      ...usageRows.map(([label, value], index) => row(cell(label, value ?? (label ? 0 : undefined), left), cell(...requestRows[index], right))), rule("└", "┴", "┘")];
  }
  function render() {
    if (!running || !supported() || verbose) { frameDelay = 1000;return; }
    const width = Math.max(1, Math.min(160, Number(output.columns) || 80) - 1);
    let motion = active ? "●" : "○";
    frameDelay = 1000;
    if (active && current.terminal_animation_enabled && !flagOff(env.CCDX_TERMINAL_ANIMATION) && width >= 24) {
      frame %= getTerminalAnimationCycleLength(current.theme);
      const metadata = TERMINAL_ANIMATION_THEMES.find(theme => theme.id === current.theme), index = metadata.startFrame + frame;
      motion = renderTerminalAnimationFrame(current.theme, index);
      motion = colorTerminalMotion(motion, current.color_theme, { output, env });
      if (Object.hasOwn(env, "NO_COLOR")) motion = stripVTControlCharacters(motion);
      frame = (frame + 1) % getTerminalAnimationCycleLength(current.theme);
      frameDelay = getTerminalAnimationFrameDelay(current.theme, index) + (frame === 0 ? metadata.loopPauseMs : 0);
    }
    if (dirty) {
      const usage = data.runtime_usage || {}, routes = data.requests?.by_route || {};
      const outcomes = [data.stream_performance?.by_route?.responses, data.stream_performance?.by_route?.responses_compact, data.providers?.m365?.claude?.requests?.performance?.by_route?.messages]
        .map(route => route?.terminal_outcomes?.totals || {});
      const sum = key => outcomes.reduce((total, item) => total + (Number(item[key]) || 0), 0);
      const requests = ["responses", "responses_compact", "messages"].reduce((total, key) => total + (routes[key]?.total || 0), 0);
      const inferenceActive = ["responses", "responses_compact", "messages"].reduce((total, key) => total + (routes[key]?.active || 0), 0);
      const providers = providerStartupSummary(data);
      const heading = readFailed ? updatedAt === null ? "CCDX / No data received" : `CCDX / ${width < 80 ? "Previous data" : "Showing previous data / updated"} / ${new Date(updatedAt).toLocaleTimeString("en-GB")}`
        : `CCDX RUNNING / uptime ${Math.floor((data.uptime_ms || 0) / 60000)}m / ${baseUrl}`;
      content = [clip(heading, width)];
      for (const group of [[`Sources / ${providers.catalogs}`, providers.sourceLines], [`Claude / ${providers.claude}`, providers.claudeLines]]) {
        content.push(...(displayWidth(group[0]) <= width ? [group[0]] : (group[1] || [group[0]]).flatMap(line => wrap(line, width))));
      }
      content.push(...table(width, usage, requests, inferenceActive, sum));
      content.push(clip(`${notices} notices${lastNotice ? ` · latest: ${lastNotice}` : " / details in WebUI"}`, width));
      if (content.length + 1 >= (Number(output.rows) || 24)) {
        const summaries = [...(providers.compactSources || ["Sources: not checked"]), ...(providers.compactClaude || ["Claude: not checked"])];
        content = [clip(heading, width), ...summaries.flatMap(line => wrap(line, width)), ...table(width, usage, requests, inferenceActive, sum, true), content.at(-1)];
      }
      dirty = false;
    }
    // Apply color after clipping/layout so escape sequences never consume columns.
    const body = [...content.map(line => ["klein", "pink"].includes(current.color_theme) && /^[┌│├└]/.test(line)
      ? colorTerminalText(line, current.color_theme, { output, env }) : line), `${motion} ${active ? "Working" : "Idle"}`];
    fits = body.length < (Number(output.rows) || 24);
    if (!fits) { frameDelay = 1000;return; }
    // Animation ticks update only the final line; data stays on its 1s cadence.
    let update = "";
    if (lines && lines !== body.length) {
      update = `${lines > 1 ? `\x1b[${lines - 1}A` : ""}\r\x1b[J`;lines = 0;previous = [];
    }
    if (!lines) update += `${body.map(line => clear + line).join("\n")}\r`;
    else for (let index = 0; index < body.length; index++) {
      if (body[index] === previous[index]) continue;
      const offset = body.length - 1 - index;
      update += `${offset ? `\x1b[${offset}A` : ""}${clear}${body[index]}\r${offset ? `\x1b[${offset}B` : ""}`;
    }
    if (update) output.write(update);
    previous = body;lines = body.length;
  }
  function tick() {
    if (!running) return;
    if (now() - lastRead >= 1000 || !lastRead) {
      try {
        const next = snapshot(), nextPreferences = preferences();
        data = next;current = { ...current, ...nextPreferences };readFailed = false;updatedAt = now();
        if (!isTerminalAnimationTheme(current.theme)) current.theme = DEFAULT_TERMINAL_ANIMATION_THEME;
      } catch { readFailed = true; }
      lastRead = now();
      dirty = true;
    }
    render();
    timer = timers.setTimeout(tick, frameDelay);timer?.unref?.();
  }
  return {
    get enabled() { return supported() && fits && !verbose; },
    start() { if (running) return;running = true;tick(); },
    beginRequest() { active++;dirty = true;let done = false;return () => { if (!done) { done = true;active = Math.max(0, active - 1);dirty = true; } }; },
    log(method, args) {
      const message = redactDiagnosticText(format(...args));
      if (verbose) { (method === "error" || method === "warn" ? errorOutput : output).write(`${message}\n`);return; }
      if (method !== "error" && method !== "warn" && !/^\[(WARN|ERR)\]/.test(message.trim())) return;
      notices++;lastNotice = message.replace(/\s+/g, " ").slice(0, 240);dirty = true;
      if ((!supported() || !fits) && lastNotice !== lastPrintedNotice) { errorOutput.write(`${lastNotice}\n`);lastPrintedNotice = lastNotice; }
    },
    snapshot() { return { notices, last_notice: lastNotice || null, mode: verbose ? "verbose" : supported() && fits ? "status" : "plain",
      data_state: readFailed ? updatedAt === null ? "unavailable" : "stale" : updatedAt === null ? "unknown" : "current", updated_at: updatedAt === null ? null : new Date(updatedAt).toISOString() }; },
    apply(value) { if (value.theme && value.theme !== current.theme) frame = 0;current = { ...current, ...value };lastRead = 0; },
    cleanup() { running = false;if (timer) timers.clearTimeout(timer);timer = null;if (lines) output.write("\n");lines = 0;output.off?.("resize", resized); },
  };
}
