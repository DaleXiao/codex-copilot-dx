import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTerminalActivityIndicator,
  renderCometFrame,
} from "../src/terminal-activity.mjs";
import {
  TERMINAL_ANIMATION_THEMES,
  renderTerminalAnimationFrame,
} from "../src/terminal-animation.mjs";

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(callback, delay) {
      const timer = { id: nextId, at: now + delay, callback, unref() {} };
      nextId += 1;
      pending.set(timer.id, timer);
      return timer;
    },
    clearTimeout(timer) {
      pending.delete(timer?.id);
    },
    advance(duration) {
      const target = now + duration;
      while (true) {
        const next = [...pending.values()]
          .filter((timer) => timer.at <= target)
          .sort((left, right) => left.at - right.at || left.id - right.id)[0];
        if (!next) break;
        pending.delete(next.id);
        now = next.at;
        next.callback();
      }
      now = target;
    },
  };
}

function fakeConsole(events) {
  return Object.fromEntries(["log", "warn", "error", "debug"].map((method) => [
    method,
    (...args) => events.push({ type: method, text: args.join(" ") }),
  ]));
}

function fakeStream(events, { isTTY = true, name = "output", columns = 80 } = {}) {
  return {
    isTTY,
    columns,
    write(chunk) {
      events.push({ type: name, text: String(chunk) });
      return true;
    },
  };
}

