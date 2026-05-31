import { test } from "node:test";
import assert from "node:assert/strict";
import { mapStopReason, anthropicToChat, chatToAnthropic, countTokens } from "../src/anthropic.mjs";
import { streamAnthropicFromLines } from "../src/anthropic.mjs";

test("mapStopReason: 四种映射", () => {
  assert.equal(mapStopReason("stop"), "end_turn");
  assert.equal(mapStopReason("tool_calls"), "tool_use");
  assert.equal(mapStopReason("length"), "max_tokens");
  assert.equal(mapStopReason(undefined), "end_turn");
});

test("anthropicToChat: system 字符串 → system message", () => {
  const r = anthropicToChat({ model: "m", system: "be nice", messages: [{ role: "user", content: "hi" }], max_tokens: 10 });
  assert.deepEqual(r.messages[0], { role: "system", content: "be nice" });
  assert.equal(r.messages[1].role, "user");
  assert.equal(r.messages[1].content, "hi");
  assert.equal(r.max_tokens, 10);
  assert.equal(r.model, "m");
});

test("anthropicToChat: system 数组 → 拼接", () => {
  const r = anthropicToChat({ model: "m", system: [{ type: "text", text: "a" }, { type: "text", text: "b" }], messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.messages[0].content, "a\nb");
});

test("anthropicToChat: text content block", () => {
  const r = anthropicToChat({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "yo" }] }] });
  assert.equal(r.messages[0].role, "user");
  assert.equal(r.messages[0].content, "yo");
});

test("anthropicToChat: image block → image_url data URI", () => {
  const r = anthropicToChat({ model: "m", messages: [{ role: "user", content: [
    { type: "text", text: "look" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
  ] }] });
  const parts = r.messages[0].content;
  assert.ok(Array.isArray(parts));
  assert.deepEqual(parts[0], { type: "text", text: "look" });
  assert.equal(parts[1].type, "image_url");
  assert.equal(parts[1].image_url.url, "data:image/png;base64,AAAA");
});

test("anthropicToChat: tool_use block → assistant tool_calls", () => {
  const r = anthropicToChat({ model: "m", messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "get_x", input: { a: 1 } }] },
  ] });
  const m = r.messages[0];
  assert.equal(m.role, "assistant");
  assert.equal(m.tool_calls[0].id, "tu_1");
  assert.equal(m.tool_calls[0].type, "function");
  assert.equal(m.tool_calls[0].function.name, "get_x");
  assert.equal(m.tool_calls[0].function.arguments, JSON.stringify({ a: 1 }));
});

test("anthropicToChat: tool_result block → tool message", () => {
  const r = anthropicToChat({ model: "m", messages: [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "42" }] },
  ] });
  const m = r.messages[0];
  assert.equal(m.role, "tool");
  assert.equal(m.tool_call_id, "tu_1");
  assert.equal(m.content, "42");
});

test("anthropicToChat: tools input_schema → function.parameters", () => {
  const r = anthropicToChat({ model: "m", messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "get_x", description: "d", input_schema: { type: "object", properties: { a: { type: "string" } } } }] });
  assert.equal(r.tools[0].type, "function");
  assert.equal(r.tools[0].function.name, "get_x");
  assert.equal(r.tools[0].function.description, "d");
  assert.deepEqual(r.tools[0].function.parameters, { type: "object", properties: { a: { type: "string" } } });
});

test("anthropicToChat: tool_choice 映射", () => {
  assert.equal(anthropicToChat({ model: "m", messages: [], tool_choice: { type: "auto" } }).tool_choice, "auto");
  assert.equal(anthropicToChat({ model: "m", messages: [], tool_choice: { type: "any" } }).tool_choice, "required");
  assert.deepEqual(anthropicToChat({ model: "m", messages: [], tool_choice: { type: "tool", name: "get_x" } }).tool_choice,
    { type: "function", function: { name: "get_x" } });
});

test("anthropicToChat: stop_sequences → stop, 透传采样参数", () => {
  const r = anthropicToChat({ model: "m", messages: [{ role: "user", content: "hi" }], stop_sequences: ["X"], temperature: 0.5, top_p: 0.9 });
  assert.deepEqual(r.stop, ["X"]);
  assert.equal(r.temperature, 0.5);
  assert.equal(r.top_p, 0.9);
});

test("anthropicToChat: image url-type source → 直接用 url", () => {
  const r = anthropicToChat({ model: "m", messages: [{ role: "user", content: [
    { type: "image", source: { type: "url", url: "https://example.com/x.png" } },
  ] }] });
  const parts = r.messages[0].content;
  assert.equal(parts[0].type, "image_url");
  assert.equal(parts[0].image_url.url, "https://example.com/x.png");
});

test("chatToAnthropic: 纯文本响应", () => {
  const openai = { model: "Claude", choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 9, completion_tokens: 2 } };
  const a = chatToAnthropic(openai, "claude-sonnet-4.5");
  assert.equal(a.type, "message");
  assert.equal(a.role, "assistant");
  assert.deepEqual(a.content, [{ type: "text", text: "hello" }]);
  assert.equal(a.stop_reason, "end_turn");
  assert.equal(a.usage.input_tokens, 9);
  assert.equal(a.usage.output_tokens, 2);
  assert.ok(a.id);
});

