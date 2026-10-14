import test from "node:test";
import assert from "node:assert/strict";
import { supervisePrediction } from "../src/native-prediction-recovery.mjs";
import { createPredictionState } from "../src/native-prediction-state.mjs";

function bridge(options = {}) {
  return { pacUrl: "http://127.0.0.1:12345/proxy.pac", healthy: () => true, enabled: () => true, async close() {}, ...options };
}
function supervisor(options) {
  let tick, cleared = false;
  const owned = supervisePrediction({ ...options, setIntervalImpl(fn, ms) { tick = fn;assert.equal(ms, 30000);return { unref() {} }; }, clearIntervalImpl() { cleared = true; } });
  return { owned, tick: () => tick(), cleared: () => cleared };
}

test("healthy and disabled prediction checks do not start processes, perform network probes or restart", async () => {
  const state = createPredictionState();let healthy = 0;
  const s = supervisor({ native: bridge({ healthy: () => { healthy++;return true; } }), state, restart() { assert.fail(); } });
  await s.owned.check();assert.equal(healthy, 1);assert.ok(state.snapshot().recovery.last_check_at);
  await s.owned.close();assert.equal(s.cleared(), true);await s.owned.check();assert.equal(healthy, 1);
  const disabled = supervisor({ native: bridge({ enabled: () => false, healthy() { assert.fail(); } }), restart() { assert.fail(); } });
  await disabled.owned.check();await disabled.owned.close();
});

test("a lost bridge is recovered once on the same route, without overlapping checks or an App restart", async () => {
  let finish, starts = 0, closes = 0;
  const state = createPredictionState();state.configure(true);state.running({ type: "direct" });
  const s = supervisor({ native: bridge({ healthy: () => false, async close() { closes++; } }), state,
    restart: async () => { starts++;await new Promise(resolve => { finish = resolve; });return bridge(); } });
  const check = s.owned.check();await Promise.resolve();await s.owned.check();assert.equal(starts, 1);
  finish();await check;
  assert.equal(state.snapshot().bridge, "running");assert.deepEqual(state.snapshot().recovery.attempts, 1);
  assert.equal(state.snapshot().recovery.recovered, 1);assert.equal(closes, 1);
  await s.owned.check();assert.equal(starts, 1);await s.owned.close();
});

test("recovery uses backoff and stops after three failures instead of retrying forever", async () => {
  let time = 0, starts = 0;
  const state = createPredictionState();
  const s = supervisor({ native: bridge({ healthy: () => false }), state, now: () => time,
    restart: async () => { starts++;throw new Error("port occupied; not replaced"); } });
  await s.owned.check();await s.owned.check();assert.equal(starts, 1);
  time = 30000;await s.owned.check();assert.equal(starts, 2);
  time = 90000;await s.owned.check();assert.equal(starts, 3);
  time = 1000000;await s.owned.check();assert.equal(starts, 3);
  assert.equal(state.snapshot().bridge, "unavailable");assert.equal(state.snapshot().recovery.attempts, 3);
  await s.owned.close();
});

test("changed routes are rejected and closing during recovery closes the newly created owned bridge", async () => {
  let resumedClosed = 0;
  const s = supervisor({ native: bridge({ healthy: () => false }), restart: async () => bridge({
    pacUrl: "http://127.0.0.1:23456/proxy.pac", async close() { resumedClosed++; } }), state: createPredictionState() });
  await s.owned.check();assert.equal(resumedClosed, 1);await s.owned.close();
  let finish;
  const r = supervisor({ native: bridge({ healthy: () => false }), restart: () => new Promise(resolve => { finish = resolve; }) });
  const check = r.owned.check();await Promise.resolve();const closing = r.owned.close();
  finish(bridge({ async close() { resumedClosed++; } }));await check;await closing;
  assert.equal(resumedClosed, 2);
});
