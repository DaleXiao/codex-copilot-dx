import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTerminalActivityIndicator,
  renderCometFrame,
} from "../src/terminal-activity.mjs";

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

function fakeStream(events, { isTTY = true, name = "output" } = {}) {
  return {
    isTTY,
    columns: 80,
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

test("terminal activity: honors explicit opt-out and CI environments", () => {
  for (const env of [{ CCDX_TERMINAL_ANIMATION: "0" }, { CCDX_TERMINAL_ANIMATION: "off" }, { CI: "true" }]) {
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
