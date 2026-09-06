const ESC = "\u001b";

export const TERMINAL_ANIMATION_TRACK_WIDTH = 20;
export const DEFAULT_TERMINAL_ANIMATION_THEME = "comet";

const TAIL_LENGTH = 7;
const TAIL_COLORS = Object.freeze([159, 123, 87, 51, 45, 39, 33]);
const RELAY_ROUTE = Object.freeze([2, 9, 16, 9, 2]);

function colorCell(glyph, color) {
  return `${ESC}[${color}m${glyph}${ESC}[0m`;
}

function blankTrack() {
  return Array.from({ length: TERMINAL_ANIMATION_TRACK_WIDTH }, () => " ");
}

function setCell(cells, index, glyph, color) {
  if (index < 0 || index >= TERMINAL_ANIMATION_TRACK_WIDTH) return;
  cells[index] = colorCell(glyph, color);
}

function drawComet(cells, head, direction, tailLength = TAIL_LENGTH) {
  for (let distance = tailLength; distance >= 1; distance -= 1) {
    setCell(cells, head - (direction * distance), ":", `38;5;${TAIL_COLORS[distance - 1]}`);
  }
  setCell(cells, head, ":", "97");
}

function wrapTrack(cells) {
  return `[${cells.join("")}]`;
}

function pingPongState(index) {
  const period = (TERMINAL_ANIMATION_TRACK_WIDTH - 1) * 2;
  const offset = index % period;
  return offset < TERMINAL_ANIMATION_TRACK_WIDTH
    ? { position: offset, direction: 1 }
    : { position: period - offset, direction: -1 };
}

function setGlowCell(cells, index, level) {
  const color = level === 0 ? "97" : `38;5;${TAIL_COLORS[Math.min(level - 1, TAIL_LENGTH - 1)]}`;
  setCell(cells, index, ":", color);
}

function stackState(index) {
  // Three incoming packets each leave three cells parked on the left.
  for (let parked = 0; parked < 9; parked += 3) {
    const travelFrames = TERMINAL_ANIMATION_TRACK_WIDTH - parked;
    if (index < travelFrames) {
      return { parked, head: TERMINAL_ANIMATION_TRACK_WIDTH - 1 - index, delayMs: 55 };
    }
    if (index === travelFrames) return { parked: parked + 3, delayMs: 180 };
    index -= travelFrames + 1;
  }
  // Release the accumulated bundle, then leave a blank frame before restarting.
  return { shift: index, delayMs: index === 0 ? 130 : index === 21 ? 180 : 50 };
}

