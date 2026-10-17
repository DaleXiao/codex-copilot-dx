import { format, stripVTControlCharacters } from "node:util";
import { terminalCell } from "./terminal-text.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";
import { DEFAULT_TERMINAL_ANIMATION_THEME, TERMINAL_ANIMATION_THEMES, isTerminalAnimationTheme, renderTerminalAnimationFrame,
  getTerminalAnimationCycleLength, getTerminalAnimationFrameDelay } from "./terminal-animation.mjs";
import { displayWidth } from "./cli-table.mjs";
import { providerStartupSummary } from "./startup-ui.mjs";

const clear = "\r\x1b[2K";
const flagOff = value => /^(0|false|no|off)$/i.test(String(value || ""));

// A bounded status region, independent of file logging and inference delivery.
export function createTerminalConsole({ output = process.stdout, errorOutput = process.stderr, env = process.env,
  snapshot = () => ({}), preferences = () => ({}), baseUrl = "", verbose = false,
  timers = { setTimeout, clearTimeout }, now = Date.now } = {}) {
  let running = false, timer = null, lines = 0, active = 0, frame = 0, lastRead = 0, data = {};
  let notices = 0, lastNotice = "", lastPrintedNotice = "", previous = [];
  let content = [], dirty = true;
  let current = { theme: DEFAULT_TERMINAL_ANIMATION_THEME, terminal_animation_enabled: true };
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
  function table(width, usage, requests, inferenceActive, sum) {
    const left = Math.floor((width - 3) / 2), right = width - 3 - left;
    const cell = (label, value, size) => {
      const number = value === undefined ? "" : compact(value), inner = size - 2;
      const text = clip(label, Math.max(0, inner - displayWidth(number) - (number ? 1 : 0)));
      return ` ${text}${" ".repeat(Math.max(0, inner - displayWidth(text) - displayWidth(number)))}${number} `;
    };
    const row = (a, b) => `│${a}│${b}│`;
    const rule = (a, b, c) => `${a}${"─".repeat(left)}${b}${"─".repeat(right)}${c}`;
    const usageRows = [["Records", usage.records || 0], ["Input total", usage.input_tokens], ["Cache read", usage.cached_input_tokens],
      ["Output", usage.output_tokens], ["Partial records", usage.partial_records || 0], ["", undefined]];
    const requestRows = [["HTTP calls", requests], ["Active", inferenceActive], ["Completed", sum("completed")], ["Incomplete", sum("incomplete")], ["Failed", sum("failed")], ["Cancelled", sum("cancelled")]];
    return [rule("┌", "┬", "┐"), row(cell("Usage / this run", undefined, left), cell("Inference", undefined, right)), rule("├", "┼", "┤"),
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
      content = [`CCDX RUNNING / uptime ${Math.floor((data.uptime_ms || 0) / 60000)}m / ${baseUrl}`,
        `Providers / ${providers.catalogs}`, `Claude / ${providers.claude}`].map(line => clip(line, width));
      content.push(...table(width, usage, requests, inferenceActive, sum));
      content.push(clip(`${notices} notices${lastNotice ? ` / latest: ${lastNotice}` : " / details in WebUI"}`, width));
      dirty = false;
    }
    const body = [...content, `${motion} ${active ? "Working" : "Idle"}`];
    // Animation ticks update only the final line; data stays on its 1s cadence.
    let update = "";
    if (!lines) update = `${body.map(line => clear + line).join("\n")}\r`;
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
      try { data = snapshot();current = { ...current, ...preferences() };if (!isTerminalAnimationTheme(current.theme)) current.theme = DEFAULT_TERMINAL_ANIMATION_THEME; } catch {}
      lastRead = now();
      dirty = true;
    }
    render();
    timer = timers.setTimeout(tick, frameDelay);timer?.unref?.();
  }
  return {
    get enabled() { return supported() && !verbose; },
    start() { if (running) return;running = true;tick(); },
    beginRequest() { active++;dirty = true;let done = false;return () => { if (!done) { done = true;active = Math.max(0, active - 1);dirty = true; } }; },
    log(method, args) {
      const message = redactDiagnosticText(format(...args));
      if (verbose) { (method === "error" || method === "warn" ? errorOutput : output).write(`${message}\n`);return; }
      if (method !== "error" && method !== "warn" && !/^\[(WARN|ERR)\]/.test(message.trim())) return;
      notices++;lastNotice = message.replace(/\s+/g, " ").slice(0, 240);dirty = true;
      if (!supported() && lastNotice !== lastPrintedNotice) { errorOutput.write(`${lastNotice}\n`);lastPrintedNotice = lastNotice; }
    },
    snapshot() { return { notices, last_notice: lastNotice || null, mode: verbose ? "verbose" : supported() ? "status" : "plain" }; },
    apply(value) { if (value.theme && value.theme !== current.theme) frame = 0;current = { ...current, ...value };lastRead = 0; },
    cleanup() { running = false;if (timer) timers.clearTimeout(timer);timer = null;if (lines) output.write("\n");lines = 0;output.off?.("resize", resized); },
  };
}
