import test from "node:test";
import assert from "node:assert/strict";
import { readSafeUpstreamReason } from "../src/safe-upstream-error.mjs";

test("only known structured error codes and compatible statuses become safe reasons", async () => {
  for (const [status, code, recognized] of [[429, "credit_balance_exhausted", true], [429, "insufficient_quota", true],
    [429, "rate_limit_exceeded", true], [400, "context_length_exceeded", true], [422, "context_window_exceeded", true],
    [502, "context_length_exceeded", false], [401, "insufficient_quota", false], [429, "private secret", false]]) {
    const response = Response.json({ error: { code, message: "private prompt and credential" } }, { status });
    const reason = await readSafeUpstreamReason(response);
    assert.equal(Boolean(reason), recognized);if (recognized) assert.equal(reason.code, code);
    assert.doesNotMatch(JSON.stringify(reason), /private prompt|credential/);assert.equal(response.bodyUsed, true);
  }
  assert.equal(await readSafeUpstreamReason(new Response("broken", { status: 422 })), null);
});

test("slow, oversized and stalled-cancellation bodies fall back within a bounded wait", async () => {
  let cancelled = 0;
  const slow = new Response(new ReadableStream({ cancel() { cancelled++;return new Promise(() => {}); } }), { status: 429 });
  let watchdog;const expiry = new Promise((_, reject) => { watchdog = setTimeout(() => reject(Error("deadline did not finish")), 1000); });
  const outcome = await Promise.race([readSafeUpstreamReason(slow, { timeoutMs: 200 }), expiry]).finally(() => clearTimeout(watchdog));
  assert.equal(outcome, null);assert.equal(cancelled, 1);
  const over = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { cancelled++; } }), { status: 422 });
  assert.equal(await readSafeUpstreamReason(over), null);assert.equal(cancelled, 2);
});

test("request cancellation stops reading and cancels the upstream body", async () => {
  let cancelled = 0;const controller = new AbortController();
  const response = new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 429 });
  const result = readSafeUpstreamReason(response, { signal: controller.signal });
  controller.abort(new Error("user cancelled"));await assert.rejects(result, /user cancelled/);
  assert.equal(cancelled, 1);
});

test("concurrent error bodies are bounded; excess failures fall back immediately", async () => {
  const controllers = [], jobs = [];let cancelled = 0;
  for (let i = 0; i < 4; i++) {
    const controller = new AbortController();controllers.push(controller);
    const response = new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 429 });
    jobs.push(readSafeUpstreamReason(response, { signal: controller.signal }).catch(() => null));
  }
  const extra = new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 429 });
  assert.equal(await readSafeUpstreamReason(extra), null);assert.equal(cancelled, 1);
  controllers.forEach(controller => controller.abort());await Promise.all(jobs);assert.equal(cancelled, 5);
});