const THEME_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "comet",
    label: "Comet",
    frameCount: TERMINAL_ANIMATION_TRACK_WIDTH + TAIL_LENGTH,
    frameDelayMs: 45,
    loopPauseMs: 200,
    startFrame: 0,
    render: renderCometFrame,
  }),
  Object.freeze({
    id: "twin",
    label: "Twin",
    frameCount: 26,
    frameDelayMs: 60,
    loopPauseMs: 0,
    startFrame: 5,
    render(index) {
      const cells = blankTrack();
      drawComet(cells, index - 3, 1, 4);
      drawComet(cells, TERMINAL_ANIMATION_TRACK_WIDTH + 2 - index, -1, 4);
      return wrapTrack(cells);
    },
  }),
  Object.freeze({
    id: "shuttle",
    label: "Shuttle",
    frameCount: (TERMINAL_ANIMATION_TRACK_WIDTH - 1) * 2,
    frameDelayMs: 55,
    loopPauseMs: 0,
    startFrame: 7,
    frameDelay(index) {
      const { position } = pingPongState(index);
      return position === 0 || position === TERMINAL_ANIMATION_TRACK_WIDTH - 1 ? 160 : 55;
    },
    render(index) {
      const cells = blankTrack();
      const { position, direction } = pingPongState(index);
      drawComet(cells, position, direction);
      return wrapTrack(cells);
    },
  }),
  Object.freeze({
    id: "chase",
    label: "Chase",
    frameCount: TERMINAL_ANIMATION_TRACK_WIDTH + 14,
    frameDelayMs: 65,
    loopPauseMs: 0,
    startFrame: 13,
    render(index) {
      const cells = blankTrack();
      const first = index - 4;
      let second = first - 11;
      if (second < -4) second += TERMINAL_ANIMATION_TRACK_WIDTH + 14;
      drawComet(cells, first, 1, 4);
      drawComet(cells, second, 1, 4);
      return wrapTrack(cells);
    },
  }),
  Object.freeze({
    id: "mirror",
    label: "Mirror",
    frameCount: (Math.floor(TERMINAL_ANIMATION_TRACK_WIDTH / 2) - 1) * 2,
    frameDelayMs: 75,
    loopPauseMs: 0,
    startFrame: 3,
    render(index) {
      const cells = blankTrack();
      const half = Math.floor(TERMINAL_ANIMATION_TRACK_WIDTH / 2);
      const period = (half - 1) * 2;
      const distance = index < half ? index : period - index;
      drawComet(cells, half - 1 - distance, -1, 3);
      drawComet(cells, half + distance, 1, 3);
      return wrapTrack(cells);
    },
  }),
  Object.freeze({
    id: "pulse",
    label: "Pulse",
    frameCount: 8,
    frameDelayMs: 115,
    loopPauseMs: 0,
    startFrame: 2,
    render(index) {
      const cells = blankTrack();
      const radii = [0, 1, 2, 3, 4, 3, 2, 1];
      const radius = radii[index];
      const center = Math.floor((TERMINAL_ANIMATION_TRACK_WIDTH - 1) / 2);
      setCell(cells, center, ":", "97");
      for (let distance = 1; distance <= radius; distance += 1) {
        const color = `38;5;${TAIL_COLORS[distance]}`;
        setCell(cells, center - distance, ":", color);
        setCell(cells, center + distance, ":", color);
      }
      return wrapTrack(cells);
    },
  }),
  Object.freeze({
    id: "stack",
    label: "Stack",
    frameCount: 76,
    frameDelayMs: 55,
    loopPauseMs: 0,
    startFrame: 0,
    frameDelay(index) {
      return stackState(index).delayMs;
    },
    render(index) {
      const cells = blankTrack();
      const state = stackState(index);
      if (state.shift !== undefined) {
        for (let column = 0; column < 9; column += 1) {
          setGlowCell(cells, state.shift + column, 8 - column);
        }
      } else {
        for (let column = 0; column < state.parked; column += 1) setGlowCell(cells, column, 5);
        if (state.head !== undefined) drawComet(cells, state.head, -1, 2);
      }
      return wrapTrack(cells);
    },
  }),
  Object.freeze({
    id: "relay",
    label: "Relay",
    frameCount: 40,
    frameDelayMs: 85,
    loopPauseMs: 0,
    startFrame: 0,
    frameDelay(index) {
      const phase = index % 10;
      return phase === 0 ? 220 : phase < 7 ? 85 : 70;
    },
    render(index) {
      const cells = blankTrack();
      const leg = Math.floor(index / 10);
      const from = RELAY_ROUTE[leg];
      const to = RELAY_ROUTE[leg + 1];
      const phase = index % 10;
      const active = phase === 0 ? from : phase >= 7 ? to : -1;
      const level = phase >= 7 ? [0, 1, 3][phase - 7] : 0;
      for (let center = 2; center <= 16; center += 7) {
        for (let offset = -1; offset <= 1; offset += 1) {
          setGlowCell(cells, center + offset, center === active ? level + Math.abs(offset) * 2 : 7);
        }
      }
      if (phase > 0 && phase < 7) {
        const direction = Math.sign(to - from);
        drawComet(cells, from + direction * phase, direction, 2);
      }
      return wrapTrack(cells);
    },
  }),
  Object.freeze({
    id: "split",
    label: "Split",
    frameCount: 29,
    frameDelayMs: 65,
    loopPauseMs: 0,
    startFrame: 0,
    frameDelay(index) {
      return index < 10 ? 70 : index < 13 ? 80 : index < 28 ? 65 : 220;
    },
    render(index) {
      const cells = blankTrack();
      if (index < 10) {
        drawComet(cells, index, 1, 4);
      } else if (index < 13) {
        const level = [2, 0, 1][index - 10];
        for (let offset = -2; offset <= 2; offset += 1) {
          setGlowCell(cells, 9 + offset, level + Math.abs(offset));
        }
      } else if (index < 28) {
        const distance = index - 13;
        drawComet(cells, 9 - distance, -1, 4);
        drawComet(cells, 10 + distance, 1, 4);
      }
      return wrapTrack(cells);
    },
  }),
]);

