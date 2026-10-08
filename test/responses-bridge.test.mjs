import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { prepareResponsesChatPayload } from "../src/responses-chat-payload.mjs";
import { forwardToChat, responsesToChat } from "../src/responses-bridge.mjs";

test("responsesToChat: preserves flat Responses function tools", () => {
  const converted = responsesToChat({
    model: "gpt-4o",
    input: "hello",
    tools: [{
      type: "function",
      name: "lookup",
      description: "Look something up",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      strict: true,
    }],
  });

  assert.deepEqual(converted.tools, [{
    type: "function",
    function: {
      name: "lookup",
      description: "Look something up",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      strict: true,
    },
  }]);
});

test("responsesToChat: preserves image detail", () => {
  const converted = responsesToChat({
    model: "gpt-4o",
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "inspect" },
        { type: "input_image", image_url: "data:image/png;base64,YQ==", detail: "high" },
      ],
    }],
  });

  assert.deepEqual(converted.messages[0].content, [
    { type: "text", text: "inspect" },
    { type: "image_url", image_url: { url: "data:image/png;base64,YQ==", detail: "high" } },
  ]);
});

test("responsesToChat: preserves top-level and Anthropic base64 images as user image messages", () => {
  const converted = responsesToChat({
    model: "gpt-4o",
    input: [
      { type: "input_image", image_url: "data:image/png;base64,YQ==", detail: "high" },
      { type: "image_url", image_url: { url: "https://example.test/image.webp", detail: "low" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "Yg==" } },
    ],
  });

  assert.deepEqual(converted.messages, [
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,YQ==", detail: "high" } }] },
    { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/image.webp", detail: "low" } }] },
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,Yg==" } }] },
  ]);
});

test("prepareResponsesChatPayload fast-path serializes a 20MiB text Chat body only once", async () => {
  const largeText = "x".repeat(20 * 1024 * 1024);
  const body = {
    model: "gpt-4o",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: largeText }] }],
  };
  const originalStringify = JSON.stringify;
  let largeChatSerializations = 0;
  let responsesSerializations = 0;
  JSON.stringify = function countedStringify(value, ...args) {
    if (value?.messages?.[0]?.content === largeText) largeChatSerializations += 1;
    if (value?.input === body.input) responsesSerializations += 1;
    return originalStringify.call(this, value, ...args);
  };

  let payload;
  try {
    payload = await prepareResponsesChatPayload({ body, currentInputStart: 0 }, {
      payloadOptions: { maxBytes: 30 * 1024 * 1024 },
      stream: false,
    });
  } finally {
    JSON.stringify = originalStringify;
  }

  assert.equal(largeChatSerializations, 1);
  assert.equal(responsesSerializations, 0);
  assert.equal(payload.bodyText, originalStringify(payload.chatReq));
});

