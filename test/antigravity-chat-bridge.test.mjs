import test from "node:test";
import assert from "node:assert/strict";
import { antigravityToChat, chatStreamToAntigravity, chatToAntigravity, parseAntigravityJSON } from "../src/antigravity-chat-bridge.mjs";

const declaration = { name: "view_file", description: "Read a file", parameters: { type: "OBJECT", properties: {
  AbsolutePath: { type: "STRING" }, offset: { type: "INTEGER" }, mode: { type: "STRING", enum: ["UPPER", "lower"] },
}, required: ["AbsolutePath"] } };

test("Gemini history retains tool IDs, large integers, images, and declared schema", () => {
  const request = parseAntigravityJSON(`{"systemInstruction":{"role":"user","parts":[{"text":"system"}]},"contents":[
    {"role":"user","parts":[{"text":"inspect"},{"inlineData":{"mimeType":"image/png","data":"aGVsbG8="}}]},
    {"role":"model","parts":[{"functionCall":{"id":"call-one","name":"view_file","args":{"AbsolutePath":"/tmp/a","offset":9007199254740993}}}]},
    {"role":"model","parts":[{"functionResponse":{"id":"call-one","name":"view_file","response":{"output":"ok","size":9007199254740993}}}]}
  ],"generationConfig":{"maxOutputTokens":64000,"thinkingConfig":{"includeThoughts":true,"thinkingBudget":0}}}`);
  request.tools = [{ functionDeclarations: [declaration] }];
  const { chat } = antigravityToChat(request, { model: "gemini-4-carbon", effort: "high" });
  assert.equal(chat.messages[0].content, "system");
  assert.deepEqual(chat.messages[1].content, [{ type: "text", text: "inspect" }, { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }]);
  assert.equal(chat.messages[2].tool_calls[0].id, "call-one");
  assert.match(chat.messages[2].tool_calls[0].function.arguments, /9007199254740993/);
  assert.match(chat.messages[3].content, /9007199254740993/);
  assert.equal(chat.messages[3].tool_call_id, "call-one");
  assert.equal(chat.tools[0].function.parameters.type, "object");
  assert.deepEqual(chat.tools[0].function.parameters.properties.mode.enum, ["UPPER", "lower"]);
  assert.equal(chat.max_completion_tokens, 64000);
  assert.equal(chat.reasoning_effort, "high");
});

test("Chat tool calls restore their original names and exact arguments", () => {
  const tool = { name: "plugin.example/read", parameters: { type: "OBJECT", properties: {} } };
  const { chat, originalNames } = antigravityToChat({ contents: [{ role: "user", parts: [{ text: "read" }] }], tools: [{ functionDeclarations: [tool] }] }, { model: "gemini-4-argon", stream: false });
  const alias = chat.tools[0].function.name;
  const result = chatToAntigravity({ choices: [{ finish_reason: "tool_calls", message: { content: null,
    tool_calls: [{ id: "call-two", function: { name: alias, arguments: '{"number":9007199254740993}' } }] } }] }, originalNames);
  assert.equal(result.candidates[0].content.parts[0].functionCall.name, tool.name);
  assert.match(JSON.stringify(result), /9007199254740993/);
  assert.throws(() => chatToAntigravity({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "call-two", function: { name: alias, arguments: "{" } }] } }] }, originalNames), /arguments/);
});

test("unsupported tools, unmatched history, and denied tool calls fail explicitly", () => {
  const user = { role: "user", parts: [{ text: "hi" }] };
  assert.throws(() => antigravityToChat({ contents: [user], tools: [{ googleSearch: {} }] }, { model: "fixture" }), /cannot be represented/);
  assert.throws(() => antigravityToChat({ contents: [user, { role: "user", parts: [{ functionResponse: { name: "view_file", response: { output: "ok" } } }] }] }, { model: "fixture" }), /no matching call/);
  const { originalNames } = antigravityToChat({ contents: [user], tools: [{ functionDeclarations: [declaration] }], toolConfig: { functionCallingConfig: { mode: "NONE" } } }, { model: "fixture" });
  assert.throws(() => chatToAntigravity({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "a", function: { name: "view_file", arguments: "{}" } }] } }] }, originalNames), /function call/);
});

