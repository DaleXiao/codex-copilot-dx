import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createAdapterHandler } from "../src/adapter.mjs";
import { createClaudeGateway } from "../src/claude-gateway.mjs";
import { invokeAdapterRequest } from "../test-support/adapter.mjs";

const key = "synthetic-" + "a".repeat(64);
test("one dispatcher separates catalogs, accounts once, retains local access gates and disables only Claude", async t => {
  const calls = [], usage = [];
  const gateway = createClaudeGateway({ port: 2026, apiKey: key, record: value => usage.push(value), provider: {
    id: "m365", models: () => [{ id: "claude-opus-5.5" }], client: { messages: async (body, options) => {
      calls.push({ body, countTokens: options.countTokens });options.onUpstreamStart?.();
      return Response.json(options.countTokens ? { input_tokens: 2 } : { id: "msg_shared", type: "message", model: body.model,
        content: [{ type: "text", text: "shared" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 1 } });
    } },
  } });
  const client = { listModels: async () => ({ status: 200, body: JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }) }),
    getCachedModelEndpoints: () => ["/responses"], responses: async () => Response.json({ id: "resp_shared", status: "completed", output: [] }) };
  const github = { id: "github", client, profileId: () => "codex" };let enabled = true;
  const runtime = { github, current: () => github, track() {}, historyContext: () => ({}), snapshot: () => ({}),
    dashboardProviders: () => [], dashboardCatalog: () => null,
    handleClaude(req, res) { if (enabled) return gateway.handle(req, res);res.writeHead(503);res.end('{}'); } };
  const handler = createAdapterHandler({ providerRuntime: runtime, codexClient: client });
  t.after(() => gateway.close());
  async function request(url, { method = "GET", headers = {}, body, address = "127.0.0.1" } = {}) {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { url, method, headers: { host: "127.0.0.1:2026", authorization: `Bearer ${key}`, "content-type": "application/json", ...headers }, socket: { remoteAddress: address } });
    return invokeAdapterRequest({}, req, handler);
  }
  const models = await request("/v1/models");assert.deepEqual(JSON.parse(models.text).data.map(x => x.id), ["gpt-5.6-sol"]);
  const claude = await request("/anthropic/v1/models?limit=1000");assert.deepEqual(JSON.parse(claude.text).data.map(x => x.id), ["claude-opus-5-5"]);
  const messages = await request("/anthropic/v1/messages?beta=true", { method: "POST", body: { model: "claude-opus-5-5", messages: [], max_tokens: 2 } });
  assert.equal(messages.status, 200);assert.equal(calls.length, 1);assert.equal(usage.length, 1);
  let state = handler.snapshot();assert.equal(state.requests.total, 3);assert.equal(state.requests.by_route.messages.total, 1);
  assert.equal(state.requests.by_route.claude_models.total, 1);assert.equal(state.requests.by_route.models.total, 1);
  for (const option of [{ headers: { origin: "http://127.0.0.1:2026" } }, { headers: { host: "evil.invalid" } }, { address: "192.0.2.1" }]) {
    assert.equal((await request("/anthropic/v1/models", option)).status, 403);
  }
  assert.equal((await request("/anthropic/v1/messages", { method: "POST", headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await request("/anthropic-other/v1/models")).status, 404);
  assert.equal((await request("/v1/messages", { method: "POST" })).status, 410);
  enabled = false;assert.equal((await request("/anthropic/v1/models")).status, 503);
  assert.equal((await request("/v1/models")).status, 200);assert.equal((await request("/_ccdx/status")).status, 200);
  state = handler.snapshot();assert.equal(state.http_errors.by_category.inference >= 1, true);
});
