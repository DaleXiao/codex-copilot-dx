import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createClaudeGatewayHandler } from "../src/claude-gateway.mjs";
import { createApiProvider } from "../src/providers/api.mjs";

const key = "synthetic-local-" + "a".repeat(64);
const body = { model: "background-independent", messages: [{ role: "user", content: "synthetic" }], max_tokens: 8 };
async function fixture(t, { credential = false, env = {} } = {}) {
  let calls = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const network = { close() {}, fetch: async () => { calls++;return Response.json({ type: "message", model: body.model,
    id: "msg_prepare", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }); } };
  const source = createApiProvider({ config: { id: "api_prepare", name: "Prepare", enabled: true, base_url: "https://synthetic.test/v1",
    endpoints: { messages: "https://synthetic.test/v1/messages" }, secret_ref: "a".repeat(32), auth_header: "bearer",
    models: [{ id: body.model, protocols: ["messages"] }] }, env: {}, secrets: { get: () => credential ? held.then(() => "synthetic-key") : Promise.resolve("synthetic-key") },
    networkFactory: () => credential ? Promise.resolve(network) : held.then(() => network) });
  const handler = createClaudeGatewayHandler({ provider: source, apiKey: key, env: { CCDX_UPSTREAM_TIMEOUT_MS: "200", CCDX_REQUEST_BODY_TIMEOUT_MS: "3000", ...env }, record() {} });
  const server = http.createServer(handler);await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { source.close();release();server.closeAllConnections();await new Promise(resolve => server.close(resolve)); });
  return { source, release, handler, calls: () => calls, base: `http://127.0.0.1:${server.address().port}` };
}

test("Messages and count preparation timeouts end before dispatch with the right cause", async t => {
  for (const credential of [false, true]) for (const count of [false, true]) await t.test(`${credential ? "credential" : "network"}/${count ? "count" : "messages"}`, async t => {
    const f = await fixture(t, { credential });
    const response = await fetch(f.base + "/v1/messages" + (count ? "/count_tokens" : ""), { method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const result = await response.json();assert.equal(response.status, 504, JSON.stringify(result));
    assert.equal(result.error.code, "messages_prepare_timeout");assert.equal(f.calls(), 0);
    f.release();await new Promise(resolve => setImmediate(resolve));assert.equal(f.calls(), 0, "A late setup result cannot dispatch the timed-out request");
    assert.equal(f.handler.snapshot().active, 0);
  });
});

test("body upload has its own deadline and does not spend the Messages preparation budget", async t => {
  const f = await fixture(t);f.release();
  const bytes = JSON.stringify(body);
  const response = await new Promise((resolve, reject) => {
    const request = http.request(f.base + "/v1/messages", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bytes) } }, resolve);
    request.on("error", reject);request.write(bytes.slice(0, 10));setTimeout(() => request.end(bytes.slice(10)), 300);
  });
  let text = "";for await (const chunk of response) text += chunk;
  assert.equal(response.statusCode, 200, text);assert.equal(f.calls(), 1);assert.equal(JSON.parse(text).stop_reason, "end_turn");
});
