import test, { after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { proxyCopilotResponses } from "../src/responses-proxy.mjs";
import { prepareResponsesRequest } from "../src/responses-request.mjs";
import { clearResponseHistoryForTests, responseHistoryStats } from "../src/response-history.mjs";

const previousUsageDisabled = process.env.CCDX_DISABLE_USAGE;
process.env.CCDX_DISABLE_USAGE = "1";
beforeEach(() => clearResponseHistoryForTests());
afterEach(() => clearResponseHistoryForTests());
after(() => {
  if (previousUsageDisabled === undefined) delete process.env.CCDX_DISABLE_USAGE;
  else process.env.CCDX_DISABLE_USAGE = previousUsageDisabled;
});

function message(id, text, phase = "commentary") {
  return {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    phase,
    content: [{
      type: "output_text",
      text,
      annotations: [{ type: "url_citation", url: "https://example.test/identity", title: "Evidence", start_index: 0, end_index: 2 }],
      future_content_field: { preserve: true },
    }],
    future_message_field: ["preserve", 7],
  };
}

function lifecycle({ index = 0, start = "A", middle = "X", end = "B", phase = "commentary", text = "我先验证 1 + 1。" } = {}) {
  const item = message(end, text, phase);
  return [
    { type: "response.output_item.added", output_index: index, item: { ...message(start, "", phase), status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: index, content_index: 0, item_id: middle, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: index, content_index: 0, item_id: middle, delta: text.slice(0, 5), logprobs: [] },
    { type: "response.output_text.annotation.added", output_index: index, content_index: 0, item_id: middle, annotation_index: 0, annotation: item.content[0].annotations[0] },
    { type: "response.output_text.delta", output_index: index, content_index: 0, item_id: `${middle}-last`, delta: text.slice(5), logprobs: [] },
    { type: "response.output_text.done", output_index: index, content_index: 0, item_id: end, text, logprobs: [] },
    { type: "response.content_part.done", output_index: index, content_index: 0, item_id: end, part: item.content[0] },
    { type: "response.output_item.done", output_index: index, item },
  ];
}

function terminal(id, output, status = "completed") {
  return { type: `response.${status}`, response: { id, object: "response", status, output } };
}

function numbered(events) {
  return events.map((event, sequence_number) => ({ ...event, sequence_number }));
}

function sse(events) {
  return Buffer.from(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
}

function readEvents(wire) {
  return wire.toString("utf8").split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    return data ? [JSON.parse(data)] : [];
  });
}

async function invokeNative(events, { wire = sse(events), chunkBytes = wire.byteLength, request = {} } = {}) {
  const context = prepareResponsesRequest({ model: "gpt-6-astra", input: "1 + 1?", stream: true, ...request }, { copilotBoundary: false });
  context.surface = "responses";
  const writes = [];
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.headersSent = false;
  res.writeHead = () => { res.headersSent = true; };
  res.write = (value) => { writes.push(Buffer.from(value)); return true; };
  res.end = () => { res.writableEnded = true; };
  let offset = 0;
  let cancelled = false;
  let sent;
  const result = await proxyCopilotResponses(context, {}, res, async (body) => {
    sent = structuredClone(body);
    return new Response(new ReadableStream({
      pull(controller) {
        if (offset === wire.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(wire.byteLength, offset + chunkBytes);
        controller.enqueue(wire.subarray(offset, end));
        offset = end;
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: { "Content-Type": "text/event-stream" } });
  });
  const forwarded = Buffer.concat(writes);
  return { result, wire: forwarded, events: readEvents(forwarded), sent, cancelled };
}

test("native message identity uses the added ID for every message event and completed output", async () => {
  const text = "我先验证 1 + 1。";
  const input = numbered([...lifecycle({ text }), terminal("resp_identity", [message("B", text)])]);
  const expected = structuredClone(input);
  for (const index of [1, 2, 3, 4, 5, 6]) expected[index].item_id = "A";
  expected[7].item.id = "A";
  expected[8].response.output[0].id = "A";

  const result = await invokeNative(input, { chunkBytes: 7 });

  assert.deepEqual(result.events, expected);
  assert.deepEqual(result.result, { successful: true, compacted: false });
  assert.equal(result.cancelled, true);
});

test("native identity preserves full output indexes, phases, opaque tool state, usage, and Fast request fields", async () => {
  const reasoning = { type: "reasoning", id: "reasoning-done", encrypted_content: "opaque-reasoning", summary: [{ type: "summary_text", text: "thinking" }] };
  const tool = { type: "function_call", id: "tool-done", call_id: "call-unchanged", name: "audit_ping", arguments: '{"n":1}', status: "completed", encrypted_content: "opaque-tool" };
  const commentary = message("commentary-done", "我先验证。", "commentary");
  const final = message("final-done", "答案是 2。", "final_answer");
  const end = terminal("resp_mixed_identity", [reasoning, commentary, tool, final]);
  end.response.usage = { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 5 }, future_usage: { preserve: true } };
  end.response.service_tier = "priority";
  const input = numbered([
    { type: "response.output_item.added", output_index: 0, item: { ...reasoning, id: "reasoning-start", summary: [] } },
    { type: "response.output_item.added", output_index: 1, item: { ...commentary, id: "commentary-start", content: [], status: "in_progress" } },
    { type: "response.output_item.added", output_index: 2, item: { ...tool, id: "tool-start", arguments: "", status: "in_progress" } },
    { type: "response.output_text.delta", output_index: 1, content_index: 0, item_id: "commentary-delta", delta: commentary.content[0].text },
    { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, item_id: "reasoning-delta", delta: "thinking" },
    { type: "response.function_call_arguments.delta", output_index: 2, item_id: "tool-delta", delta: tool.arguments },
    { type: "response.output_item.added", output_index: 3, item: { ...final, id: "final-start", content: [], status: "in_progress" } },
    { type: "response.output_item.done", output_index: 1, item: commentary },
    { type: "response.output_text.delta", output_index: 3, content_index: 0, item_id: "final-delta", delta: final.content[0].text },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.function_call_arguments.done", output_index: 2, item_id: "tool-done", arguments: tool.arguments },
    { type: "response.output_item.done", output_index: 2, item: tool },
    { type: "response.output_item.done", output_index: 3, item: final },
    end,
  ]);
  const expected = structuredClone(input);
  expected[3].item_id = "commentary-start";
  expected[7].item.id = "commentary-start";
  expected[8].item_id = "final-start";
  expected[12].item.id = "final-start";
  expected[13].response.output[1].id = "commentary-start";
  expected[13].response.output[3].id = "final-start";
  const request = { model: "gpt-5.6-sol", service_tier: "priority", reasoning: { effort: "xhigh" }, parallel_tool_calls: true };

  const result = await invokeNative(input, { chunkBytes: 31, request });

  assert.deepEqual(result.events, expected);
  assert.equal(result.sent.model, request.model);
  assert.equal(result.sent.service_tier, request.service_tier);
  assert.deepEqual(result.sent.reasoning, request.reasoning);
  assert.equal(result.sent.parallel_tool_calls, true);
});

test("native normalized message IDs agree with previous_response_id and explicit full-history continuation", async () => {
  const text = "我先验证 1 + 1。";
  const first = await invokeNative(numbered([...lifecycle({ text }), terminal("resp_history_identity", [message("B", text)])]));
  const storedOutput = first.events.at(-1).response.output;
  assert.equal(storedOutput[0].id, "A");
  assert.equal(responseHistoryStats().entries, 1);

  const previous = await invokeNative([terminal("resp_previous_continuation", [])], {
    request: { previous_response_id: "resp_history_identity", input: "继续" },
  });
  const explicitInput = [...first.sent.input, ...storedOutput, { type: "message", role: "user", content: [{ type: "input_text", text: "继续" }] }];
  const explicit = await invokeNative([terminal("resp_full_continuation", [])], { request: { input: explicitInput } });

  assert.deepEqual(previous.sent.input, explicitInput);
  assert.deepEqual(explicit.sent.input, explicitInput);
  assert.equal(previous.sent.previous_response_id, undefined);
  assert.equal(previous.sent.input.filter((item) => item.role === "assistant").length, 1);
});

test("native refusal events keep the original message identity without changing refusal content", async () => {
  const item = { type: "message", id: "refusal-done", role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "refusal", refusal: "cannot comply" }] };
  const input = numbered([
    { type: "response.output_item.added", output_index: 0, item: { ...item, id: "refusal-start", content: [], status: "in_progress" } },
    { type: "response.refusal.delta", output_index: 0, content_index: 0, item_id: "refusal-delta", delta: "cannot comply" },
    { type: "response.refusal.done", output_index: 0, content_index: 0, item_id: "refusal-done", refusal: "cannot comply" },
    { type: "response.output_item.done", output_index: 0, item },
    terminal("resp_refusal_identity", [item]),
  ]);
  const expected = structuredClone(input);
  expected[1].item_id = "refusal-start";
  expected[2].item_id = "refusal-start";
  expected[3].item.id = "refusal-start";
  expected[4].response.output[0].id = "refusal-start";

  assert.deepEqual((await invokeNative(input)).events, expected);
});

test("native identity does not merge missing or invalid indexes and does not rewrite unknown output types", async () => {
  const input = numbered([
    { type: "response.output_item.added", output_index: 0, item: { ...message("known-message", ""), content: [], status: "in_progress" } },
    { type: "response.output_text.delta", item_id: "missing-index", delta: "missing" },
    { type: "response.output_text.delta", output_index: -1, item_id: "negative-index", delta: "negative" },
    { type: "response.output_text.delta", output_index: "0", item_id: "string-index", delta: "string" },
    { type: "response.output_text.delta", output_index: 0.5, item_id: "fractional-index", delta: "fractional" },
    { type: "response.future_output.delta", output_index: 0, item_id: "unknown-message-event", delta: "preserve" },
    { type: "response.output_item.done", item: message("unindexed-done", "unindexed") },
    { type: "response.output_item.added", output_index: 1, item: { type: "future_output", id: "future-added", opaque: "preserve" } },
    { type: "response.future_output.delta", output_index: 1, item_id: "future-delta", delta: "preserve" },
    { type: "response.output_item.done", output_index: 1, item: { type: "future_output", id: "future-done", opaque: "preserve" } },
    terminal("resp_unknown_identity", []),
  ]);

  const result = await invokeNative(input, { chunkBytes: 13 });

  assert.deepEqual(result.events, input);
  assert.deepEqual(result.wire, sse(input));
});

test("native streams without a valid message added ID remain unchanged", async () => {
  for (const id of [undefined, "", 123]) {
    const item = message("unbound-done", "unchanged");
    const input = numbered([
      ...(id === undefined ? [] : [{ type: "response.output_item.added", output_index: 0, item: { ...item, id, content: [], status: "in_progress" } }]),
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "unbound-delta", delta: "unchanged" },
      { type: "response.output_item.done", output_index: 0, item },
      terminal(`resp_unbound_${id}`, [item]),
    ]);

    const result = await invokeNative(input);

    assert.deepEqual(result.wire, sse(input));
    assert.deepEqual(result.events, input);
  }
});

