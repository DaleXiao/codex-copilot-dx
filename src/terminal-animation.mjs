const ESC = "\u001b";

export const TERMINAL_ANIMATION_TRACK_WIDTH = 20;
export const DEFAULT_TERMINAL_ANIMATION_THEME = "comet";

const TAIL_LENGTH = 7;
const TAIL_COLORS = Object.freeze([159, 123, 87, 51, 45, 39, 33]);
const BRAILLE_GLYPHS = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);

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
    id: "braille",
    label: "Braille",
    frameCount: BRAILLE_GLYPHS.length,
    frameDelayMs: 80,
    loopPauseMs: 0,
    startFrame: 0,
    render(index) {
      const cells = blankTrack();
      setCell(cells, Math.floor(TERMINAL_ANIMATION_TRACK_WIDTH / 2), BRAILLE_GLYPHS[index], `38;5;${TAIL_COLORS[2]}`);
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
