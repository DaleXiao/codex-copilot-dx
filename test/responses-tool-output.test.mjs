import test from "node:test";
import assert from "node:assert/strict";
import { isMissingCallIdError, normalizeCallLessToolOutputs } from "../src/responses-tool-output.mjs";
import { responsesToChat } from "../src/responses-bridge.mjs";
import { openCopilotResponse } from "../src/copilot-responses-compat.mjs";
import { createApiProvider } from "../src/providers/api.mjs";
import { invokeAdapter } from "../test-support/adapter.mjs";
import { clearResponseHistoryForTests } from "../src/response-history.mjs";
import { prepareResponsesRequest } from "../src/responses-request.mjs";

const receipt = { type: "function_call_output", id: "fco_1", name: "open_page", namespace: "apps", output: [
  { type: "input_text", text: "page context" }, { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
] };
const paired = { type: "function_call_output", call_id: "call_1", output: "paired" };
const body = () => ({ model: "fixture", input: [receipt, paired] });
const missing = "Failed to deserialize the JSON body into the target type: input: missing field `call_id` at line 1 column 42";

test("call-less receipts preserve text, images and provenance without changing paired results", () => {
  const original = body(), copy = structuredClone(original), normalized = normalizeCallLessToolOutputs(original);
  assert.deepEqual(original, copy);assert.deepEqual(normalized.input[1], paired);
  assert.equal(normalized.input[0].role, "user");
  assert.match(normalized.input[0].content[0].text, /TOOL OUTPUT - NOT USER INPUT/);
  assert.match(normalized.input[0].content[0].text, /"name":"open_page"/);
  assert.deepEqual(normalized.input[0].content.slice(1), receipt.output);
  const chat = responsesToChat(original);
  assert.equal(chat.messages[0].role, "user");
  assert.equal(chat.messages[0].content[2].image_url.url, receipt.output[1].image_url);
  assert.deepEqual(chat.messages[1], { role: "tool", tool_call_id: "call_1", content: "paired" });
  assert.equal(normalizeCallLessToolOutputs({ input: [{ ...receipt, unknown: "keep" }] }), null);
  assert.equal(normalizeCallLessToolOutputs({ input: [{ ...receipt, output: [{ type: "unknown" }] }] }), null);
  assert.throws(() => responsesToChat({ model: "fixture", input: [{ ...receipt, output: [{ type: "unknown" }] }] }), { code: "ccdx_responses_chat_incompatible" });
});

test("only explicit missing-call-id validation failures permit compatibility", () => {
  for (const [status, message] of [[400, missing], [422, missing], [400, "Invalid 'call_id': call_id is required for function_call_output."],
    [400, "Missing required parameter: 'input[2].call_id'"]]) {
    assert.equal(isMissingCallIdError(status, JSON.stringify({ error: { message } })), true);
  }
  for (const [status, message] of [[500, missing], [400, "call_id invalid"], [429, missing], [400, "prefix " + missing]]) {
    assert.equal(isMissingCallIdError(status, JSON.stringify({ error: { message } })), false);
  }
});

test("GitHub Responses retries only after an explicit missing-call-id rejection", async () => {
  const sent = [], context = { body: body(), inputItems: body().input, currentInputStart: 0, surface: "responses" };
  const opened = await openCopilotResponse(context, async value => {
    sent.push(structuredClone(value));
    return sent.length === 1 ? Response.json({ error: { message: missing } }, { status: 400 }) : Response.json({ id: "ok", output: [] });
  });
  assert.equal(opened.resp.status, 200);assert.equal(sent.length, 2);
  assert.equal(sent[0].input[0].type, "function_call_output");assert.equal(sent[1].input[0].type, "message");
  assert.deepEqual(sent[1].input[0].content.slice(1), receipt.output);
  assert.equal(opened.usedRetryPolicies.has("call-less-tool-output"), true);
  let attempts = 0;
  const failure = await openCopilotResponse(context, async () => { attempts++;return Response.json({ error: { message: "unrelated" } }, { status: 400 }); });
  assert.equal(failure.resp.status, 400);assert.equal(attempts, 1);
});

test("custom API retries the explicit validation failure without exposing its vendor text", async () => {
  const config = { id: "api_test", name: "test", base_url: "https://example.test/v1", endpoints: { responses: "https://example.test/v1/responses" },
    secret_ref: "fixture", auth_header: "bearer", models: [{ id: "fixture", protocols: ["responses"] }] };
  const calls = [];let errorHeaders = 0;
  const provider = createApiProvider({ config, env: {}, secrets: { get: async () => "synthetic-only" }, networkFactory: async () => ({ close() {},
    async fetch(_url, init) { calls.push(JSON.parse(init.body));return calls.length === 1
      ? new Response(missing, { status: 422 }) : Response.json({ id: "ok", output: [] }); } }) });
  try {
    const response = await provider.client.responses(body(), { payloadPrepared: true, onUpstreamErrorHeaders() { errorHeaders++; } });
    assert.equal(response.status, 200);assert.equal(calls.length, 2);assert.equal(errorHeaders, 0);
    assert.deepEqual(calls[1].input[0].content.slice(1), receipt.output);assert.deepEqual(calls[1].input[1], paired);
  } finally { provider.close(); }
});

test("custom API compatibility retains the transformed receipt for conversation history", async () => {
  const config = { id: "api_test", name: "test", base_url: "https://example.test/v1", endpoints: { responses: "https://example.test/v1/responses" },
    secret_ref: "fixture", auth_header: "bearer", models: [{ id: "fixture", protocols: ["responses"] }] };
  let attempts = 0;
  const provider = createApiProvider({ config, env: {}, secrets: { get: async () => "synthetic-only" }, networkFactory: async () => ({ close() {},
    async fetch() { attempts++;return attempts === 1 ? new Response(missing, { status: 400 }) : Response.json({ id: "ok", output: [] }); } }) });
  try {
    const context = prepareResponsesRequest({ model: "fixture", input: [receipt] }, { copilotBoundary: false });context.surface = "responses";
    const opened = await provider.compatibility.openResponse(context, provider.client.responses, {});
    assert.equal(opened.resp.status, 200);assert.equal(attempts, 2);
    assert.equal(opened.reqContext.historyInputItems[0].type, "message");
    assert.deepEqual(opened.reqContext.historyInputItems[0].content.slice(1), receipt.output);
  } finally { provider.close(); }
});

test("a recovered standalone receipt is stored in its forwarded form for later turns", async () => {
  clearResponseHistoryForTests();let attempts = 0;
  const options = { getCachedModelEndpointsFn: () => ["/responses"], responsesFn: async input => {
    attempts++;
    if (input.input.some(item => item?.type === "function_call_output" && !item.call_id)) return Response.json({ error: { message: missing } }, { status: 400 });
    return Response.json({ id: `resp_${attempts}`, status: "completed", output: [] });
  } };
  try {
    const first = await invokeAdapter(options, { body: { model: "fixture", input: [receipt] } });assert.equal(first.status, 200);
    const id = JSON.parse(first.text).id;assert.equal(attempts, 2);
    const next = await invokeAdapter(options, { body: { model: "fixture", previous_response_id: id, input: "continue" } });
    assert.equal(next.status, 200);assert.equal(attempts, 3);
  } finally { clearResponseHistoryForTests(); }
});
