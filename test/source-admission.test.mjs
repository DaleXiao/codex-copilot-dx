import test from "node:test";
import assert from "node:assert/strict";
import { createSourceAdmission, sourceLimitFeedback } from "../src/source-admission.mjs";

const descriptor = source => ({ source, account: source + ":account" });
const flush = () => new Promise(resolve => setImmediate(resolve));
const busyStream = () => {
  let controller, cancelled = false;
  return { response: new Response(new ReadableStream({ start(value) { controller = value; }, cancel() { cancelled = true; } })),
    finish() { controller.enqueue(new TextEncoder().encode("done"));controller.close(); }, cancelled: () => cancelled };
};

test("source slots span response bodies; separate sources and accounts remain independent", async () => {
  const scheduler = createSourceAdmission({ initialLimit: 1 }), stream = busyStream();
  const first = await scheduler.run(descriptor("github"), async () => stream.response);
  let called = false;
  const second = scheduler.run(descriptor("github"), async () => { called = true;return Response.json({ ok: true }); });
  await flush();assert.equal(called, false);assert.equal(scheduler.snapshot()[0].active, 1);
  const other = await scheduler.run(descriptor("m365"), async () => Response.json({ independent: true }));await other.text();
  const account = await scheduler.run({ source: "github", account: "other" }, async () => Response.json({ independent: true }));await account.text();
  stream.finish();assert.equal(await first.text(), "done");await (await second).text();
  assert.equal(called, true);assert.ok(scheduler.snapshot().every(row => row.active === 0));scheduler.close();
});

test("queued applications rotate without dropping FIFO within an application", async () => {
  const scheduler = createSourceAdmission({ initialLimit: 1 }), firstStream = busyStream(), order = [];
  const first = await scheduler.run(descriptor("github"), async () => firstStream.response, { client: "codex" });
  const call = (client, id) => scheduler.run(descriptor("github"), async () => { order.push(id);return Response.json(id); }, { client }).then(response => response.text());
  const pending = [call("codex", "c1"), call("codex", "c2"), call("claude_app", "a1"), call("gemini_app", "g1")];
  firstStream.finish();await first.text();await Promise.all(pending);
  assert.equal(order[0], "a1");assert.ok(order.indexOf("c1") < order.indexOf("c2"));scheduler.close();
});

test("concurrency feedback contracts once for one burst and never cancels active streams", async () => {
  let now = 0;const scheduler = createSourceAdmission({ now: () => now, initialLimit: 4 });
  const held = [busyStream(), busyStream()];
  const active = await Promise.all(held.map(item => scheduler.run(descriptor("api_a"), async () => item.response)));
  const error = await scheduler.run(descriptor("api_a"), async () => Response.json({ error: { code: "concurrency_limit", limit: 1 } }, { status: 429 }));
  await error.text();assert.equal(scheduler.snapshot()[0].limit, 1);assert.equal(scheduler.snapshot()[0].active, 2);
  assert.ok(held.every(item => !item.cancelled()));
  let called = false;const queued = scheduler.run(descriptor("api_a"), async () => { called = true;return Response.json({}); });
  held[0].finish();await active[0].text();await flush();assert.equal(called, false);
  held[1].finish();await active[1].text();now = 2000;scheduler.configure("api_a", null);
  await (await queued).text();assert.equal(called, true);scheduler.close();
});

test("only structured 429 errors affect capacity; quota and model scope are preserved", () => {
  assert.equal(sourceLimitFeedback(400, new Headers(), { error: { message: "concurrency limit" } }), null);
  assert.equal(sourceLimitFeedback(200, new Headers(), { error: { code: "quota_exceeded" } }), null);
  assert.equal(sourceLimitFeedback(429, new Headers(), { choices: [{ message: { content: "concurrency limit" } }] }).kind, "unknown");
  assert.equal(sourceLimitFeedback(429, new Headers(), { error: { code: "rate_limit_error" } }).kind, "rate");
  assert.equal(sourceLimitFeedback(429, new Headers(), { error: { code: "rate_limit_error", details: { scope: "account" } } }).scope, "source");
  assert.deepEqual(sourceLimitFeedback(429, new Headers(), { error: { code: "model_quota_exceeded", message: "Individual quota reached. Resets in 1h18m40s." } }),
    { kind: "quota", scope: "model", delay: 4720000 });
  assert.equal(sourceLimitFeedback(429, new Headers(), { error: { details: { error_code: "enforced_spend_limit_reached" } } }).scope, "source");
});

