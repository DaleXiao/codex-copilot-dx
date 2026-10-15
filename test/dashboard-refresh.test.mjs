import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../src/dashboard/refresh.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../src/dashboard/index.html", import.meta.url), "utf8");
const createController = runInNewContext(`${source}\nccdxRefresh.createController;`, { AbortController });
const flush = () => new Promise(resolve => setImmediate(resolve));

test("the real page supplies chart timestamps and loads the controller before its consumers", () => {
  assert.match(html, /id="analytics-updated"/);
  assert.ok(html.indexOf('src="/refresh.js"') < html.indexOf('src="/ui.js"'));
  assert.match(html, /id="auto-refresh"[^>]*aria-pressed="true"/);
});

function fixture(load = async () => ({ n: 1 })) {
  let now = 0;
  let visible = true;
  let open = true;
  let variant = "summary";
  const timers = new Map();
  const applies = [];
  let reads = 0;
  const controller = createController({ visible: () => visible, now: () => now,
    setTimer(fn, ms) { timers.set(fn, ms); return fn; }, clearTimer(fn) { timers.delete(fn); },
    resources: { data: { visible: () => open, variant: () => variant,
      load: async options => { reads += 1; return load(options); },
      apply: (value, options) => applies.push({ value, changed: options.changed }),
    } },
  });
  return { controller, timers, applies, get reads() { return reads; },
    advance(ms) { now += ms; }, visibility(value) { visible = value; controller.visibilityChanged(); },
    open(value) { open = value; }, variant(value) { variant = value; },
    tick() { const fn = timers.keys().next().value; assert.ok(fn); now += timers.get(fn); timers.delete(fn); fn(); },
  };
}

test("one visible timer refreshes due resources every 30 minutes and skips collapsed groups", async () => {
  const f = fixture();
  await f.controller.refresh("data");
  f.controller.setAutomatic(true);
  assert.deepEqual([...f.timers.values()], [1800000]);
  f.tick(); await flush();
  assert.equal(f.reads, 2);
  assert.equal(f.timers.size, 1);
  f.open(false); f.tick(); await flush();
  assert.equal(f.reads, 2);
  await f.controller.refresh("data");
  assert.equal(f.reads, 3);
});

test("hidden, disabled and suspended pages make no scheduled calls; returning catches up once", async () => {
  const f = fixture();
  await f.controller.refresh("data");
  f.controller.setAutomatic(true);
  f.visibility(false);
  assert.equal(f.timers.size, 0);
  f.advance(8 * 1800000);
  f.visibility(true); await flush();
  assert.equal(f.reads, 2);
  f.visibility(true); await flush();
  assert.equal(f.reads, 2);
  f.controller.setAutomatic(false);
  assert.equal(f.timers.size, 0);
  f.advance(1800000); f.visibility(false); f.visibility(true); await flush();
  assert.equal(f.reads, 2);
  await f.controller.refresh("data", { force: true });
  assert.equal(f.reads, 3);
  f.controller.suspend();
  await f.controller.refresh("data", { force: true });
  assert.equal(f.reads, 3);
  f.controller.resume();
  await f.controller.refresh("data");
  assert.equal(f.reads, 3, "Fresh completed snapshots survive back-forward restoration");
  await f.controller.refresh("data", { force: true });
  assert.equal(f.reads, 4);
});

test("rapid opens and 50 manual clicks share one in-flight request, with a 30-second open freshness window", async () => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  const calls = Array.from({ length: 50 }, () => f.controller.refresh("data", { force: true }));
  await flush();
  assert.equal(f.reads, 1);
  release({ n: 1 }); await Promise.all(calls);
  await f.controller.refresh("data");
  assert.equal(f.reads, 1);
  f.advance(30001);
  const next = f.controller.refresh("data"); await flush(); release({ n: 1 }); await next;
  assert.equal(f.reads, 2);
  assert.equal(f.applies[1].changed, false);
});

test("errors retain the last snapshot/time, throttle failed opens and do not auto-retry", async () => {
  let fail = false;
  const f = fixture(() => { if (fail) throw Error("offline"); return { n: 7 }; });
  await f.controller.refresh("data");
  f.advance(30001); fail = true;
  await f.controller.refresh("data");
  assert.equal(f.controller.state("data").value.n, 7);
  assert.equal(f.controller.state("data").updatedAt, 0);
  assert.match(f.controller.state("data").error.message, /offline/);
  await f.controller.refresh("data");
  assert.equal(f.reads, 2);
  const cold = fixture(() => { throw Error("offline"); });
  await cold.controller.refresh("data"); await cold.controller.refresh("data");
  assert.equal(cold.reads, 1);
});

test("refresh keeps failures visible until a successful replacement and reports composite loading", async () => {
  let fail = true, release;
  const pending = [];
  const controller = createController({ visible: () => true, setTimer: setTimeout, clearTimer: clearTimeout, onState: state => pending.push(state.pending), resources: {
    fast: { visible: () => true, apply() {}, load() { if (fail) throw Error("offline");return { ok: true }; } },
    slow: { visible: () => true, apply() {}, load: () => new Promise(resolve => { release = resolve; }) },
  } });
  const first = controller.refreshVisible({ force: true });await flush();
  assert.match(controller.state("fast").error.message, /offline/);
  assert.equal(pending.at(-1), true, "fast completion cannot clear the slower resource's loading state");
  release({ ok: true });await first;assert.equal(pending.at(-1), false);
  fail = false;
  const next = controller.refresh("fast", { force: true });
  assert.match(controller.state("fast").error.message, /offline/, "starting a retry does not erase an unread failure");
  await next;assert.equal(controller.state("fast").error, null);
});

test("opening analytics during a summary read follows up once without concurrent reads", async () => {
  let release;
  const variants = [];
  const f = fixture(({ variant }) => { variants.push(variant); return new Promise(resolve => { release = resolve; }); });
  const summary = f.controller.refresh("data"); await flush();
  f.variant("analytics");
  const upgrades = Array.from({ length: 5 }, () => f.controller.refresh("data"));
  release({ n: 1 }); await summary; await flush();
  assert.deepEqual(variants, ["summary", "analytics"]);
  release({ n: 2 }); await Promise.all(upgrades);
  assert.equal(f.reads, 2);
});

test("page suspension aborts owned reads and ignores stale replies after a resumed request", async () => {
  const pending = [];
  const f = fixture(({ signal }) => new Promise(resolve => pending.push({ signal, resolve })));
  const old = f.controller.refresh("data"); await flush();
  f.controller.suspend();
  assert.equal(pending[0].signal.aborted, true);
  f.controller.resume();
  const current = f.controller.refresh("data"); await flush();
  pending[1].resolve({ n: 2 }); await current;
  pending[0].resolve({ n: 1 }); await old;
  assert.equal(f.controller.state("data").value.n, 2);
  assert.equal(f.applies.length, 1);
});
