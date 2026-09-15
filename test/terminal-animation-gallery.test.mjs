import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { startTerminalAnimationGallery } from "../src/terminal-animation-gallery.mjs";
import { renderTerminalAnimationFrame, TERMINAL_ANIMATION_THEMES } from "../src/terminal-animation.mjs";

function fixture() {
  let now = 0;
  let nextId = 0;
  const pending = new Map();
  const writes = [];
  const output = Object.assign(new EventEmitter(), {
    isTTY: true, columns: 80, rows: 24,
    write: (chunk) => { writes.push(chunk); return true; },
  });
  const timers = {
    setTimeout(callback, delay) {
      const id = ++nextId;
      pending.set(id, { at: now + delay, callback });
      assert.equal(pending.size, 1, "The gallery shares exactly one timer");
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
  };
  return {
    output, writes, timers, now: () => now, pending,
    advance(ms) {
      const end = now + ms;
      while (pending.size) {
        const [id, timer] = [...pending.entries()][0];
        if (timer.at > end) break;
        pending.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = end;
    },
  };
}

test("animation gallery updates every theme in place on one clock and preserves input cursor", () => {
  const f = fixture();
  const gallery = startTerminalAnimationGallery({ ...f, prefixWidth: 31, env: {} });
  assert.equal(gallery.enabled, true);
  f.advance(300);
  const rendered = f.writes.join("");
  const updates = [...rendered.matchAll(/\u001b7\u001b\[(\d+)A\u001b\[32G(.*?)\u001b8/g)];
  assert.equal(new Set(updates.map((match) => match[1])).size, TERMINAL_ANIMATION_THEMES.length);
  assert.ok(updates.length > TERMINAL_ANIMATION_THEMES.length);
  assert.doesNotMatch(rendered, /[\r\n]|Select|\?25[lh]/);
  gallery.stop();
  gallery.stop();
  assert.equal(f.pending.size, 0);
  const count = f.writes.length;
  f.advance(1000);
  assert.equal(f.writes.length, count);
});

test("animation gallery honors theme frame delays and the Comet loop pause", () => {
  const f = fixture();
  const gallery = startTerminalAnimationGallery({ ...f, env: {}, prefixWidth: 31 });
  f.advance(64);
  const first = f.writes.join("");
  assert.ok(first.includes(renderTerminalAnimationFrame("comet", 1)));
  assert.ok(first.includes(renderTerminalAnimationFrame("twin", 6)));
  assert.equal(first.includes("\u001b[4A"), false, "Pulse has not reached its 115ms delay");
  f.advance(1184); // 1248ms lies in Comet's 200ms pause after its 27 x 45ms cycle.
  assert.ok(f.writes.some((write) => write.includes("\u001b[9A\u001b[32G[                    ]\u001b8")));
  gallery.stop();
});

test("animation gallery accounts for earlier validation lines and wrapped prompt input", () => {
  const f = fixture();
  const gallery = startTerminalAnimationGallery({ ...f, env: {}, prefixWidth: 31, rowsBelow: 2, getInputRows: () => 1 });
  f.advance(64);
  assert.match(f.writes.join(""), /\u001b7\u001b\[12A\u001b\[32G/);
  gallery.stop();
});

test("animation gallery falls back without cursor writes for unsupported terminals or opt-out", () => {
  for (const overrides of [
    { output: { isTTY: false, columns: 80, rows: 24 } },
    { output: { isTTY: true, columns: 40, rows: 24 } },
    { output: { isTTY: true, columns: 80, rows: 8 } },
    { env: { CCDX_TERMINAL_ANIMATION: "0" } },
    { env: { CI: "true" } },
    { env: { TERM: "dumb" } },
  ]) {
    const f = fixture();
    const gallery = startTerminalAnimationGallery({ ...f, env: {}, prefixWidth: 31, ...overrides });
    assert.equal(gallery.enabled, false);
    assert.equal(f.pending.size, 0);
    assert.deepEqual(f.writes, []);
  }
});

test("animation gallery stops on terminal changes, excessive input and output backpressure", () => {
  for (const event of ["resize", "close", "error", "scroll", "backpressure", "write-error"]) {
    const f = fixture();
    let inputRows = 0;
    const gallery = startTerminalAnimationGallery({ ...f, env: {}, prefixWidth: 31, getInputRows: () => inputRows });
    if (event === "scroll") inputRows = 30;
    else if (event === "backpressure") f.output.write = () => false;
    else if (event === "write-error") f.output.write = () => { throw new Error("closed output"); };
    else f.output.emit(event);
    assert.doesNotThrow(() => f.advance(300));
    assert.equal(f.pending.size, 0, event);
    assert.equal(f.output.listenerCount("resize"), 0);
    gallery.stop();
  }
});
