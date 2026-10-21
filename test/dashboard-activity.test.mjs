import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { invokeAdapter } from "../test-support/adapter.mjs";

const script = readFileSync(new URL("../src/dashboard/activity.js", import.meta.url), "utf8");
test("the real dispatcher serves the activity module only through the local dashboard boundary", async () => {
  const response = await invokeAdapter({}, { url: "/activity.js", method: "GET", headers: { host: "127.0.0.1:2026" } });
  assert.equal(response.status, 200);assert.equal(response.text, script);
  assert.equal((await invokeAdapter({}, { url: "/activity.js", method: "GET", headers: { host: "evil.invalid" } })).status, 403);
});
function fixture() {
  const timers = new Map(), listeners = new Map();let hidden = false, writes = 0, now = 0;
  const node = { dataset: {}, closest: () => hidden ? {} : null };
  const label = {};
  const document = { visibilityState: "visible", getElementById: id => id === "model-activity" ? node : label,
    addEventListener: (key, fn) => listeners.set(key, fn) };
  const context = { document, Date: { now: () => now }, addEventListener: (key, fn) => listeners.set(key, fn),
    setTimeout(fn, ms) { timers.set(fn, ms);return fn; }, clearTimeout(fn) { timers.delete(fn); },
    ccdxLanguage: { set(target, key, values, attribute = "textContent") { writes++;target[attribute] = `${key}:${values.count}`; } } };
  runInNewContext(script, context);
  return { api: context.ccdxDashboardActivity, node, label, document, timers, listeners, get writes() { return writes; }, hide(value) { hidden = value; }, advance(ms) { now += ms; } };
}
test("activity distinguishes fresh work, idle, invalid and expired status without extra requests", () => {
  const f = fixture();
  f.api.update({ active: 2 });assert.equal(f.node.dataset.state, "active");assert.equal(f.label.hidden, false);
  const writes = f.writes;
  f.api.update({ active: 2 });assert.equal(f.writes, writes);assert.deepEqual([...f.timers.values()], [6000]);
  f.api.update({ active: 0 });assert.equal(f.node.dataset.state, "idle");assert.equal(f.label.hidden, true);
  for (const active of [null, undefined, -1, NaN, Infinity, "0", 1.5]) {
    f.api.update({ active });assert.equal(f.node.dataset.state, "unknown");assert.equal(f.label.hidden, false);
  }
  f.api.update({ active: 1 });f.api.unavailable();assert.equal(f.node.dataset.state, "unknown");assert.equal(f.timers.size, 0);
  f.api.update({ active: 0 });f.timers.keys().next().value();assert.equal(f.node.dataset.state, "unknown");
});
test("activity pauses offscreen and through page lifecycle without replaying completed work", () => {
  const f = fixture();f.api.update({ active: 3 });
  f.document.visibilityState = "hidden";f.listeners.get("visibilitychange")();assert.equal(f.node.dataset.paused, "true");
  f.document.visibilityState = "visible";f.hide(true);f.api.visibilityChanged();assert.equal(f.node.dataset.paused, "true");
  f.hide(false);f.api.update({ active: 0 });f.api.visibilityChanged();assert.equal(f.node.dataset.state, "idle");assert.equal(f.node.dataset.paused, "false");
  f.listeners.get("pagehide")();assert.equal(f.node.dataset.paused, "true");
  f.listeners.get("pageshow")();assert.equal(f.node.dataset.paused, "false");
  f.api.update({ active: 2 });f.advance(8000);f.listeners.get("pageshow")();assert.equal(f.node.dataset.state, "unknown");
});
