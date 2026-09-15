import {
  TERMINAL_ANIMATION_THEMES,
  TERMINAL_ANIMATION_TRACK_WIDTH,
  getTerminalAnimationFrameDelay,
  renderTerminalAnimationFrame,
} from "./terminal-animation.mjs";

const ESC = "\u001b";
const TICK_MS = 32;

export function startTerminalAnimationGallery({
  output,
  env = process.env,
  prefixWidth,
  rowsBelow = 0,
  getInputRows = () => 0,
  timers = { setTimeout, clearTimeout },
  now = () => performance.now(),
} = {}) {
  const columns = Number(output?.columns);
  const rows = Number(output?.rows);
  const disabled = /^(0|false|no|off)$/i.test(String(env.CCDX_TERMINAL_ANIMATION || "").trim());
  const ci = String(env.CI || "").trim();
  if (output?.isTTY !== true || disabled || (ci && !/^(0|false|no|off)$/i.test(ci))
    || String(env.TERM || "").toLowerCase() === "dumb" || !Number.isFinite(columns) || !Number.isFinite(rows)
    || columns <= prefixWidth + TERMINAL_ANIMATION_TRACK_WIDTH + 2
    || rows < TERMINAL_ANIMATION_THEMES.length + rowsBelow + 2) {
    return { enabled: false, stop() {} };
  }

  const timelines = TERMINAL_ANIMATION_THEMES.map((theme) => {
    let duration = 0;
    const frames = Array.from({ length: theme.frameCount }, (_, offset) => {
      const frame = theme.startFrame + offset;
      duration += getTerminalAnimationFrameDelay(theme.id, frame);
      return { frame, until: duration };
    });
    return { theme, frames, duration: duration + theme.loopPauseMs, lastFrame: theme.startFrame };
  });
  const startedAt = now();
  let timer;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) timers.clearTimeout(timer);
    output.off?.("resize", stop);
    output.off?.("error", stop);
    output.off?.("close", stop);
  };
  const draw = () => {
    timer = undefined;
    if (stopped) return;
    try {
      const inputRows = getInputRows();
      // Once input scrolls the menu out of view its old row anchors are no longer safe.
      if (!Number.isSafeInteger(inputRows) || inputRows < 0
        || Number(output.rows) < timelines.length + rowsBelow + inputRows + 2) {
        stop();
        return;
      }
      const elapsed = now() - startedAt;
      let update = "";
      timelines.forEach((timeline, index) => {
        const position = elapsed % timeline.duration;
        const frame = timeline.frames.find(({ until }) => position < until)?.frame ?? null;
        if (frame === timeline.lastFrame) return;
        timeline.lastFrame = frame;
        const track = frame === null ? `[${" ".repeat(TERMINAL_ANIMATION_TRACK_WIDTH)}]`
          : renderTerminalAnimationFrame(timeline.theme.id, frame);
        const up = timelines.length - index + rowsBelow + inputRows;
        update += `${ESC}7${ESC}[${up}A${ESC}[${prefixWidth + 1}G${track}${ESC}8`;
      });
      if (update && output.write(update) === false) { stop(); return; }
      timer = timers.setTimeout(draw, TICK_MS);
      timer?.unref?.();
    } catch { stop(); }
  };
  output.on?.("resize", stop);
  output.on?.("error", stop);
  output.on?.("close", stop);
  timer = timers.setTimeout(draw, TICK_MS);
  timer?.unref?.();
  return { enabled: true, stop };
}