test("native token budgets require an explicit advertised Copilot effort", () => {
  const request = { contents: [{ role: "user", parts: [{ text: "hello" }] }],
    generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 4096 } } };
  assert.throws(() => antigravityToChat(request, { model: "gemini-4-carbon" }), /reasoning configuration/);
  assert.equal(antigravityToChat(request, { model: "gemini-4-carbon", effort: "high" }).chat.reasoning_effort,"high");
});

test("unsupported attachments are refused rather than silently omitted", () => {
  const request = { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "application/pdf", data: "Zml4dHVyZQ==" } }] }] };
  assert.throws(()=>antigravityToChat(request,{model:"gemini-4-carbon"}),/not supported/);
  request.contents[0].parts[0].inlineData.mimeType="audio/wav";
  assert.throws(() => antigravityToChat(request, { model: "gemini-4-carbon" }), /not supported/);
});

test("stream emits text promptly and reconstructs split tool arguments without losing integers", async () => {
  const { originalNames } = antigravityToChat({ contents: [{ role: "user", parts: [{ text: "hi" }] }], tools: [{ functionDeclarations: [declaration] }] }, { model: "fixture" });
  const events = [
    { choices: [{ delta: { content: "hello" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-three", function: { name: "view_", arguments: '{"offset":9007199' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: "254740993}" } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
  ];
  const encoder = new TextEncoder(), response = new Response(new ReadableStream({ start(controller) {
    for (const event of events) controller.enqueue(encoder.encode("data: " + JSON.stringify(event) + "\n\n"));
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));controller.close();
  } }));
  const chunks = [];for await (const chunk of chatStreamToAntigravity(response, originalNames)) chunks.push(chunk);
  assert.equal(chunks[0].response.candidates[0].content.parts[0].text, "hello");
  const part = chunks[1].response.candidates[0].content.parts[0].functionCall;
  assert.equal(part.name, "view_file");assert.equal(part.id, "call-three");
  assert.match(JSON.stringify(part.args), /9007199254740993/);
  assert.equal(chunks.at(-1).response.candidates[0].finishReason, "STOP");
  assert.equal(chunks.at(-1).response.usageMetadata.totalTokenCount, 13);
});

test("stream rejects an incomplete upstream response", async () => {
  const response = new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  const received = [];
  await assert.rejects(async () => { for await (const value of chatStreamToAntigravity(response, new Map())) received.push(value); }, /ended before completion/);
  assert.equal(received[0].response.candidates[0].content.parts[0].text, "partial");
});

test("stream exposes upstream error details and does not invent a successful finish", async () => {
  const response = new Response('data: {"error":{"type":"rate_limit_error","message":"capacity unavailable"}}\n\n');
  await assert.rejects(async () => { for await (const _ of chatStreamToAntigravity(response, new Map())) {} }, /capacity unavailable/);
});

test("stream forwards text before the upstream finishes", async () => {
  const encoder = new TextEncoder();let writer;
  const response = new Response(new ReadableStream({ start(controller) { writer = controller; } }));
  const iterator = chatStreamToAntigravity(response, new Map());
  writer.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"early"}}]}\n\n'));
  const first = await iterator.next();
  assert.equal(first.value.response.candidates[0].content.parts[0].text, "early");
  writer.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
  writer.close();
  assert.equal((await iterator.next()).value.response.candidates[0].finishReason, "STOP");
  assert.equal((await iterator.next()).done, true);
});

test("thinking-only success is not reported as a completed answer", async () => {
  const source = 'data: {"choices":[{"delta":{"reasoning_content":"thinking"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  await assert.rejects(async () => { for await (const _ of chatStreamToAntigravity(new Response(source), new Map())) {} }, /completion/);
  assert.throws(() => chatToAntigravity({ choices: [{ finish_reason: "stop", message: { reasoning_content: "thinking" } }] }, new Map()), /did not complete/);
});