test("native stable IDs retain exact SSE bytes including multiline data and CRLF metadata", async () => {
  const input = numbered([...lifecycle({ start: "stable", middle: "stable", end: "stable" }), terminal("resp_stable_identity", [message("stable", "我先验证 1 + 1。")])]);
  input[4].item_id = "stable";
  const wire = Buffer.from(input.map((event, index) => [
    `: keep comment ${index}`,
    `id: packet-${index}`,
    "retry: 1000",
    `event: ${event.type}`,
    ...JSON.stringify(event, null, 2).split("\n").map((line) => `data: ${line}`),
    "",
    "",
  ].join("\r\n")).join(""));

  const result = await invokeNative(input, { wire, chunkBytes: 1 });

  assert.deepEqual(result.wire, wire);
  assert.deepEqual(result.events, input);
});

test("native incomplete and failed snapshots use stable message IDs without caching unsuccessful history", async () => {
  for (const status of ["incomplete", "failed"]) {
    const item = { ...message(`${status}-done`, "partial"), status: "incomplete" };
    const end = terminal(`resp_identity_${status}`, [item], status);
    if (status === "incomplete") end.response.incomplete_details = { reason: "max_output_tokens" };
    else end.response.error = { code: "server_error", message: "upstream failed" };
    const input = numbered([
      { type: "response.output_item.added", output_index: 0, item: { ...item, id: `${status}-start`, content: [], status: "in_progress" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: `${status}-delta`, delta: "partial" },
      end,
    ]);
    const expected = structuredClone(input);
    expected[1].item_id = `${status}-start`;
    expected[2].response.output[0].id = `${status}-start`;

    const result = await invokeNative(input, { chunkBytes: 7 });

    assert.deepEqual(result.events, expected);
    assert.deepEqual(result.result, { successful: false, compacted: false });
    assert.equal(responseHistoryStats().entries, 0);
  }
});

test("native message identity maps remain isolated across concurrent responses with the same output index", async () => {
  const inputs = ["left", "right"].map((name) => numbered([
    ...lifecycle({ start: `${name}-start`, middle: `${name}-delta`, end: `${name}-done`, text: `${name} answer` }),
    terminal(`resp_${name}_identity`, [message(`${name}-done`, `${name} answer`)]),
  ]));

  const results = await Promise.all(inputs.map((events) => invokeNative(events, { chunkBytes: 1 })));

  for (const [index, name] of ["left", "right"].entries()) {
    const events = results[index].events;
    assert.equal(events[0].item.id, `${name}-start`);
    assert.deepEqual(events.filter((event) => event.item_id).map((event) => event.item_id), Array(6).fill(`${name}-start`));
    assert.equal(events[7].item.id, `${name}-start`);
    assert.equal(events.at(-1).response.output[0].id, `${name}-start`);
    const replay = prepareResponsesRequest({ model: "gpt-6-astra", previous_response_id: `resp_${name}_identity`, input: "next" }, { copilotBoundary: false });
    assert.equal(replay.body.input.find((item) => item.role === "assistant").id, `${name}-start`);
  }
});