test("a model quota cannot block sibling models or shrink their concurrency", async () => {
  const scheduler = createSourceAdmission();
  const response = await scheduler.run(descriptor("api_a"), async () => Response.json({ error: { code: "model_quota_exceeded" } }, { status: 429 }), { model: "limited" });await response.text();
  await assert.rejects(scheduler.run(descriptor("api_a"), async () => Response.json({}), { model: "limited" }), { code: "ccdx_source_limited" });
  // The account's short spacing interval expires without a paid recovery probe.
  scheduler.close();
  let now = 0;const isolated = createSourceAdmission({ now: () => now });
  const error = await isolated.run(descriptor("api_a"), async () => Response.json({ error: { code: "model_quota_exceeded" } }, { status: 429 }), { model: "limited" });await error.text();
  now = 1001;const good = await isolated.run(descriptor("api_a"), async () => Response.json({}), { model: "other" });await good.text();
  assert.equal(isolated.snapshot()[0].limit, 128);isolated.close();
});

test("queue byte/count bounds, cancellation and shutdown release ownership once", async () => {
  const bodyText = "x".repeat(1024 * 1024);
  const scheduler = createSourceAdmission({ initialLimit: 1, maxQueued: 1, maxQueuedBytes: bodyText.length }), stream = busyStream();
  const first = await scheduler.run(descriptor("api_a"), async () => stream.response);
  await assert.rejects(scheduler.run(descriptor("api_a"), async () => Response.json({}), { bodyText: bodyText + "x" }), { code: "ccdx_source_queue_full" });
  const abort = new AbortController();const next = scheduler.run(descriptor("api_a"), async () => Response.json({}), { signal: abort.signal, bodyText });
  const cancelled = assert.rejects(next, { name: "AbortError" });abort.abort();await cancelled;
  const pending = scheduler.run(descriptor("api_a"), async () => Response.json({}), { bodyText });
  const stopped = assert.rejects(pending, { code: "ccdx_source_closed" });scheduler.close();await stopped;
  await first.body.cancel();assert.equal(stream.cancelled(), true);assert.equal(scheduler.snapshot()[0].active, 0);
});

test("manual ceilings update immediately, keep in-flight requests and validate invalid input", async () => {
  const scheduler = createSourceAdmission(), stream = busyStream();
  scheduler.configure("api_a", 1);assert.throws(() => scheduler.configure("api_a", 0), { code: "ccdx_source_limit_invalid" });
  const first = await scheduler.run(descriptor("api_a"), async () => stream.response);
  let called = false;const second = scheduler.run(descriptor("api_a"), async () => { called = true;return Response.json({}); });
  await flush();assert.equal(called, false);scheduler.configure("api_a", 2);await (await second).text();
  assert.equal(stream.cancelled(), false);await first.body.cancel();scheduler.close();
});

test("stable recovery grows on real waiting demand, not on idle traffic", async () => {
  let now = 0;const scheduler = createSourceAdmission({ initialLimit: 1, now: () => now, stableMs: 1 });
  for (let i = 0; i < 8; i++) await (await scheduler.run(descriptor("github"), async () => Response.json({}))).text();
  now = 1000;await (await scheduler.run(descriptor("github"), async () => Response.json({}))).text();assert.equal(scheduler.snapshot()[0].limit, 1);
  const stream = busyStream(), first = await scheduler.run(descriptor("github"), async () => stream.response);
  const second = scheduler.run(descriptor("github"), async () => Response.json({}));stream.finish();await first.text();await (await second).text();
  assert.equal(scheduler.snapshot()[0].limit, 2);scheduler.close();
});

test("idle maturity is retained without increasing stable-cache notification frequency", async () => {
  let now = 0;const notices = [], scheduler = createSourceAdmission({ now: () => now, stableMs: 10, onStable: (...value) => notices.push(value) });
  await (await scheduler.run(descriptor("github"), async () => Response.json({ error: { code: "concurrency_limit", limit: 1 } }, { status: 429 }))).text();
  now = 1001;for (let i = 0; i < 30; i++) await (await scheduler.run(descriptor("github"), async () => Response.json({}))).text();
  assert.equal(notices.length, 1);assert.equal(scheduler.snapshot()[0].limit, 1);
  const stream = busyStream(), first = await scheduler.run(descriptor("github"), async () => stream.response);
  const second = scheduler.run(descriptor("github"), async () => Response.json({}));stream.finish();await first.text();await (await second).text();
  assert.equal(scheduler.snapshot()[0].limit, 2);assert.equal(notices.length, 1);scheduler.close();
});

