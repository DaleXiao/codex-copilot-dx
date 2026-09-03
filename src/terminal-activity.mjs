import {
  DEFAULT_TERMINAL_ANIMATION_THEME,
  TERMINAL_ANIMATION_THEMES,
  TERMINAL_ANIMATION_TRACK_WIDTH,
  getTerminalAnimationCycleLength,
  getTerminalAnimationFrameDelay,
  isTerminalAnimationTheme,
  renderTerminalAnimationFrame,
} from "./terminal-animation.mjs";

export { renderCometFrame } from "./terminal-animation.mjs";

const ESC = "\u001b";
const ERASE_LINE = `\r${ESC}[2K`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

const IDLE_DELAY_MS = 800;

function envFlagEnabled(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized !== "" && !["0", "false", "no", "off"].includes(normalized);
}

function terminalActivityEnabled({ env, output, errorOutput }) {
  const animationSetting = String(env.CCDX_TERMINAL_ANIMATION || "").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(animationSetting)) return false;
  if (envFlagEnabled(env.CI) || String(env.TERM || "").toLowerCase() === "dumb") return false;
  if (output?.isTTY !== true || errorOutput?.isTTY !== true) return false;
  const columns = Number(output.columns);
  return !Number.isFinite(columns) || columns <= 0 || columns >= TERMINAL_ANIMATION_TRACK_WIDTH + 2;
}

function disabledIndicator() {
  return {
    enabled: false,
    beginRequest() { return () => {}; },
    cleanup() {},
  };
}

export function createTerminalActivityIndicator({
  env = process.env,
  output = process.stdout,
  errorOutput = process.stderr,
  consoleObj = console,
  timers = { setTimeout, clearTimeout },
  theme = DEFAULT_TERMINAL_ANIMATION_THEME,
} = {}) {
  if (!terminalActivityEnabled({ env, output, errorOutput })) return disabledIndicator();
  if (!isTerminalAnimationTheme(theme)) throw new TypeError(`Unknown terminal animation theme: ${String(theme)}`);

  const themeMetadata = TERMINAL_ANIMATION_THEMES.find(({ id }) => id === theme);
  const cycleLength = getTerminalAnimationCycleLength(theme);

  const methods = ["log", "warn", "error", "debug"];
  const originals = Object.fromEntries(methods.map((method) => [method, consoleObj[method]]));
  const wrappers = {};
  let activeRequests = 0;
  let idleTimer = null;
  let frameTimer = null;
  let framePosition = 0;
  let cursorHidden = false;
  let frameVisible = false;
  let cleaned = false;

  const schedule = (callback, delay) => {
    const timer = timers.setTimeout(callback, delay);
    timer?.unref?.();
    return timer;
  };

  const clearTimer = (timer) => {
    if (timer) timers.clearTimeout(timer);
  };

  const clearAnimation = () => {
    clearTimer(frameTimer);
    frameTimer = null;
    framePosition = 0;
    try {
      if (cursorHidden || frameVisible) output.write(`${ERASE_LINE}${SHOW_CURSOR}`);
    } finally {
      cursorHidden = false;
      frameVisible = false;
    }
  };

  const cancelPendingOutput = () => {
    clearTimer(idleTimer);
    idleTimer = null;
    clearAnimation();
  };

  const drawNextFrame = () => {
    frameTimer = null;
    if (cleaned || activeRequests === 0) {
      clearAnimation();
      return;
    }
    if (framePosition >= cycleLength) {
      framePosition = 0;
      if (themeMetadata.loopPauseMs > 0) {
        output.write(ERASE_LINE);
        frameVisible = false;
        frameTimer = schedule(drawNextFrame, themeMetadata.loopPauseMs);
        return;
      }
    }

    const frameIndex = themeMetadata.startFrame + framePosition;
    const prefix = cursorHidden ? "" : HIDE_CURSOR;
    cursorHidden = true;
    frameVisible = true;
    output.write(`${prefix}${ERASE_LINE}${renderTerminalAnimationFrame(theme, frameIndex)}`);
    framePosition += 1;
    frameTimer = schedule(drawNextFrame, getTerminalAnimationFrameDelay(theme, frameIndex));
  };

  const scheduleAfterIdle = () => {
    clearTimer(idleTimer);
    idleTimer = null;
    if (cleaned || activeRequests === 0) return;
    idleTimer = schedule(() => {
      idleTimer = null;
      drawNextFrame();
    }, IDLE_DELAY_MS);
  };

  for (const method of methods) {
    const original = typeof originals[method] === "function" ? originals[method] : () => {};
    wrappers[method] = (...args) => {
      cancelPendingOutput();
      try {
        return original.apply(consoleObj, args);
      } finally {
        scheduleAfterIdle();
      }
    };
    consoleObj[method] = wrappers[method];
  }

  return {
    enabled: true,
    beginRequest() {
      if (cleaned) return () => {};
      activeRequests += 1;
      if (activeRequests === 1 && !idleTimer && !frameTimer) scheduleAfterIdle();
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        activeRequests = Math.max(0, activeRequests - 1);
        if (activeRequests === 0) {
          clearTimer(idleTimer);
          idleTimer = null;
          clearAnimation();
        }
      };
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      activeRequests = 0;
      clearTimer(idleTimer);
      idleTimer = null;
      try {
        clearAnimation();
      } finally {
        for (const method of methods) {
          if (consoleObj[method] === wrappers[method]) consoleObj[method] = originals[method];
        }
      }
    },
  };
}
