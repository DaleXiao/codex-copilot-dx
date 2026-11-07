import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startAdapter } from "../src/adapter.mjs";
import { startClaudeGateway } from "../src/claude-gateway.mjs";
import { createLocalPrivacy } from "../src/local-privacy.mjs";
import { userSettingsPath } from "../src/user-settings.mjs";

for (const protocol of ["responses", "messages"]) for (const enabled of [false, true]) {
  test(`${protocol} keeps a stable tool prefix when a conversation grows with masking ${enabled ? "on" : "off"}`, async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-prefix-")), env = {}, file = userSettingsPath({ home, env });
    fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, JSON.stringify({ privacy_enabled: enabled }));
    const model = { load: async () => {}, find: async texts => texts.map(() => []), snapshot: () => ({ state: "ready" }), close() {}, busy: () => false };
    const privacy = createLocalPrivacy({ home, env, model }), captured = [], secret = "ghp_" + "b".repeat(36);
    const reply = async body => {
      captured.push(structuredClone(body));
      return Response.json(protocol === "responses" ? { id: "resp_prefix", status: "completed", output: [] }
        : { id: "msg_prefix", type: "message", model: body.model, role: "assistant", content: [], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 0 } });
    };
    const schema = { type: "object", properties: { zebra: { type: "string" }, alpha: { type: "integer" } } };
    const tools = protocol === "responses" ? [{ type: "function", name: "search", description: `fixture ${secret}`, parameters: schema }]
      : [{ name: "search", description: `fixture ${secret}`, input_schema: schema }];
    if (protocol === "responses") {
      const options = { privacy, env, dashboardOptions: { home, env }, responsesFn: reply, getCachedModelEndpointsFn: () => ["/responses"] };
      const server = await startAdapter(0, "127.0.0.1", options);
      t.after(async () => { server.closeAllConnections();await new Promise(resolve => server.close(resolve)); });
      for (const count of [1, 2]) {
        const body = { model: "gpt-5.6-sol", instructions: "Stable system text", tools, input: Array.from({ length: count }, (_, index) => ({ role: "user", content: `message ${index}` })) };
        const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        assert.equal(response.status, 200);await response.text();
      }
    } else {
      const key = "a".repeat(64), server = await startClaudeGateway({ port: 0, apiKey: key, privacy, env, record() {},
        provider: { id: "m365", models: () => [{ id: "fixture" }], client: { messages: reply } } });
      t.after(() => server.close());
      for (const count of [1, 2]) {
        const body = { model: "fixture", system: "Stable system text", tools, messages: Array.from({ length: count }, (_, index) => ({ role: "user", content: `message ${index}` })), max_tokens: 4 };
        const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
        assert.equal(response.status, 200);await response.text();
      }
    }
    t.after(() => { privacy.close();fs.rmSync(home, { recursive: true, force: true }); });
    assert.equal(captured.length, 2);
    assert.equal(JSON.stringify({ system: captured[0].instructions || captured[0].system, tools: captured[0].tools }),
      JSON.stringify({ system: captured[1].instructions || captured[1].system, tools: captured[1].tools }));
    assert.deepEqual(Object.keys(captured[0].tools[0].parameters?.properties || captured[0].tools[0].input_schema.properties), ["zebra", "alpha"]);
    if (enabled) assert.doesNotMatch(JSON.stringify(captured[0].tools), /ghp_/);
  });
}
