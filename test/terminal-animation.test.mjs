import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TERMINAL_ANIMATION_THEME,
  TERMINAL_ANIMATION_THEMES,
  TERMINAL_ANIMATION_TRACK_WIDTH,
  getTerminalAnimationCycleLength,
  getTerminalAnimationFrameDelay,
  isTerminalAnimationTheme,
  playTerminalAnimationPreview,
  renderCometFrame,
  renderTerminalAnimationFrame,
} from "../src/terminal-animation.mjs";

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_COLOR_PATTERN = /\u001b\[([0-9;]+)m/g;
const ALLOWED_COLORS = new Set(["0", "97", "38;5;159", "38;5;123", "38;5;87", "38;5;51", "38;5;45", "38;5;39", "38;5;33"]);

const EXPECTED_THEMES = [
  { id: "comet", label: "Comet", frameCount: 27, frameDelayMs: 45, loopPauseMs: 200, startFrame: 0 },
  { id: "twin", label: "Twin", frameCount: 26, frameDelayMs: 60, loopPauseMs: 0, startFrame: 5 },
  { id: "shuttle", label: "Shuttle", frameCount: 38, frameDelayMs: 55, loopPauseMs: 0, startFrame: 7 },
  { id: "chase", label: "Chase", frameCount: 34, frameDelayMs: 65, loopPauseMs: 0, startFrame: 13 },
  { id: "mirror", label: "Mirror", frameCount: 18, frameDelayMs: 75, loopPauseMs: 0, startFrame: 3 },
  { id: "pulse", label: "Pulse", frameCount: 8, frameDelayMs: 115, loopPauseMs: 0, startFrame: 2 },
  { id: "braille", label: "Braille", frameCount: 10, frameDelayMs: 80, loopPauseMs: 0, startFrame: 0 },
];

function legacyCometFrame(position) {
  const colors = [159, 123, 87, 51, 45, 39, 33];
  let track = "";
  for (let column = 0; column < 20; column += 1) {
    const distance = position - column;
    if (distance === 0) {
      track += "\u001b[97m:\u001b[0m";
    } else if (distance > 0 && distance <= 7) {
      track += `\u001b[38;5;${colors[distance - 1]}m:\u001b[0m`;
    } else {
      track += " ";
    }
  }
  return `[${track}]`;
}

function immediateTimers(delays) {
  const cleared = new Set();
  let nextId = 1;
  return {
    setTimeout(callback, delay) {
      const timer = { id: nextId };
      nextId += 1;
      delays.push(delay);
      queueMicrotask(() => {
        if (!cleared.has(timer.id)) callback();
      });
      return timer;
    },
    clearTimeout(timer) {
      cleared.add(timer?.id);
    },
  };
}

test("terminal animation: exposes the exact ordered theme catalog", () => {
  assert.equal(DEFAULT_TERMINAL_ANIMATION_THEME, "comet");
  assert.equal(TERMINAL_ANIMATION_TRACK_WIDTH, 20);
  assert.deepEqual(TERMINAL_ANIMATION_THEMES, EXPECTED_THEMES);
  assert.equal(Object.isFrozen(TERMINAL_ANIMATION_THEMES), true);
  assert.ok(TERMINAL_ANIMATION_THEMES.every(Object.isFrozen));

  for (const { id } of EXPECTED_THEMES) assert.equal(isTerminalAnimationTheme(id), true);
  for (const value of ["braille-comet", "current", "Comet", "", null, 1]) {
    assert.equal(isTerminalAnimationTheme(value), false);
  }
});

test("terminal animation: every frame keeps the fixed track and established color vocabulary", () => {
  for (const theme of TERMINAL_ANIMATION_THEMES) {
    assert.equal(getTerminalAnimationCycleLength(theme.id), theme.frameCount);
    for (let frameIndex = 0; frameIndex < theme.frameCount; frameIndex += 1) {
      const frame = renderTerminalAnimationFrame(theme.id, frameIndex);
      const plain = frame.replace(ANSI_PATTERN, "");
      assert.equal([...plain].length, TERMINAL_ANIMATION_TRACK_WIDTH + 2, `${theme.id} frame ${frameIndex}`);
      assert.equal(plain[0], "[");
      assert.equal(plain.at(-1), "]");

      const colors = [...frame.matchAll(ANSI_COLOR_PATTERN)].map((match) => match[1]);
      assert.ok(colors.every((color) => ALLOWED_COLORS.has(color)), `${theme.id} frame ${frameIndex}`);

      if (theme.id === "braille") {
        assert.match(plain, /^\[[ ⠀-⣿]{20}\]$/u);
        assert.equal([...plain].filter((glyph) => /[⠀-⣿]/u.test(glyph)).length, 1);
      } else {
        assert.match(plain, /^\[[ :]{20}\]$/);
      }
    }

    assert.equal(
      renderTerminalAnimationFrame(theme.id, theme.frameCount),
      renderTerminalAnimationFrame(theme.id, 0),
    );
  }
});

test("terminal animation: Comet frames remain byte-compatible with the original renderer", () => {
  for (let position = 0; position < 27; position += 1) {
    const expected = legacyCometFrame(position);
    assert.equal(renderCometFrame(position), expected);
    assert.equal(renderTerminalAnimationFrame("comet", position), expected);
  }
});

test("terminal animation: cycle timing is deterministic for every theme", () => {
  for (const theme of TERMINAL_ANIMATION_THEMES) {
    const delays = Array.from(
      { length: theme.frameCount },
      (_, offset) => getTerminalAnimationFrameDelay(theme.id, theme.startFrame + offset),
    );
    assert.ok(delays.every((delay) => Number.isInteger(delay) && delay > 0));
    if (theme.id !== "shuttle") assert.deepEqual(new Set(delays), new Set([theme.frameDelayMs]));
  }

  assert.equal(getTerminalAnimationFrameDelay("shuttle", 0), 160);
  assert.equal(getTerminalAnimationFrameDelay("shuttle", 19), 160);
  assert.equal(getTerminalAnimationFrameDelay("shuttle", 20), 55);
  assert.equal(getTerminalAnimationFrameDelay("shuttle", 38), 160);
  assert.throws(() => renderTerminalAnimationFrame("braille-comet", 0), /Unknown terminal animation theme/);
  assert.throws(() => renderTerminalAnimationFrame("comet", 0.5), /frame index must be an integer/);
});

test("terminal animation preview: plays one finite cycle without hiding the cursor", async () => {
  for (const theme of TERMINAL_ANIMATION_THEMES) {
    const writes = [];
    const delays = [];
    const output = {
      isTTY: true,
      columns: 80,
      write(chunk) {
        writes.push(String(chunk));
        return true;
      },
    };

    assert.equal(await playTerminalAnimationPreview(theme.id, {
      output,
      timers: immediateTimers(delays),
    }), true);
    assert.equal(writes.length, theme.frameCount + 1);
    assert.equal(delays.length, theme.frameCount);
    assert.match(writes[0], /^\r\u001b\[2K/);
    assert.equal(writes[0].endsWith(renderTerminalAnimationFrame(theme.id, theme.startFrame)), true);
    assert.equal(writes.at(-1), "\r\u001b[2K");
    assert.equal(writes.join("").includes("\u001b[?25l"), false);
    assert.equal(writes.join("").includes("\u001b[?25h"), false);
  }
});

test("terminal animation preview: skips unsuitable output and restores after a write failure", async () => {
  const skippedWrites = [];
  assert.equal(await playTerminalAnimationPreview("comet", {
    output: { isTTY: false, write: (chunk) => skippedWrites.push(chunk) },
    timers: immediateTimers([]),
  }), false);
  assert.deepEqual(skippedWrites, []);

  const writes = [];
  let writeCount = 0;
  const output = {
    isTTY: true,
    columns: 80,
    write(chunk) {
      writeCount += 1;
      writes.push(String(chunk));
      if (writeCount === 2) throw new Error("write failed");
      return true;
    },
  };
  await assert.rejects(
    playTerminalAnimationPreview("pulse", { output, timers: immediateTimers([]) }),
    /write failed/,
  );
  assert.equal(writes.at(-1), "\r\u001b[2K");
  assert.equal(writes.join("").includes("\u001b[?25l"), false);
  assert.equal(writes.join("").includes("\u001b[?25h"), false);
});