test("renderCometFrame: renders a 20-column colon comet with a seven-cell tail", () => {
  const frame = renderCometFrame(10);
  const plain = frame.replace(ANSI_PATTERN, "");
  assert.equal(plain.length, 22);
  assert.equal([...plain].filter((character) => character === ":").length, 8);
  assert.equal(plain.includes(">"), false);
  assert.match(frame, /\u001b\[97m:/);
  assert.match(frame, /\u001b\[38;5;33m:/);
});

test("terminal activity: stays disabled outside an interactive terminal", () => {
  const events = [];
  const consoleObj = fakeConsole(events);
  const originalLog = consoleObj.log;
  const indicator = createTerminalActivityIndicator({
    env: {},
    output: fakeStream(events, { isTTY: false }),
    errorOutput: fakeStream(events, { name: "error-output" }),
    consoleObj,
    timers: fakeTimers(),
  });

  const finish = indicator.beginRequest();
  finish();
  assert.equal(indicator.enabled, false);
  assert.equal(consoleObj.log, originalLog);
  assert.deepEqual(events, []);
});

test("terminal activity: honors explicit opt-out and non-interactive environments", () => {
  for (const env of [
    { CCDX_TERMINAL_ANIMATION: "0" },
    { CCDX_TERMINAL_ANIMATION: "false" },
    { CCDX_TERMINAL_ANIMATION: "no" },
    { CCDX_TERMINAL_ANIMATION: "off" },
    { CI: "true" },
    { TERM: "dumb" },
  ]) {
    const events = [];
    const indicator = createTerminalActivityIndicator({
      env,
      output: fakeStream(events),
      errorOutput: fakeStream(events, { name: "error-output" }),
      consoleObj: fakeConsole(events),
      timers: fakeTimers(),
    });
    assert.equal(indicator.enabled, false);
  }

  const events = [];
  assert.equal(createTerminalActivityIndicator({
    env: {},
    output: fakeStream(events, { columns: 21 }),
    errorOutput: fakeStream(events, { name: "error-output" }),
    consoleObj: fakeConsole(events),
    timers: fakeTimers(),
  }).enabled, false);
});

test("terminal activity: default Comet write sequence and timing stay byte-compatible", () => {
  const events = [];
  const timers = fakeTimers();
  const consoleObj = fakeConsole(events);
  const indicator = createTerminalActivityIndicator({
    env: {},
    output: fakeStream(events),
    errorOutput: fakeStream(events, { name: "error-output" }),
    consoleObj,
    timers,
  });

  const finish = indicator.beginRequest();
  timers.advance(800);
  assert.equal(events.at(-1).text, `\u001b[?25l\r\u001b[2K${renderCometFrame(0)}`);
  for (let position = 1; position < 27; position += 1) {
    timers.advance(45);
    assert.equal(events.at(-1).text, `\r\u001b[2K${renderCometFrame(position)}`);
  }

  timers.advance(45);
  assert.equal(events.at(-1).text, "\r\u001b[2K");
  const eventCountDuringPause = events.length;
  timers.advance(199);
  assert.equal(events.length, eventCountDuringPause);
  timers.advance(1);
  assert.equal(events.at(-1).text, `\r\u001b[2K${renderCometFrame(0)}`);

  finish();
  assert.equal(events.at(-1).text, "\r\u001b[2K\u001b[?25h");
  indicator.cleanup();
});

test("terminal activity: every injected theme starts after idle and cleanup restores state", () => {
  for (const theme of TERMINAL_ANIMATION_THEMES) {
    const events = [];
    const timers = fakeTimers();
    const consoleObj = fakeConsole(events);
    const originals = { ...consoleObj };
    const indicator = createTerminalActivityIndicator({
      env: {},
      output: fakeStream(events),
      errorOutput: fakeStream(events, { name: "error-output" }),
      consoleObj,
      timers,
      theme: theme.id,
    });

    indicator.beginRequest();
    timers.advance(799);
    assert.deepEqual(events, []);
    timers.advance(1);
    assert.equal(
      events.at(-1).text,
      `\u001b[?25l\r\u001b[2K${renderTerminalAnimationFrame(theme.id, theme.startFrame)}`,
    );

    indicator.cleanup();
    assert.equal(events.at(-1).text, "\r\u001b[2K\u001b[?25h");
    for (const method of ["log", "warn", "error", "debug"]) {
      assert.equal(consoleObj[method], originals[method]);
    }
    const countAfterCleanup = events.length;
    timers.advance(5000);
    indicator.cleanup();
    assert.equal(events.length, countAfterCleanup);
  }
});

test("terminal activity: cleanup restores console methods even when terminal cleanup fails", () => {
  const events = [];
  const timers = fakeTimers();
  const consoleObj = fakeConsole(events);
  const originals = { ...consoleObj };
  let writeCount = 0;
  const output = fakeStream(events);
  output.write = (chunk) => {
    writeCount += 1;
    events.push({ type: "output", text: String(chunk) });
    if (writeCount === 2) throw new Error("terminal cleanup failed");
    return true;
  };
  const indicator = createTerminalActivityIndicator({
    env: {},
    output,
    errorOutput: fakeStream(events, { name: "error-output" }),
    consoleObj,
    timers,
  });

  indicator.beginRequest();
  timers.advance(800);
  assert.throws(() => indicator.cleanup(), /terminal cleanup failed/);
  for (const method of ["log", "warn", "error", "debug"]) {
    assert.equal(consoleObj[method], originals[method]);
  }
  assert.doesNotThrow(() => indicator.cleanup());
  const countAfterCleanup = events.length;
  timers.advance(5000);
  assert.equal(events.length, countAfterCleanup);
});

test("terminal activity: starts after idle, loops, and yields immediately to real output", () => {
  const events = [];
  const timers = fakeTimers();
  const consoleObj = fakeConsole(events);
  const originalLog = consoleObj.log;
  const output = fakeStream(events);
  const errorOutput = fakeStream(events, { name: "error-output" });
  const indicator = createTerminalActivityIndicator({
    env: {},
    output,
    errorOutput,
    consoleObj,
    timers,
  });

  const finish = indicator.beginRequest();
  timers.advance(799);
  assert.deepEqual(events, []);
  timers.advance(1);
  assert.match(events.at(-1).text, /\u001b\[\?25l/);
  assert.match(events.at(-1).text, /\[/);

  timers.advance((27 * 45) + 200);
  const renderedFrames = events.filter((event) => event.type === "output" && event.text.includes("[")).length;
  assert.ok(renderedFrames > 27);

  consoleObj.log("real output");
  const logIndex = events.findIndex((event) => event.type === "log" && event.text === "real output");
  assert.ok(logIndex > 0);
  assert.match(events[logIndex - 1].text, /\u001b\[2K\u001b\[\?25h/);

  const countAfterLog = events.length;
  timers.advance(799);
  assert.equal(events.length, countAfterLog);
  timers.advance(1);
  assert.ok(events.length > countAfterLog);

  finish();
  const countAfterFinish = events.length;
  timers.advance(5000);
  assert.equal(events.length, countAfterFinish);
  indicator.cleanup();
  assert.equal(consoleObj.log, originalLog);
});
