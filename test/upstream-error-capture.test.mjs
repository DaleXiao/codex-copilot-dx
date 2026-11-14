import test from "node:test";
import assert from "node:assert/strict";
import { createUpstreamErrorCapture } from "../src/upstream-error-capture.mjs";

test("capture is explicit, scoped, expires and consumes only one matching failure", () => {
  let time = 0;const capture = createUpstreamErrorCapture({ now: () => time });
  assert.equal(capture.claim("api_a", "kimi", "messages", 400, "before"), null);
  capture.arm("api_a", "kimi");
  for (const [source, model, protocol, status] of [["api_b", "kimi", "messages", 400], ["api_a", "other", "messages", 400], ["api_a", "kimi", "responses", 400], ["api_a", "kimi", "messages", 429], ["api_a", "kimi", "messages", 200]])
    assert.equal(capture.claim(source, model, protocol, status, "irrelevant"), null);
  const finish = capture.claim("api_a", "kimi", "messages", 400, "chosen");
  assert.equal(typeof finish, "function");assert.equal(capture.claim("api_a", "kimi", "messages", 400, "second"), null);
  finish("Invalid message field. authorization=Bearer private-value");
  assert.equal(capture.snapshot().state, "captured");assert.equal(capture.snapshot().request_id, "chosen");
  assert.doesNotMatch(capture.snapshot().diagnostic_message, /private-value/);
  capture.arm("api_a", "kimi");time = 600001;
  assert.equal(capture.claim("api_a", "kimi", "messages", 400, "late"), null);assert.equal(capture.snapshot().state, "expired");
});

test("cancel removes details and an old reader cannot overwrite a new consent", () => {
  const capture = createUpstreamErrorCapture();capture.arm("api_a", "kimi");
  assert.throws(() => capture.arm("api_a", "kimi"), /already pending/);
  const stale = capture.claim("api_a", "kimi", "messages", 422, "old");
  capture.cancel();capture.arm("api_b", "model");stale("stale data");
  assert.equal(capture.snapshot().source, "api_b");assert.equal(capture.snapshot().diagnostic_message, undefined);
  capture.cancel();assert.deepEqual(capture.snapshot(), { state: "off" });
});
