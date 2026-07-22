import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { anthropicToChat } from "../src/anthropic.mjs";
import { responsesToChat } from "../src/responses-bridge.mjs";
import { prepareResponsesRequest } from "../src/responses-request.mjs";

function fixture(name) {
  return JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

test("Responses fixture preserves images, tools, and structured output across the chat bridge", () => {
  const original = fixture("responses-chat-request.json");
  const prepared = prepareResponsesRequest(original);
  const chat = responsesToChat(prepared.body);

  assert.equal(original.store, true);
  assert.equal(original.input[0].internal_reference, "must-not-reach-upstream");
  assert.equal(prepared.body.store, undefined);
  assert.equal(prepared.body.input[0].internal_reference, undefined);
  assert.equal(prepared.body.tools.some((tool) => tool.type === "image_gen"), false);

  assert.deepEqual(chat.messages[0], { role: "system", content: "Use the available tools when needed." });
  assert.deepEqual(chat.messages[1].content[1], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,aW1hZ2U=", detail: "high" },
  });
  assert.deepEqual(chat.messages[2].tool_calls[0], {
    id: "call_weather",
    type: "function",
    function: { name: "lookup_weather", arguments: "{\"city\":\"Singapore\"}" },
  });
  assert.deepEqual(chat.messages[3], {
    role: "tool",
    tool_call_id: "call_weather",
    content: "{\"temperature\":30}",
  });
  assert.equal(chat.tools.length, 1);
  assert.equal(chat.tools[0].function.name, "lookup_weather");
  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "lookup_weather" } });
  assert.equal(chat.max_completion_tokens, 1024);
  assert.equal(chat.response_format.json_schema.name, "weather_result");
});

test("Anthropic fixture preserves images, tool calls, tool results, and controls", () => {
  const request = fixture("anthropic-message-request.json");
  const chat = anthropicToChat(request, { upstreamModel: "claude-sonnet-4.6-upstream" });

  assert.deepEqual(chat.messages[0], { role: "system", content: "Be concise.\nUse tools carefully." });
  assert.deepEqual(chat.messages[1].content[1], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,aW1hZ2U=" },
  });
  assert.equal(chat.messages[2].content, "I will inspect it.");
  assert.deepEqual(chat.messages[2].tool_calls[0], {
    id: "tool_1",
    type: "function",
    function: { name: "inspect_image", arguments: "{\"detail\":\"high\"}" },
  });
  assert.deepEqual(chat.messages[3], {
    role: "tool",
    tool_call_id: "tool_1",
    content: "A terminal window",
  });
  assert.equal(chat.model, "claude-sonnet-4.6-upstream");
  assert.equal(chat.tools[0].function.name, "inspect_image");
  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "inspect_image" } });
  assert.equal(chat.max_tokens, 2048);
  assert.deepEqual(chat.stop, ["END"]);
});
