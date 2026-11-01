import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { maskPrivacyRequest, createPrivacyStream } from "../src/privacy-transform.mjs";

const credential = "ghp_" + "c".repeat(36);
async function session() {
  return maskPrivacyRequest({ model: "fixture", messages: [{ role: "user", content: credential }] }, {
    protocol: "messages", client: "fixture", secret: Buffer.alloc(32, 9), find: async texts => texts.map(() => []),
  });
}
function response(events, privacy, width, newline = "\n") {
  const wire = Buffer.from(events.map(event => `event: ${event.type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`).join(""));
  const stream = createPrivacyStream(privacy), chunks = [];
  for (let at = 0; at < wire.length; at += width) {
    const output = stream.push(wire.subarray(at, at + width));if (output) chunks.push(Buffer.from(output));
  }
  const tail = stream.finish();if (tail) chunks.push(Buffer.from(tail));
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk);controller.close(); } }), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("Anthropic SDK receives restored parallel tool inputs through fragmented SSE", async () => {
  for (const width of [1, 11, 4096]) for (const newline of ["\n", "\r\n"]) {
    const privacy = await session(), token = privacy.body.messages[0].content;
    const inputs = [{ credential: token, nested: [1, true, "中文😀 \\\"quoted\\\""] }, { items: [{ content: "Synthetic step", status: "in_progress" }], scope: "first_task" }];
    const json = inputs.map(JSON.stringify), events = [
      { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      ...inputs.map((_, index) => ({ type: "content_block_start", index, content_block: { type: "tool_use", id: `tool_${index}`, name: `fixture_${index}`, input: {} } })),
      ...[0, 1].flatMap(part => inputs.map((_, index) => ({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: part ? json[index].slice(17) : json[index].slice(0, 17) } }))),
      ...inputs.map((_, index) => ({ type: "content_block_stop", index })),
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" },
    ];
    const client = new Anthropic({ apiKey: "synthetic", maxRetries: 0, fetch: async () => response(events, privacy, width, newline) });
    const result = await client.messages.stream({ model: "fixture", messages: [{ role: "user", content: "fixture" }], max_tokens: 32 }).finalMessage();
    assert.deepEqual(result.content.map(block => block.input), [{ ...inputs[0], credential }, inputs[1]]);
    privacy.release();
  }
});

test("OpenAI SDK receives complete restored function arguments and custom tool text", async () => {
  for (const width of [1, 13, 4096]) {
    const privacy = await session(), token = privacy.body.messages[0].content;
    const args = JSON.stringify({ credential: token, nested: { unicode: "中文😀", quote: '\\"' } });
    const custom = `*** Begin Patch\n+credential=${token}\n*** End Patch\n`;
    const events = [
      { type: "response.function_call_arguments.delta", item_id: "function", output_index: 0, delta: args.slice(0, 16) },
      { type: "response.custom_tool_call_input.delta", item_id: "custom", output_index: 1, delta: custom.slice(0, custom.indexOf(token) + 5) },
      { type: "response.function_call_arguments.delta", item_id: "function", output_index: 0, delta: args.slice(16) },
      { type: "response.custom_tool_call_input.delta", item_id: "custom", output_index: 1, delta: custom.slice(custom.indexOf(token) + 5) },
      { type: "response.function_call_arguments.done", item_id: "function", output_index: 0, arguments: args },
      { type: "response.custom_tool_call_input.done", item_id: "custom", output_index: 1, input: custom },
      { type: "response.completed", response: { id: "fixture", output: [] } },
    ];
    const client = new OpenAI({ apiKey: "synthetic", maxRetries: 0, fetch: async () => response(events, privacy, width) });
    const stream = await client.responses.create({ model: "fixture", input: "fixture", stream: true });
    let receivedArgs = "", receivedCustom = "";
    for await (const event of stream) {
      if (event.type === "response.function_call_arguments.delta") receivedArgs += event.delta;
      if (event.type === "response.custom_tool_call_input.delta") receivedCustom += event.delta;
    }
    assert.deepEqual(JSON.parse(receivedArgs), { credential, nested: { unicode: "中文😀", quote: '\\"' } });
    assert.equal(receivedCustom, custom.replace(token, credential));privacy.release();
  }
});
