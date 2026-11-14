import test from "node:test";
import assert from "node:assert/strict";
import { chatToResponses, responsesToChat } from "../src/responses-bridge.mjs";

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

test("Chat conversion cannot silently flatten deferred or namespaced functions", () => {
  const fn = { type: "function", name: "lookup", parameters: { type: "object" } };
  for (const body of [
    { input: "test", tools: [{ ...fn, defer_loading: true }] },
    { input: "test", tools: [{ ...fn, namespace: "docs" }] },
    { input: [{ type: "function_call", name: "lookup", namespace: "docs", arguments: "{}", call_id: "call_1" }] },
    { input: "test", tools: [fn], tool_choice: { type: "function", name: "lookup", namespace: "docs" } },
  ]) assert.throws(() => responsesToChat({ model: "m", ...body }), { code: "ccdx_responses_chat_incompatible" });
});

test("responsesToChat: rejects input items that Chat Completions cannot represent", () => {
  const item = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Reasoning state must not be discarded" }] };
  assert.throws(
    () => responsesToChat({ model: "m", input: [item] }),
    (error) => error.statusCode === 400
      && error.code === "ccdx_responses_chat_incompatible"
      && error.jsonBody?.error?.item_type === "reasoning",
  );
});

test("responsesToChat: rejects message content that Chat Completions cannot represent", () => {
  for (const part of [
    { type: "input_file", filename: "note.txt", file_data: "data:text/plain;base64,YQ==" },
    { type: "input_audio", input_audio: { data: "YQ==", format: "wav" } },
    { type: "input_image", image_url: null },
  ]) {
    assert.throws(
      () => responsesToChat({ model: "m", input: [{ type: "message", role: "user", content: [part] }] }),
      (error) => error.statusCode === 400
        && error.code === "ccdx_responses_chat_incompatible"
        && error.jsonBody?.error?.item_type === part.type,
    );
  }
});

test("chatToResponses: truncation and filtering remain incomplete", () => {
  for (const [finishReason, reason] of [["length", "max_output_tokens"], ["content_filter", "content_filter"]]) {
    const response = chatToResponses({
      model: "m", choices: [{ message: { role: "assistant", content: "partial" }, finish_reason: finishReason }],
    }, "m");
    assert.equal(response.status, "incomplete");
    assert.deepEqual(response.incomplete_details, { reason });
    assert.equal(response.output[0].status, "incomplete");
  }
  assert.equal(chatToResponses({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] }, "m").status, "completed");
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

test("Responses allowed tools retain their exact function restrictions in Chat", () => {
  const tools = ["read", "write"].map(name => ({ type: "function", name, parameters: { type: "object" } }));
  for (const mode of ["auto", "required"]) {
    const choice = { type: "allowed_tools", mode, tools: [{ type: "function", name: "read" }] };
    const result = responsesToChat({ model: "m", input: "test", tools, tool_choice: choice });
    assert.deepEqual(result.tool_choice, { type: "allowed_tools", allowed_tools: { mode, tools: [{ type: "function", function: { name: "read" } }] } });
    assert.deepEqual(result.tools.map(tool => tool.function.name), ["read", "write"]);
  }
  for (const choice of [
    { type: "allowed_tools", mode: "invalid", tools: [{ type: "function", name: "read" }] },
    { type: "allowed_tools", mode: "auto", tools: [] },
    { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "missing" }] },
    { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "read", namespace: "elsewhere" }] },
    { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "read", function: { name: "write" } }] },
  ]) assert.throws(() => responsesToChat({ model: "m", input: "test", tools, tool_choice: choice }), { code: "ccdx_responses_chat_incompatible" });
});

test("a Chat response cannot complete a tool call excluded by allowed_tools", () => {
  const toolChoice = { type: "allowed_tools", allowed_tools: { mode: "required", tools: [{ type: "function", function: { name: "read" } }] } };
  const response = name => ({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "call_1", function: { name, arguments: "{}" } }] } }] });
  assert.equal(chatToResponses(response("read"), "m", { toolChoice }).output[0].name, "read");
  assert.throws(() => chatToResponses(response("write"), "m", { toolChoice }), { code: "upstream_tool_not_allowed" });
  assert.throws(() => chatToResponses({ choices: [{ finish_reason: "stop", message: { content: "no call" } }] }, "m", { toolChoice }), { code: "upstream_tool_not_allowed" });
});

test("Chat cache fields pass only when their specific capability is advertised", () => {
  const body = { model: "m", input: "test", prompt_cache_key: "explicit-key", prompt_cache_retention: "24h" };
  assert.equal(responsesToChat(body).prompt_cache_key, undefined);
  assert.equal(responsesToChat(body).prompt_cache_retention, undefined);
  const keyOnly = responsesToChat(body, { cacheSupport: { prompt_cache_key: true } });
  assert.equal(keyOnly.prompt_cache_key, "explicit-key");assert.equal(keyOnly.prompt_cache_retention, undefined);
  const both = responsesToChat(body, { cacheSupport: { prompt_cache_key: true, prompt_cache_retention: true } });
  assert.equal(both.prompt_cache_key, "explicit-key");assert.equal(both.prompt_cache_retention, "24h");
  for (const value of [null, "", "  ", 42, "unexpected"]) {
    assert.equal(responsesToChat({ ...body, prompt_cache_retention: value }, { cacheSupport: { prompt_cache_retention: true } }).prompt_cache_retention, undefined);
  }
});
