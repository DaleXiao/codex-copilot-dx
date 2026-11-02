import test from "node:test";
import assert from "node:assert/strict";
import { startClaudeGateway } from "../src/claude-gateway.mjs";

test("M365 count capability probes share privacy work while generation preserves inline history", async t => {
  let checks = 0, counts = 0, generated;
  const provider = { id: "fixture", messagesSystemMode: "native", coordinateMessagesCounts: true, client: { messages: async (body, options) => {
    options.onUpstreamStart?.();
    if (options.countTokens) { counts++;await new Promise(resolve => setTimeout(resolve, 20));return Response.json({ error: { type: "not_found_error" } }, { status: 404 }); }
    generated = body;return Response.json({ id: "synthetic", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  } } };
  const server = await startClaudeGateway({ port: 0, provider, apiKey: "s".repeat(40), record() {}, privacy: { wrap: fn => async (...args) => { checks++;return fn(...args); } } });
  t.after(() => server.close());
  const body = { model: "synthetic", max_tokens: 4, messages: [{ role: "user", content: "u" }, { role: "assistant", content: [{ type: "thinking", thinking: "retained", signature: "sealed" }] }, { role: "system", content: [{ type: "text", text: "inline", cache_control: { type: "ephemeral" } }] }, { role: "user", content: "next" }] };
  const request = (count, value = body) => fetch(`http://127.0.0.1:${server.port}/v1/messages${count ? "/count_tokens" : ""}`, { method: "POST", headers: { authorization: "Bearer " + "s".repeat(40), "content-type": "application/json" }, body: JSON.stringify(value) });
  const replies = await Promise.all([...Array.from({ length: 10 }, (_, i) => request(true, { ...body, max_tokens: i + 1 })), request(false)]);
  assert.equal(replies.at(-1).status, 200);assert.ok(replies.slice(0, -1).every(response => response.status === 404));assert.equal(counts, 1);assert.equal(checks, 2);
  const cached = await request(true);assert.equal(cached.status, 404);assert.equal(counts, 1);assert.equal(checks, 2);
  assert.deepEqual(generated.messages, body.messages);assert.equal(generated.system, undefined);
  for (const response of [...replies, cached]) await response.body?.cancel();
});