test("chatToAnthropic: tool_use 响应", () => {
  const openai = { choices: [{ message: { content: null, tool_calls: [
    { id: "tu_1", function: { name: "get_x", arguments: '{"a":1}' } },
  ] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3 } };
  const a = chatToAnthropic(openai, "m");
  assert.equal(a.content[0].type, "tool_use");
  assert.equal(a.content[0].id, "tu_1");
  assert.equal(a.content[0].name, "get_x");
  assert.deepEqual(a.content[0].input, { a: 1 });
  assert.equal(a.stop_reason, "tool_use");
});

test("chatToAnthropic: 文本+工具混合", () => {
  const openai = { choices: [{ message: { content: "let me check", tool_calls: [
    { id: "tu_2", function: { name: "f", arguments: "{}" } },
  ] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  const a = chatToAnthropic(openai, "m");
  assert.equal(a.content[0].type, "text");
  assert.equal(a.content[0].text, "let me check");
  assert.equal(a.content[1].type, "tool_use");
});

test("chatToAnthropic: cached_tokens → cache_read_input_tokens", () => {
  const openai = { choices: [{ message: { content: "x" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 30 } } };
  const a = chatToAnthropic(openai, "m");
  assert.equal(a.usage.input_tokens, 70);
  assert.equal(a.usage.cache_read_input_tokens, 30);
});

async function collect(lines, model = "m") {
  async function* gen() { for (const l of lines) yield l; }
  const events = [];
  await streamAnthropicFromLines(gen(), (event, data) => events.push([event, data]), model);
  return events;
}

test("streamAnthropicFromLines: 纯文本流", async () => {
  const lines = [
    'data: {"model":"claude","choices":[{"delta":{"content":"He"}}]}',
    'data: {"choices":[{"delta":{"content":"llo"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
  ];
  const ev = await collect(lines);
  const types = ev.map((e) => e[0]);
  assert.deepEqual(types, [
    "message_start", "content_block_start", "content_block_delta", "content_block_delta",
    "content_block_stop", "message_delta", "message_stop",
  ]);
  assert.equal(ev[2][1].delta.text, "He");
  assert.equal(ev[3][1].delta.text, "llo");
  assert.equal(ev[5][1].delta.stop_reason, "end_turn");
});

test("streamAnthropicFromLines: 工具调用流", async () => {
  const lines = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tu_1","function":{"name":"get_x","arguments":""}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ];
  const ev = await collect(lines);
  const types = ev.map((e) => e[0]);
  const startTool = ev.find((e) => e[0] === "content_block_start" && e[1].content_block.type === "tool_use");
  assert.ok(startTool);
  assert.equal(startTool[1].content_block.name, "get_x");
  assert.equal(startTool[1].content_block.id, "tu_1");
  const jsonDeltas = ev.filter((e) => e[0] === "content_block_delta" && e[1].delta.type === "input_json_delta");
  assert.equal(jsonDeltas.map((e) => e[1].delta.partial_json).join(""), '{"a":1}');
  const md = ev.find((e) => e[0] === "message_delta");
  assert.equal(md[1].delta.stop_reason, "tool_use");
  assert.equal(types[types.length - 1], "message_stop");
});

test("streamAnthropicFromLines: stream_options usage chunk 被采纳", async () => {
  const lines = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: {"choices":[],"usage":{"completion_tokens":7}}',
    'data: [DONE]',
  ];
  const ev = await collect(lines);
  const md = ev.find((e) => e[0] === "message_delta");
  assert.equal(md[1].usage.output_tokens, 7);
});

test("streamAnthropicFromLines: 工具后的文本不再开新块", async () => {
  const lines = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tu_1","function":{"name":"f","arguments":"{}"}}]}}]}',
    'data: {"choices":[{"delta":{"content":"trailing text"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ];
  const ev = await collect(lines);
  // 不应出现 type:text 的 content_block_start
  const textStart = ev.find((e) => e[0] === "content_block_start" && e[1].content_block.type === "text");
  assert.equal(textStart, undefined);
  // 末尾顺序正常
  assert.equal(ev[ev.length - 1][0], "message_stop");
});

test("countTokens: 返回正整数 input_tokens", () => {
  const r = countTokens({ model: "m", messages: [{ role: "user", content: "hello world how many tokens is this" }] });
  assert.equal(typeof r.input_tokens, "number");
  assert.ok(r.input_tokens > 0);
});

test("countTokens: 更多内容 → 更多 token(单调)", () => {
  const small = countTokens({ model: "m", messages: [{ role: "user", content: "hi" }] }).input_tokens;
  const big = countTokens({ model: "m", system: "you are a helpful assistant with many rules",
    tools: [{ name: "t", description: "a tool", input_schema: { type: "object", properties: { x: { type: "string" } } } }],
    messages: [{ role: "user", content: "hello world this is a much longer message with more tokens" }] }).input_tokens;
  assert.ok(big > small);
});

test("countTokens: 确定性(同输入同输出)", () => {
  const body = { model: "m", messages: [{ role: "user", content: "stable input" }] };
  assert.equal(countTokens(body).input_tokens, countTokens(body).input_tokens);
});
