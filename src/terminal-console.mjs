import { format, stripVTControlCharacters } from "node:util";
import { terminalCell } from "./terminal-text.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";
import { DEFAULT_TERMINAL_ANIMATION_THEME, TERMINAL_ANIMATION_THEMES, isTerminalAnimationTheme, renderTerminalAnimationFrame,
  getTerminalAnimationCycleLength, getTerminalAnimationFrameDelay } from "./terminal-animation.mjs";
import { displayWidth } from "./cli-table.mjs";

const clear = "\r\x1b[2K";
const flagOff = value => /^(0|false|no|off)$/i.test(String(value || ""));

// A bounded status region, independent of file logging and inference delivery.
export function createTerminalConsole({ output = process.stdout, errorOutput = process.stderr, env = process.env,
  snapshot = () => ({}), preferences = () => ({}), baseUrl = "", verbose = false,
  timers = { setTimeout, clearTimeout }, now = Date.now } = {}) {
  let running = false, timer = null, lines = 0, active = 0, frame = 0, lastRead = 0, data = {};
  let notices = 0, lastNotice = "", lastPrintedNotice = "", lastRender = "";
  let current = { theme: DEFAULT_TERMINAL_ANIMATION_THEME, terminal_animation_enabled: true };
  let frameDelay = 1000;
  const tty = output.isTTY === true && errorOutput.isTTY === true && (!env.CI || flagOff(env.CI)) && env.TERM !== "dumb";
  const supported = () => tty && (Number(output.columns) || 80) >= 40;
  const resized = () => { if (lines) output.write("\n");lines = 0;lastRender = "";frame = 0; };
  output.on?.("resize", resized);
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const clip = (value, width) => {
    let text = "";
    for (const { segment } of segmenter.segment(terminalCell(value, { fallback: "" }))) {
      if (displayWidth(text + segment) > width) break;text += segment;
    }
    return text;
  };
  const compact = value => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value) || 0);
  function render() {
    if (!running || !supported() || verbose) { frameDelay = 1000;return; }
    const width = Math.max(1, Math.min(160, Number(output.columns) || 80) - 1);
    const usage = data.runtime_usage || {}, routes = data.requests?.by_route || {};
    const outcomes = [data.stream_performance?.by_route?.responses, data.stream_performance?.by_route?.responses_compact, data.providers?.m365?.claude?.requests?.performance?.by_route?.messages]
      .map(route => route?.terminal_outcomes?.totals || {});
    const sum = key => outcomes.reduce((total, item) => total + (Number(item[key]) || 0), 0);
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
    const requests = ["responses", "responses_compact", "messages"].reduce((total, key) => total + (routes[key]?.total || 0), 0);
    const body = [
      `CCDX ${lastNotice ? "ATTENTION" : "READY"} / uptime ${Math.floor((data.uptime_ms || 0) / 60000)}m / ${baseUrl}`,
      `This run · usage records ${usage.records || 0} · input ${compact(usage.input_tokens)} · cache read ${compact(usage.cached_input_tokens)} · output ${compact(usage.output_tokens)}${usage.partial_records ? " ~" : ""}`,
      `Inference · ${requests} HTTP calls · active ${active} · done ${sum("completed")} · incomplete ${sum("incomplete")} · failed ${sum("failed")} · cancelled ${sum("cancelled")}`,
    ].map(line => clip(line, width));
    const notice = lastNotice ? `${notices} notices / ${lastNotice}` : active ? "Working" : "Idle / details in WebUI";
    body.push(width >= 24 ? `${motion} ${clip(notice, Math.max(0, width - displayWidth(stripVTControlCharacters(motion)) - 1))}` : clip(`${motion} ${notice}`, width));
    const rendered = body.join("\n");
    if (rendered === lastRender) return;
    lastRender = rendered;
    output.write(`${lines ? `\x1b[${lines - 1}A` : ""}${body.map(line => clear + line).join("\n")}\r`);
    lines = 4;
  }
  function tick() {
    if (!running) return;
    if (now() - lastRead >= 1000 || !lastRead) {
      try { data = snapshot();current = { ...current, ...preferences() };if (!isTerminalAnimationTheme(current.theme)) current.theme = DEFAULT_TERMINAL_ANIMATION_THEME; } catch {}
      lastRead = now();
    }
    render();
    timer = timers.setTimeout(tick, frameDelay);timer?.unref?.();
  }
  return {
    get enabled() { return supported() && !verbose; },
    start() { if (running) return;running = true;tick(); },
    beginRequest() { active++;let done = false;return () => { if (!done) { done = true;active = Math.max(0, active - 1); } }; },
    log(method, args) {
      const message = redactDiagnosticText(format(...args));
      if (verbose) { (method === "error" || method === "warn" ? errorOutput : output).write(`${message}\n`);return; }
      if (method !== "error" && method !== "warn" && !/^\[(WARN|ERR)\]/.test(message.trim())) return;
      notices++;lastNotice = message.replace(/\s+/g, " ").slice(0, 240);
      if (!supported() && lastNotice !== lastPrintedNotice) { errorOutput.write(`${lastNotice}\n`);lastPrintedNotice = lastNotice; }
    },
    snapshot() { return { notices, last_notice: lastNotice || null, mode: verbose ? "verbose" : supported() ? "status" : "plain" }; },
    apply(value) { if (value.theme && value.theme !== current.theme) frame = 0;current = { ...current, ...value };lastRead = 0; },
    cleanup() { running = false;if (timer) timers.clearTimeout(timer);timer = null;if (lines) output.write("\n");lines = 0;output.off?.("resize", resized); },
  };
}
