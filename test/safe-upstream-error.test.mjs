import test from "node:test";
import assert from "node:assert/strict";
import { readSafeUpstreamReason, classifyUpstreamError } from "../src/safe-upstream-error.mjs";

test("explicit diagnostic consent retains a bounded message without changing the default reason", async () => {
  const body = { error: { type: "invalid_request_error", message: "field invalid; key is private-literal; authorization=Bearer token-value; content: user echo" } };
  const normal = await readSafeUpstreamReason(Response.json(body, { status: 400 }));
  assert.equal(normal.diagnostic_message, undefined);
  const detailed = await readSafeUpstreamReason(Response.json(body, { status: 400 }), { diagnosticRedact: text => text.replaceAll("private-literal", "[redacted]") });
  assert.equal(detailed.code, normal.code);assert.equal(detailed.message, normal.message);
  assert.ok(detailed.diagnostic_message.length <= 512);assert.doesNotMatch(detailed.diagnostic_message, /private-literal|token-value|user echo/);
});

test("specific failures retain only a safe field and bounded technical maximum", () => {
  const output = classifyUpstreamError({ error: { type: "invalid_request_error", message: "max_output_tokens invalid; at most 32,768. Private prompt: fixture-private", param: "max_output_tokens" } }, 400);
  assert.equal(output.code, "output_limit_invalid");assert.equal(output.parameter, "max_output_tokens");assert.equal(output.maximum, 32768);
  assert.doesNotMatch(JSON.stringify(output), /Private prompt|fixture-private/);
  assert.equal(classifyUpstreamError({ error: { message: "Too many tools; maximum number of tools is 128" } }, 400).maximum, 128);
  assert.equal(classifyUpstreamError({ error: { message: "thinking is not supported" } }, 400)?.code, "reasoning_parameter_unsupported");
  assert.equal(classifyUpstreamError({ error: { code: "invalid_request_error", message: "private data", param: "private_field" } }, 400).parameter, undefined);
  assert.equal(classifyUpstreamError({ error: { message: "max_tokens invalid: maximum 123456789123456" } }, 400).maximum, undefined);
  assert.equal(classifyUpstreamError({ error: { message: "input tokens exceed context window" } }, 400).code, "context_length_exceeded");
});

test("input-range failures retain only a validated range and client-recognizable wording", () => {
  for (const maximum of [1048576, 262144, 128000]) {
    const reason = classifyUpstreamError({ error: { type: "invalid_request_error", message: `Range of input length should be [1, ${maximum}]` } }, 400);
    assert.equal(reason.code, "input_length_invalid");assert.equal(reason.maximum, maximum);
    assert.equal(reason.message, `Range of input length should be [1, ${maximum}].`);
  }
  for (const message of ["Range of input length should be [1, 0]", "Range of input length should be [1, 9999999999]", "Range of max_tokens should be [1, 128000]",
    "policy_blocked: Range of input length should be [1, 1048576]", "content: Range of input length should be [1, 1048576]"])
    assert.notEqual(classifyUpstreamError({ error: { type: "invalid_request_error", message } }, 400)?.code, "input_length_invalid");
  assert.equal(classifyUpstreamError({ error: { message: "Range of input length should be [1, 1048576]" } }, 429), null);
});

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
