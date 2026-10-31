import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startClaudeGateway } from "../src/claude-gateway.mjs";
import { createLocalPrivacy } from "../src/local-privacy.mjs";
import { userSettingsPath } from "../src/user-settings.mjs";

test("Messages JSON, streaming and token counting share masking while client credentials remain unchanged", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-privacy-http-")), env = {}, file = userSettingsPath({ home, env });
  fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, '{"privacy_enabled":true}');
  const model = { load: async () => {}, find: async texts => texts.map(() => []), snapshot: () => ({ state: "ready" }), close() {}, busy: () => false };
  const privacy = createLocalPrivacy({ home, env, model }), key = "a".repeat(64), secret = "ghp_" + "b".repeat(36);let calls = 0;
  const server = await startClaudeGateway({ port: 0, apiKey: key, privacy, privacyClient: "claude_app", provider: { id: "m365", models: () => [{ id: "claude-opus-5.5" }], client: {
    messages: async (body, options) => {
      calls++;assert.doesNotMatch(JSON.stringify(body), /ghp_/);const masked = body.messages[0].content;
      if (options.countTokens) return new Response('{"input_tokens":42}', { headers: { "Content-Type": "application/json" } });
      if (!body.stream) return new Response(JSON.stringify({ type: "message", model: body.model, role: "assistant", id: "msg_1", content: [{ type: "text", text: masked }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 3 } }), { headers: { "Content-Type": "application/json" } });
      const events = [{ type: "message_start", message: { id: "msg_2", model: body.model, usage: { input_tokens: 5 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: masked.slice(0, 4) } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: masked.slice(4) } },
        { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" }];
      return new Response(events.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    } } }, record() {} });
  t.after(async () => { server.close();privacy.close();fs.rmSync(home, { recursive: true, force: true }); });
  const request = (suffix = "", stream = false, token = key) => fetch(`http://127.0.0.1:${server.port}/v1/messages${suffix}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-opus-5.5", messages: [{ role: "user", content: secret }], max_tokens: 64, stream }) });
  const json = await request();assert.equal(json.status, 200);assert.equal((await json.json()).content[0].text, secret);
  const streamed = await request("", true), events = (await streamed.text()).split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
  assert.equal(events.filter(value => value.delta?.type === "text_delta").map(value => value.delta.text).join(""), secret);
  assert.deepEqual(await (await request("/count_tokens")).json(), { input_tokens: 42 });
  assert.equal((await request("", false, "wrong")).status, 401);assert.equal(calls, 3);
});