test("prepareResponsesChatPayload keeps trimming positive-saving history until the final Chat body fits", async () => {
  const historyImage = (digit) => ({
    type: "input_image",
    image_url: `data:image/png;base64,${String(digit).repeat(2000)}`,
  });
  const body = {
    model: "gpt-4o",
    input: [
      historyImage(1),
      historyImage(2),
      historyImage(3),
      { type: "function_call_output", call_id: "call_large", output: "x".repeat(2000) },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
  };

  const payload = await prepareResponsesChatPayload({ body, currentInputStart: 4 }, {
    payloadOptions: {
      maxBytes: 550,
      profiles: [],
      optimizeImage: async (dataUrl) => dataUrl,
    },
    stream: false,
  });

  assert.equal(payload.bodyBytes, Buffer.byteLength(payload.bodyText));
  assert.ok(payload.bodyBytes <= 550);
  assert.equal(body.input[4].content[0].text, "continue");
  assert.ok(body.input.slice(0, 3).every((item) => item.type === "message"));
  assert.match(body.input[3].output, /earlier tool output omitted/);
});

test("forwardToChat: emits stable mixed text and tool output indexes with usage", async () => {
  const chunks = [
    { model: "gpt-4o", choices: [{ delta: { content: "hello" } }] },
    { model: "gpt-4o", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "look", arguments: "{\"q\":" } }] } }] },
    { model: "gpt-4o", choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "up", arguments: "\"x\"}" } }] } }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 7 } } },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  const events = [];
  let done = false;
  let failure = null;
  let releaseCalls = 0;

  await forwardToChat(
    { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream_options: { opaque: "keep" } },
    async (event, data) => events.push({ event, data }),
    () => { done = true; },
    (statusCode, message) => { failure = { statusCode, message }; },
    {
      chatCompletionsFn: async (request) => {
        assert.deepEqual(request.stream_options, { opaque: "keep", include_usage: true });
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      },
      releaseRequest: () => { releaseCalls += 1; },
    },
  );

  assert.equal(done, true);
  assert.equal(failure, null);
  assert.equal(releaseCalls, 1);
  const added = events.filter(({ event }) => event === "response.output_item.added");
  assert.deepEqual(added.map(({ data }) => data.output_index), [0, 1]);
  assert.deepEqual(added.map(({ data }) => data.item.type), ["message", "function_call"]);
  const completed = events.find(({ event }) => event === "response.completed").data.response;
  assert.deepEqual(completed.output.map((item) => item.type), ["message", "function_call"]);
  assert.equal(completed.output[1].name, "lookup");
  assert.equal(completed.output[1].arguments, "{\"q\":\"x\"}");
  assert.deepEqual(completed.usage, {
    input_tokens: 10,
    output_tokens: 4,
    total_tokens: 14,
    input_tokens_details: { cached_tokens: 7 },
  });
});

test("forwardToChat: preserves streaming upstream errors", async () => {
  let failure;
  await forwardToChat(
    { model: "gpt-4o", messages: [] },
    async () => {},
    () => {},
    (statusCode, message) => { failure = { statusCode, message }; },
    { chatCompletionsFn: async () => new Response("rate limited", { status: 429 }) },
  );
  assert.deepEqual(failure, { statusCode: 429, message: "rate limited" });
});

test("forwardToChat cancels upstream without an error event when downstream closes", async () => {
  let cancelled = false;
  let done = false;
  let failure = null;
  const upstream = new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"unused"}}]}\n\n'));
    },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } });

  const result = await forwardToChat(
    { model: "gpt-4o", messages: [] },
    async () => false,
    () => { done = true; },
    (statusCode, message) => { failure = { statusCode, message }; },
    { chatCompletionsFn: async () => upstream },
  );

  assert.equal(result, false);
  assert.equal(cancelled, true);
  assert.equal(done, false);
  assert.equal(failure, null);
});

test("forwardToChat: emits a completed empty message for an empty successful stream", async () => {
  const events = [];
  await forwardToChat(
    { model: "gpt-4o", messages: [] },
    async (event, data) => events.push({ event, data }),
    () => {},
    () => assert.fail("empty stream should not fail"),
    { chatCompletionsFn: async () => new Response("data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } }) },
  );

  const response = events.find(({ event }) => event === "response.completed").data.response;
  assert.equal(response.output.length, 1);
  assert.equal(response.output[0].type, "message");
  assert.equal(response.output[0].content[0].text, "");
});

test("forwardToChat: streaming length and content_filter finish reasons remain incomplete", async () => {
  for (const [finishReason, reason] of [["length", "max_output_tokens"], ["content_filter", "content_filter"]]) {
    const events = [];
    const wire = [
      { choices: [{ delta: { content: "partial" } }] },
      { choices: [{ delta: {}, finish_reason: finishReason }] },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    const result = await forwardToChat(
      { model: "gpt-4o", messages: [] },
      async (event, data) => { events.push({ event, data }); },
      () => {},
      () => assert.fail("known incomplete finish reason must not become a transport error"),
      { chatCompletionsFn: async () => new Response(wire, { headers: { "Content-Type": "text/event-stream" } }) },
    );
    assert.equal(result, false);
    assert.equal(events.some(({ event }) => event === "response.completed"), false);
    const terminal = events.find(({ event }) => event === "response.incomplete")?.data.response;
    assert.equal(terminal?.status, "incomplete");
    assert.deepEqual(terminal?.incomplete_details, { reason });
    assert.equal(terminal?.output[0]?.status, "incomplete");
  }
});
