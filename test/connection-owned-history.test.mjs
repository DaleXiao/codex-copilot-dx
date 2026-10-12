import test from "node:test";
import assert from "node:assert/strict";
import { isConnectionOwnedInputError, isEncryptedContentVerificationError } from "../src/copilot-responses-policy.mjs";
import { openCopilotResponse, selectCopilotResponseRetry } from "../src/copilot-responses-compat.mjs";
import { sanitizeConnectionOwnedReasoningRequest } from "../src/responses-request.mjs";
import { invokeAdapter } from "../test-support/adapter.mjs";

const error = JSON.stringify({ error: { message: "input item does not belong to this connection", code: "" } });
const input = [
  { type: "message", role: "user", content: "Keep the earlier decision." },
  { type: "reasoning", encrypted_content: "synthetic-unavailable" },
  { type: "function_call", name: "lookup", arguments: "{}", call_id: "call_fixture" },
  { type: "function_call_output", call_id: "call_fixture", output: "Earlier result", encrypted_content: "leave-tool-state-alone" },
  { type: "message", role: "user", content: "Continue." },
];
const context = () => ({ body: { model: "gpt-6-astra", input: structuredClone(input), stream: true },
  historyInputItems: structuredClone(input.slice(-1)), currentInputStart: 4, historyParentId: "old-parent" });

test("connection ownership classifier is exact, decoded, HTTP 400 only", () => {
  assert.equal(isEncryptedContentVerificationError(400, error), true);
  assert.equal(isConnectionOwnedInputError(400, error.replace("input", "\\u0069nput")), true);
  for (const status of [200, 401, 403, 429, 500]) assert.equal(isConnectionOwnedInputError(status, error), false);
  for (const body of ["input item does not belong to this connection", '{"detail":"input item does not belong to this connection"}',
    JSON.stringify({ error: { message: "Other error: input item does not belong to this connection" } })]) {
    assert.equal(isConnectionOwnedInputError(400, body), false);
  }
});

test("same-route stale reasoning resumes once without changing messages or tool pairs", async () => {
  const ctx = context(), before = structuredClone(ctx);
  const calls = [], records = [];
  const result = await openCopilotResponse(ctx, async body => {
    calls.push(structuredClone(body));
    return calls.length === 1 ? new Response(error, { status: 400, headers: { "x-request-id": "fixture-id" } })
      : Response.json({ status: "completed", output: [] });
  }, { responseFailures: { record: record => records.push(record) } });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].input, input.filter(item => item.type !== "reasoning"));
  assert.deepEqual(ctx, before);
  assert.equal(result.reqContext.historyParentId, null);
  assert.equal(result.reqContext.currentInputStart, 3);
  assert.deepEqual(records[0].recovery, { reasoning_items_removed: 1, compaction_items_removed: 0 });
  assert.equal(records[0].upstream_request_id, "fixture-id");
});

test("compaction rejection is structured and never discards hidden earlier context", async () => {
  const ctx = context();ctx.body.input.splice(1, 0, { type: "compaction", encrypted_content: "synthetic-memory" });
  const before = structuredClone(ctx), records = [];let calls = 0;
  await assert.rejects(openCopilotResponse(ctx, async () => { calls++;return new Response(error, { status: 400 }); },
    { responseFailures: { record: record => records.push(record) } }), failure => {
    assert.equal(failure.code, "ccdx_history_rebuild_required");
    assert.equal(failure.jsonBody.error.recoverable, true);
    assert.equal(failure.jsonBody.error.recovery.action, "restore_plaintext_history");
    return true;
  });
  assert.equal(calls, 1);assert.deepEqual(ctx, before);
  assert.equal(records[0].retry_skipped, "ccdx_history_rebuild_required");
});

test("healthy state, unencrypted state, unrelated failures and rejected retry remain bounded", async () => {
  const ctx = context();let calls = 0;
  const healthy = await openCopilotResponse(ctx, async body => { calls++;assert.deepEqual(body, ctx.body);return Response.json({}); });
  assert.equal(healthy.usedRetryPolicies.size, 0);assert.equal(calls, 1);
  calls = 0;
  const failed = await openCopilotResponse(ctx, async () => { calls++;return new Response(error, { status: 400 }); });
  assert.equal(calls, 2);assert.equal(failed.errorText, error);
  assert.equal(selectCopilotResponseRetry(ctx, 400, '{"error":{"message":"Invalid model"}}'), null);
  assert.equal(selectCopilotResponseRetry({ body: { input: input.filter(item => item.type !== "reasoning") } }, 400, error), null);
  assert.equal(sanitizeConnectionOwnedReasoningRequest({ body: { input: "hello" } }), null);
});

test("ownership recovery reaches the real HTTP boundary and preserves tool output state", async () => {
  const bodies = [];
  const result = await invokeAdapter({ getCachedModelEndpointsFn: () => ["/responses"], responsesFn: async body => {
    bodies.push(structuredClone(body));
    return bodies.length === 1 ? new Response(error, { status: 400 })
      : Response.json({ id: "resp_connection_recovered", object: "response", status: "completed", output: [] });
  } }, { body: { ...context().body, stream: false } });
  assert.equal(result.status, 200);assert.equal(bodies.length, 2);
  assert.equal(bodies[1].input.some(item => item.type === "reasoning"), false);
  assert.equal(bodies[1].input.find(item => item.type === "function_call_output").encrypted_content, "leave-tool-state-alone");
});

test("HTTP and pre-output SSE compaction rejection expose a rebuild code without a retry", async () => {
  for (const stream of [false, true]) {
    const body = { ...context().body, stream };
    body.input.splice(1, 0, { type: "compaction", encrypted_content: "hidden-memory" });
    let calls = 0;
    const result = await invokeAdapter({ getCachedModelEndpointsFn: () => ["/responses"], responsesFn: async () => {
      calls++;
      if (!stream) return new Response(error, { status: 400 });
      const event = { type: "response.failed", response: { id: "resp_ownership_failed", object: "response", status: "failed", output: [], error: JSON.parse(error).error } };
      return new Response(`event: response.failed\ndata: ${JSON.stringify(event)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    } }, { body });
    assert.equal(calls, 1);assert.match(result.text, /ccdx_history_rebuild_required/);
    assert.match(result.text, /full plaintext conversation history/);
    if (!stream) assert.equal(JSON.parse(result.text).error.recoverable, true);
  }
});
