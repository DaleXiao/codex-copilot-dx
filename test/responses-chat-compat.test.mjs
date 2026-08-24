import test from "node:test";
import assert from "node:assert/strict";
import { responsesToChat } from "../src/responses-bridge.mjs";

test("responsesToChat: rejects tools that Chat Completions cannot represent", () => {
  for (const tool of [
    { type: "web_search_preview" },
    { type: "computer_use_preview", display_width: 1024, display_height: 768 },
    { type: "mcp", server_label: "docs", server_url: "https://example.test/mcp" },
  ]) {
    assert.throws(
      () => responsesToChat({ model: "m", input: "hello", tools: [tool] }),
      (error) => error.statusCode === 400
        && error.code === "ccdx_responses_chat_incompatible"
        && error.jsonBody?.error?.item_type === tool.type,
    );
  }
});

test("responsesToChat: rejects input items that Chat Completions cannot represent", () => {
  const item = { type: "reasoning", id: "rs_1", summary: [] };
  assert.throws(
    () => responsesToChat({ model: "m", input: [item] }),
    (error) => error.statusCode === 400
      && error.code === "ccdx_responses_chat_incompatible"
      && error.jsonBody?.error?.item_type === "reasoning",
  );
});

test("responsesToChat: preserves easy input messages whose type is omitted", () => {
  const chat = responsesToChat({
    model: "m",
    input: [
      { role: "system", content: "Be exact" },
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      { role: "assistant", content: "hi" },
    ],
  });

  assert.deepEqual(chat.messages, [
    { role: "system", content: "Be exact" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ]);
});

test("responsesToChat: batches adjacent parallel calls and preserves call/output order", () => {
  const chat = responsesToChat({
    model: "m",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "check both" }] },
      { type: "function_call", call_id: "call_first", name: "first", arguments: "{\"n\":1}" },
      { type: "function_call", call_id: "call_second", name: "second", arguments: "{\"n\":2}" },
      { type: "function_call_output", call_id: "call_first", output: { value: 1 } },
      { type: "function_call_output", call_id: "call_second", output: { value: 2 } },
    ],
  });

  assert.equal(chat.messages.length, 4);
  assert.deepEqual(chat.messages[1], {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call_first", type: "function", function: { name: "first", arguments: "{\"n\":1}" } },
      { id: "call_second", type: "function", function: { name: "second", arguments: "{\"n\":2}" } },
    ],
  });
  assert.deepEqual(chat.messages.slice(2), [
    { role: "tool", tool_call_id: "call_first", content: "{\"value\":1}" },
    { role: "tool", tool_call_id: "call_second", content: "{\"value\":2}" },
  ]);
});
