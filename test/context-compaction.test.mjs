import test from "node:test";
import assert from "node:assert/strict";
import { planContextCompaction, compactionItems } from "../src/context-compaction-plan.mjs";
import { sealContextCompaction, openContextCompaction } from "../src/context-compaction-seal.mjs";
import { summaryRequest, readCompactionSummary } from "../src/context-compaction-wire.mjs";
import { createContextCompactionService, expandGatewayCompaction, COMPACTION_USAGE_RECORDED, isCompactionRequest } from "../src/context-compaction.mjs";

const limits = { inputLimit: 16000, outputAllowance: 1024 };
test("Messages compression preserves human instructions, tool pairing and the original body", () => {
  const body = { model: "m", system: "system retained", tools: [{ name: "lookup" }], messages: [
    { role: "user", content: "Keep the original requirements" },
    { role: "assistant", content: [{ type: "tool_use", id: "call-a", name: "lookup", input: { file: "a.mjs" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-a", content: "Confirmed a.mjs; failed b.mjs. ".repeat(900) }] },
    { role: "user", content: "Summarize the prior work" },
  ] };
  const before = structuredClone(body), plan = planContextCompaction(body, { protocol: "messages", ...limits }), output = plan.rewrite("a.mjs succeeded; b.mjs failed");
  assert.equal(plan.selected_items, 2);assert.equal(plan.preserved_items, 2);assert.ok(plan.chunks.length > 1);
  assert.match(plan.chunks.join(""), /call-a/);assert.match(plan.chunks.join(""), /Confirmed a.mjs/);
  assert.strictEqual(output.messages[0], body.messages[0]);assert.strictEqual(output.messages.at(-1), body.messages.at(-1));
  assert.strictEqual(output.tools, body.tools);assert.equal(output.system, body.system);assert.deepEqual(body, before);
  assert.equal(output.messages.length, 3);assert.equal(plan.sizing, "utf8_bytes_not_token_count");
});

for (const protocol of ["responses", "chat", "gemini"]) test(`${protocol} preserves human content and complete tool cycles`, () => {
  const items = protocol === "responses" ? [{ type: "message", role: "user", content: "requirements" },
    { type: "function_call", call_id: "c", name: "lookup", arguments: "{}" }, { type: "function_call_output", call_id: "c", output: "verified fact" }, { type: "message", role: "user", content: "continue" }]
    : protocol === "chat" ? [{ role: "user", content: "requirements" }, { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c", content: "verified fact" }, { role: "user", content: "continue" }]
      : [{ role: "user", parts: [{ text: "requirements" }] }, { role: "model", parts: [{ functionCall: { name: "lookup", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { name: "lookup", response: { fact: "verified fact" } } }] }, { role: "user", parts: [{ text: "continue" }] }];
  const body = protocol === "responses" ? { model: "m", input: items } : protocol === "gemini" ? { model: "m", request: { contents: items, generationConfig: { maxOutputTokens: 4096 } } } : { model: "m", messages: items };
  const plan = planContextCompaction(body, { protocol, ...limits }), output = compactionItems(plan.rewrite("verified fact"), protocol);
  assert.equal(plan.selected_items, 2);assert.strictEqual(output[0], items[0]);assert.strictEqual(output.at(-1), items.at(-1));assert.equal(output.length, 3);
});

test("signed blocks and unfinished tools are not separated or summarized", () => {
  const body = { messages: [{ role: "user", content: "start" }, { role: "assistant", content: "completed fact" },
    { role: "assistant", content: [{ type: "thinking", thinking: "opaque", signature: "signed" }, { type: "tool_use", id: "signed-call", name: "x", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "signed-call", content: "signed result" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "pending", name: "x", input: {} }] }, { role: "user", content: "compact" }] };
  const plan = planContextCompaction(body, { protocol: "messages", ...limits }), output = plan.rewrite("completed fact");
  assert.equal(plan.selected_items, 1);for (const index of [0, 2, 3, 4, 5]) assert.ok(output.messages.includes(body.messages[index]));
  assert.doesNotMatch(plan.chunks.join(""), /signed result|opaque|pending/);
});

test("unknown windows, oversized workloads and protected-only histories fail without mutation", () => {
  const body = { messages: [{ role: "user", content: "keep" }, { role: "assistant", content: "x".repeat(100000) }, { role: "user", content: "keep" }] }, before = structuredClone(body);
  assert.throws(() => planContextCompaction(body, { protocol: "messages" }), { code: "ccdx_compaction_limit_unknown" });
  assert.throws(() => planContextCompaction(body, { protocol: "messages", inputLimit: 6000 }), { code: "ccdx_compaction_work_limit" });
  assert.throws(() => planContextCompaction({ messages: [body.messages[0]] }, { protocol: "messages", ...limits }), { code: "ccdx_compaction_protected_history" });
  assert.deepEqual(body, before);
});

test("the gateway seal is self-contained and rejects tampering or another connection", () => {
  const key = "a".repeat(64), scope = "client:source:revision:model", text = "Private continuation summary";
  const token = sealContextCompaction(text, { key, scope });assert.equal(openContextCompaction(token, { key, scope }), text);assert.ok(!token.includes(text));
  assert.notEqual(sealContextCompaction(text, { key, scope }), token);
  for (const [value, options] of [[token, { key: "b".repeat(64), scope }], [token, { key, scope: "another" }], [token.slice(0, -4) + "aaaa", { key, scope }], ["vendor:opaque", { key, scope }]])
    assert.throws(() => openContextCompaction(value, options), { code: "ccdx_compaction_state_invalid" });
});

test("summary jobs preserve the selected model and reasoning while carrying no executable tools", () => {
  for (const protocol of ["responses", "messages", "chat", "gemini"]) {
    const body = { model: "chosen", max_tokens: 128000, max_output_tokens: 128000, max_completion_tokens: 128000, thinking: { type: "adaptive" }, output_config: { effort: "high" },
      reasoning: { effort: "high" }, reasoning_effort: "high", tools: [{ name: "do-not-run" }], request: { generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } }, tools: [{ functionDeclarations: [] }] } };
    const output = summaryRequest(body, protocol, "quoted historical facts");assert.equal(output.model, "chosen");assert.equal(output.tools, undefined);
    if (protocol === "responses") assert.equal(output.reasoning.effort, "high");
    if (protocol === "messages") { assert.equal(output.output_config.effort, "high");assert.deepEqual(output.thinking, body.thinking); }
    if (protocol === "chat") assert.equal(output.reasoning_effort, "high");
    if (protocol === "gemini") { assert.equal(output.request.generationConfig.thinkingConfig.thinkingLevel, "HIGH");assert.equal(output.request.tools, undefined); }
  }
});

test("JSON and streaming summaries require a valid terminal and retain real zero usage", async () => {
  const json = await readCompactionSummary(Response.json({ type: "message", content: [{ type: "text", text: "fact" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0 } }), "messages");
  assert.equal(json.text, "fact");assert.equal(json.usage.input_tokens_details.cached_tokens, 0);
  const events = [{ type: "message_start", message: { usage: { input_tokens: 3 } } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fact" } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }];
  const stream = events => new Response(events.map(event => "data: " + JSON.stringify(event) + "\r\n\r\n").join(""), { headers: { "content-type": "text/event-stream" } });
  assert.equal((await readCompactionSummary(stream(events), "messages")).text, "fact");
  await assert.rejects(readCompactionSummary(stream(events.slice(0, -1)), "messages"), { code: "ccdx_compaction_result_invalid" });
  await assert.rejects(readCompactionSummary(Response.json({ choices: [{ index: 0, message: { content: "partial" }, finish_reason: "length" }] }), "chat"), { code: "ccdx_compaction_result_invalid" });
});

test("cancelling a stalled summary does not wait for a stalled source cancellation", async () => {
  const controller = new AbortController(), response = new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } }), { headers: { "content-type": "text/event-stream" } });
  const pending = readCompactionSummary(response, "chat", { signal: controller.signal }), rejected = assert.rejects(pending, { name: "AbortError" });
  setImmediate(() => controller.abort());await rejected;
});

const serviceInput = protocol => ({ body: protocol === "responses" ? { model: "m", input: [
  { type: "message", role: "user", content: "keep requirements" }, { type: "message", role: "assistant", content: "verified old work" }, { type: "message", role: "user", content: "continue" }] }
  : { model: "m", messages: [{ role: "user", content: "keep requirements" }, { role: "assistant", content: "verified old work" }, { role: "user", content: "compact" }] },
  protocol, scope: "client:source:revision:m", source: "api_test", client: "codex", key: "k".repeat(64), inputLimit: 16000 });
const sourceLimit = () => Response.json({ error: { type: "invalid_request_error", message: "Range of input length should be [1, 16000]" } }, { status: 400 });

test("native-first and disabled policies preserve responses and do not call a summary model", async () => {
  const service = createContextCompactionService(), response = Response.json({ native: true });let calls = 0;
  assert.strictEqual(await service.run({ ...serviceInput("responses"), native: async () => response, summarize: () => { calls++; } }), response);assert.equal(calls, 0);
  const disabled = createContextCompactionService({ enabled: () => false }), missing = new Response(null, { status: 404 });
  assert.strictEqual(await disabled.run({ ...serviceInput("responses"), native: async () => missing, summarize: () => { calls++; } }), missing);assert.equal(calls, 0);
});

test("Responses fallback returns a scoped seal, records usage once and learns only that connection", async () => {
  const records = [], service = createContextCompactionService({ recordUsageFn: value => records.push(value) });let native = 0;
  const input = { ...serviceInput("responses"), native: async () => { native++;return new Response(null, { status: 404 }); },
    summarize: async () => ({ text: "placeholder summary", usage: { input_tokens: 9, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } } }), restoreText: text => text.replace("placeholder", "private") };
  const response = await service.run(input), data = await response.json();assert.equal(response[COMPACTION_USAGE_RECORDED], true);assert.equal(data.usage.input_tokens, 9);assert.equal(data.usage.input_tokens_details.cached_tokens, 0);
  const sealed = data.output.find(item => item.type === "compaction");assert.ok(sealed);assert.doesNotMatch(JSON.stringify(data), /private summary/);
  const expanded = expandGatewayCompaction({ input: data.output }, input);assert.ok(JSON.stringify(expanded).includes("private summary"));assert.equal(expanded.input[0].content[0].text, "keep requirements");
  assert.throws(() => expandGatewayCompaction({ input: data.output }, { ...input, scope: "other" }), { code: "ccdx_compaction_state_invalid" });
  const vendor = { input: [{ type: "compaction", encrypted_content: "vendor-sealed" }] };assert.strictEqual(expandGatewayCompaction(vendor, input), vendor);
  await service.run(input);assert.equal(native, 1);assert.equal(records.length, 2);assert.ok(records.every(record => record.purpose === "compaction"));
  await service.run({ ...input, scope: "other-connection" });assert.equal(native, 2);
});

test("Messages recovery holds error admission until the one bounded retry and leaves input unchanged", async () => {
  const service = createContextCompactionService({ recordUsageFn() {} }), input = serviceInput("messages"), before = structuredClone(input.body), forwarded = [], calls = [];
  const response = await service.run({ ...input, options: { onUpstreamErrorHeaders: value => forwarded.push(value) },
    native: async (body, options) => { calls.push(body);if (calls.length === 1) { options.onUpstreamErrorHeaders(400);return sourceLimit(); }return Response.json({ type: "message", content: [{ type: "text", text: "summary" }] }); },
    summarize: async () => ({ text: "verified old work", usage: {} }) });
  assert.equal(response.status, 200);assert.equal(calls.length, 2);assert.deepEqual(input.body, before);assert.deepEqual(forwarded, []);
  assert.strictEqual(calls[1].messages[0], input.body.messages[0]);assert.equal(service.snapshot().last.usage_state, "partial");
});

test("auth, quota and unrelated parameter failures are not compressed or retried", async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    let summaries = 0;const forwarded = [], response = Response.json({ error: { type: "invalid_request_error", message: "unrelated parameter" } }, { status, headers: { "retry-after": "17" } });
    const result = await createContextCompactionService().run({ ...serviceInput("messages"), native: async (_body, options) => { options.onUpstreamErrorHeaders(status);return response; },
      summarize: () => { summaries++; }, options: { onUpstreamErrorHeaders: status => forwarded.push(status) } });
    assert.strictEqual(result, response);assert.equal(summaries, 0);assert.deepEqual(forwarded, [status]);assert.equal(result.headers.get("retry-after"), "17");
  }
});

test("a failed compressed retry ends the gateway recovery instead of recursively compressing", async () => {
  let native = 0, summaries = 0;
  await assert.rejects(createContextCompactionService({ recordUsageFn() {} }).run({ ...serviceInput("messages"), native: async () => { native++;return sourceLimit(); },
    summarize: async () => { summaries++;return { text: "condensed", usage: {} }; } }), { code: "ccdx_compaction_still_rejected" });
  assert.equal(native, 2);assert.equal(summaries, 1);
});

test("application classification uses explicit protocol metadata", () => {
  assert.equal(isCompactionRequest("messages", {}, { "x-claude-code-request-class": "compaction" }), true);
  assert.equal(isCompactionRequest("messages", { messages: [{ role: "user", content: "compact the conversation" }] }), false);
  assert.equal(isCompactionRequest("gemini", { requestType: "summarization" }), true);assert.equal(isCompactionRequest("gemini", { requestType: "agent" }), false);
});

test("partial summary usage is retained once when the source stream fails", async () => {
  const records = [], service = createContextCompactionService({ recordUsageFn: value => records.push(value) });
  await assert.rejects(service.run({ ...serviceInput("messages"), native: async () => sourceLimit(), summarize: async (_text, options) => {
    options.onUsage({ input_tokens: 8, input_tokens_details: { cached_tokens: 0 } });throw new Error("stream ended");
  } }), { code: "ccdx_compaction_failed" });
  assert.equal(records.length, 1);assert.equal(records[0].usage.input_tokens, 8);assert.equal(records[0].usage.output_tokens, undefined);assert.equal(records[0].usage.cached_input_tokens, 0);
});

test("native authentication and local parameter exceptions retain their original status", async () => {
  for (const statusCode of [400, 401, 403, 429, 503]) {
    const error = Object.assign(new Error("native refusal"), { statusCode, code: "ccdx_api_refusal" });let summaries = 0;
    await assert.rejects(createContextCompactionService().run({ ...serviceInput("messages"), native: async () => { throw error; }, summarize() { summaries++; } }), value => value === error);
    assert.equal(summaries, 0);
  }
});

test("a failed terminal still exposes returned partial usage to the compression ledger", async () => {
  const samples = [], response = new Response('data: '+JSON.stringify({ type: "response.incomplete", response: { usage: { input_tokens: 17, output_tokens: 4 } } })+'\n\n', { headers: { "content-type": "text/event-stream" } });
  await assert.rejects(readCompactionSummary(response, "responses", { onUsage: value => samples.push(value) }), { code: "ccdx_compaction_result_invalid" });
  assert.equal(samples.at(-1).input_tokens, 17);assert.equal(samples.at(-1).output_tokens, 4);
});