const DEFINITIONS_BY_ID = new Map(THEME_DEFINITIONS.map((theme) => [theme.id, theme]));

export const TERMINAL_ANIMATION_THEMES = Object.freeze(THEME_DEFINITIONS.map(({
  id,
  label,
  frameCount,
  frameDelayMs,
  loopPauseMs,
  startFrame,
}) => Object.freeze({ id, label, frameCount, frameDelayMs, loopPauseMs, startFrame })));

export function isTerminalAnimationTheme(value) {
  return typeof value === "string" && DEFINITIONS_BY_ID.has(value);
}

function themeDefinition(theme) {
  const definition = DEFINITIONS_BY_ID.get(theme);
  if (!definition) throw new TypeError(`Unknown terminal animation theme: ${String(theme)}`);
  return definition;
}

function normalizedFrameIndex(frameIndex, frameCount) {
  if (!Number.isSafeInteger(frameIndex)) throw new TypeError("Terminal animation frame index must be an integer");
  return ((frameIndex % frameCount) + frameCount) % frameCount;
}

export function getTerminalAnimationCycleLength(theme) {
  return themeDefinition(theme).frameCount;
}

export function getTerminalAnimationFrameDelay(theme, frameIndex) {
  const definition = themeDefinition(theme);
  const index = normalizedFrameIndex(frameIndex, definition.frameCount);
  return definition.frameDelay?.(index) ?? definition.frameDelayMs;
}

export function renderTerminalAnimationFrame(theme, frameIndex) {
  const definition = themeDefinition(theme);
  return definition.render(normalizedFrameIndex(frameIndex, definition.frameCount));
}

export function renderCometFrame(position) {
  let track = "";
  for (let column = 0; column < TERMINAL_ANIMATION_TRACK_WIDTH; column += 1) {
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

function outputSupportsPreview(output) {
  if (output?.isTTY !== true) return false;
  const columns = Number(output.columns);
  return !Number.isFinite(columns) || columns <= 0 || columns >= TERMINAL_ANIMATION_TRACK_WIDTH + 2;
}

export async function playTerminalAnimationPreview(theme, {
  output = process.stdout,
  timers = { setTimeout, clearTimeout },
} = {}) {
  const definition = themeDefinition(theme);
  if (!outputSupportsPreview(output)) return false;

  const eraseLine = `\r${ESC}[2K`;
  let timer = null;
  let previewStarted = false;

  const wait = (delay) => new Promise((resolve) => {
    let settled = false;
    const nextTimer = timers.setTimeout(() => {
      settled = true;
      timer = null;
      resolve();
    }, delay);
    timer = settled ? null : nextTimer;
  });

  try {
    for (let offset = 0; offset < definition.frameCount; offset += 1) {
      const frameIndex = definition.startFrame + offset;
      previewStarted = true;
      output.write(`${eraseLine}${renderTerminalAnimationFrame(theme, frameIndex)}`);
      await wait(getTerminalAnimationFrameDelay(theme, frameIndex));
    }
    return true;
  } finally {
    if (timer) timers.clearTimeout(timer);
    if (previewStarted) output.write(eraseLine);
  }
}