test("one raw 429 body cannot extend its original Retry-After when read later", async () => {
  let now = 0;const scheduler = createSourceAdmission({ now: () => now });
  const response = await scheduler.run(descriptor("github"), async () => Response.json({ error: { code: "concurrency_limit", limit: 1 } }, { status: 429, headers: { "retry-after": "2" } }));
  assert.equal(scheduler.snapshot()[0].retry_after_ms, 2000);now = 500;await response.text();
  assert.equal(scheduler.snapshot()[0].retry_after_ms, 1500);assert.equal(scheduler.snapshot()[0].limit, 1);scheduler.close();
});

test("a manual ceiling cannot train unobserved higher capacity", async () => {
  let now = 0;const scheduler = createSourceAdmission({ initialLimit: 1, now: () => now, stableMs: 1 });
  scheduler.configure("github", 1);
  for (let i = 0; i < 8; i++) await (await scheduler.run(descriptor("github"), async () => Response.json({}))).text();
  now = 1000;const stream = busyStream(), first = await scheduler.run(descriptor("github"), async () => stream.response);
  const second = scheduler.run(descriptor("github"), async () => Response.json({}));stream.finish();await first.text();await (await second).text();
  scheduler.configure("github", null);assert.equal(scheduler.snapshot()[0].limit, 1, "Removing a ceiling keeps the last actually learned capacity");scheduler.close();
});

test("error, abort and nested recovery can acquire a fresh source slot", async () => {
  const scheduler = createSourceAdmission({ initialLimit: 1 });
  await assert.rejects(scheduler.run(descriptor("github"), async () => { throw new Error("offline"); }), /offline/);
  const error = await scheduler.run(descriptor("github"), async () => Response.json({ error: "context too long" }, { status: 400 }));await error.text();
  const summary = await scheduler.run(descriptor("github"), async () => Response.json({ summary: true }));await summary.text();
  const abort = new AbortController(), stream = busyStream();await scheduler.run(descriptor("github"), async () => stream.response, { signal: abort.signal });
  abort.abort();await flush();assert.equal(scheduler.snapshot()[0].active, 0);scheduler.close();
});

test("replacing an endpoint clears its feedback while retaining account slots and ignoring late old feedback", async t => {
  const scheduler = createSourceAdmission({ initialLimit: 2 });
  t.after(() => scheduler.close());
  const old = { ...descriptor("api_a"), revision: "old" }, next = { ...old, revision: "new" };
  const quota = () => Response.json({ error: { code: "model_quota_exceeded" } }, { status: 429 });
  scheduler.registerDeployment(old);
  let finish;
  const late = scheduler.run(old, () => new Promise(resolve => { finish = resolve; }), { model: "limited" });
  const denied = await scheduler.run(old, quota, { model: "limited" });
  await denied.text();
  assert.equal(scheduler.snapshot()[0].model_limits[0].model, "limited");
  scheduler.registerDeployment(old);
  assert.equal(scheduler.snapshot()[0].model_limits.length, 1, "Re-reading unchanged settings preserves evidence");
  scheduler.configure("api_a", 1);
  scheduler.registerDeployment(next);
  assert.equal(scheduler.snapshot()[0].model_limits.length, 0);
  let sent = false;
  const pending = scheduler.run(next, () => { sent = true;return Response.json({ ok: true }); }, { model: "limited" });
  await flush();
  assert.equal(sent, false, "The old attempt still occupies the account's only slot");
  finish(quota());
  assert.equal((await late).status, 429);
  assert.deepEqual(await (await pending).json(), { ok: true });
  assert.equal(scheduler.snapshot()[0].model_limits.length, 0);
});

test("rolling back to a deployment does not admit feedback from an earlier request to it", async t => {
  const scheduler = createSourceAdmission();
  t.after(() => scheduler.close());
  const a = { ...descriptor("api_a"), revision: "a" }, b = { ...a, revision: "b" };
  scheduler.registerDeployment(a);
  const held = Promise.withResolvers();
  const pending = scheduler.run(a, () => held.promise, { model: "fixture" });
  scheduler.registerDeployment(b);
  scheduler.registerDeployment(a);
  held.resolve(Response.json({ error: { code: "model_quota_exceeded" } }, { status: 429 }));
  assert.equal((await pending).status, 429);
  assert.equal(scheduler.snapshot()[0].active, 0);
  assert.deepEqual(scheduler.snapshot()[0].model_limits, []);
});
