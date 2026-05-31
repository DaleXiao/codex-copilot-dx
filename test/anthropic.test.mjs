import { test } from "node:test";
import assert from "node:assert/strict";
import { mapStopReason, anthropicToChat } from "../src/anthropic.mjs";

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
