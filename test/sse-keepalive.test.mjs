import assert from "node:assert/strict";
import test from "node:test";
import { createSseKeepalive } from "../src/sse-keepalive.mjs";

function fixture() {
  let time = 0;
  let pending;
  let delay;
  const writes = [];
  const res = { headersSent: true, write: value => { writes.push(value); return true; } };
  const abort = new AbortController();
  const clock = { now: () => time, setTimer: (cb, ms) => { pending = cb; delay = ms; return 1; }, clearTimer: () => { pending = null; } };
  const keepalive = createSseKeepalive({ res, signal: abort.signal, intervalMs: 100, ...clock });
  return { res, abort, keepalive, writes, get delay() { return delay; }, get pending() { return pending; },
    advance(ms) { time += ms; const callback = pending; pending = null; callback?.(); } };
}

test("SSE heartbeat is idle-only, complete, bounded and stopped on finish/abort", () => {
  const f = fixture();
  f.advance(100);
  assert.deepEqual(f.writes, [": ccdx keepalive\n\n"]);
  f.keepalive.activity();
  f.advance(50);
  assert.equal(f.writes.length, 1);
  assert.equal(f.delay, 50);
  f.res.writableNeedDrain = true;
  f.advance(50);
  assert.equal(f.writes.length, 1);
  f.abort.abort();
  assert.equal(f.pending, null);
  f.keepalive.stop();
});

test("SSE heartbeat never commits headers, writes after termination or bypasses held retry output", () => {
  const f = fixture();
  f.res.headersSent = false;
  f.advance(100);
  assert.equal(f.writes.length, 0);
  assert.equal(f.delay, 100);
  f.res.headersSent = true;
  f.res.writableEnded = true;
  f.advance(100);
  assert.equal(f.writes.length, 0);
  assert.equal(f.pending, null);
  let callback;
  const writes = [];
  const held = createSseKeepalive({ res: { headersSent: true, write: value => writes.push(value) },
    intervalMs: 10, now: () => 100, canWrite: () => false,
    setTimer: cb => { callback = cb; return 1; }, clearTimer: () => {} });
  callback();
  assert.equal(writes.length, 0);
  held.stop();
});
