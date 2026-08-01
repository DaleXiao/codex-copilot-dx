const ESC = "\u001b";
const ERASE_LINE = `\r${ESC}[2K`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

const TRACK_WIDTH = 20;
const TAIL_LENGTH = 7;
const IDLE_DELAY_MS = 800;
const FRAME_DELAY_MS = 45;
const LOOP_PAUSE_MS = 200;
const TAIL_COLORS = [159, 123, 87, 51, 45, 39, 33];

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
  return !Number.isFinite(columns) || columns <= 0 || columns >= TRACK_WIDTH + 2;
}

export function renderCometFrame(position) {
  let track = "";
  for (let column = 0; column < TRACK_WIDTH; column += 1) {
    const distance = position - column;
    if (distance === 0) {
      track += `${ESC}[97m:${ESC}[0m`;
    } else if (distance > 0 && distance <= TAIL_LENGTH) {
      track += `${ESC}[38;5;${TAIL_COLORS[distance - 1]}m:${ESC}[0m`;
    } else {
      track += " ";
    }
  }
  return `[${track}]`;
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
} = {}) {
  if (!terminalActivityEnabled({ env, output, errorOutput })) return disabledIndicator();

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
    if (cursorHidden || frameVisible) output.write(`${ERASE_LINE}${SHOW_CURSOR}`);
    cursorHidden = false;
    frameVisible = false;
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
    if (framePosition >= TRACK_WIDTH + TAIL_LENGTH) {
      output.write(ERASE_LINE);
      frameVisible = false;
      framePosition = 0;
      frameTimer = schedule(drawNextFrame, LOOP_PAUSE_MS);
      return;
    }

    const prefix = cursorHidden ? "" : HIDE_CURSOR;
    cursorHidden = true;
    frameVisible = true;
    output.write(`${prefix}${ERASE_LINE}${renderCometFrame(framePosition)}`);
    framePosition += 1;
    frameTimer = schedule(drawNextFrame, FRAME_DELAY_MS);
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
      clearAnimation();
      for (const method of methods) {
        if (consoleObj[method] === wrappers[method]) consoleObj[method] = originals[method];
      }
    },
  };
}
