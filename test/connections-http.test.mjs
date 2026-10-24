import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProviderRuntime } from "../src/provider-runtime.mjs";
import { createApiProvider } from "../src/providers/api.mjs";
import { createAdapterHandler } from "../src/adapter.mjs";
import { readClientGatewayKeys } from "../src/client-gateway-keys.mjs";
import { createApiNetwork } from "../src/providers/api-network.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

process.env.CCDX_DISABLE_USAGE = "1";
test("same-port HTTP enforces management origin, native client keys and configured model scopes", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-api-http-")), keys = new Map(), calls = [];
  const env = { CCDX_M365: "0" };let handler;
  const server = http.createServer((req, res) => handler(req, res));await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const runtime = createProviderRuntime({ home, env, corePort: server.address().port, githubClient: {}, githubRegistry: { models: { data: [] } },
    secretStore: { get: async id => keys.get(id), set: async (id, key) => { keys.set(id, key); }, remove: async id => { keys.delete(id); }, close() {} },
    inspectDesktop: async () => false, configureClaude: input => ({ [input.client === "claude_app" ? "app" : "code"]: "configured" }), restoreClaude: () => ({ preserved: 0 }),
    createApi: options => createApiProvider({ ...options, networkFactory: async () => ({ close() {}, fetch: async (url, init) => {
      calls.push({ url, init });const body = JSON.parse(init.body);
      return Response.json({ type: "message", role: "assistant", id: "msg_http", model: body.model, content: [{ type: "text", text: "synthetic" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 1 } });
    } }) }) });
  handler = createAdapterHandler({ providerRuntime: runtime, dashboardOptions: { home, env } });
  t.after(async () => { handler.dispose?.();server.closeAllConnections();await new Promise(resolve => server.close(resolve));await runtime.close();fs.rmSync(home, { recursive: true, force: true }); });
  const payload = { operation: "save_api", config: { name: "Test", base_url: "https://api.test/v1", endpoints: { messages: "https://api.test/v1/messages", responses: "https://api.test/v1/responses" }, auth_header: "x-api-key",
    models: [{ id: "message-model", protocols: ["messages"] }, { id: "response-model", protocols: ["responses"] }] }, key: "synthetic-http-key", allowed: ["codex", "claude_app", "claude_code"] };
  const headers = { "X-CCDX-Dashboard": "1", "Content-Type": "application/json", Origin: base };
  assert.equal((await fetch(base + "/_ccdx/ui/connections", { method: "POST", headers: { ...headers, Origin: "https://evil.test" }, body: JSON.stringify(payload) })).status, 403);
  assert.equal((await fetch(base + "/_ccdx/ui/connections")).status, 403);assert.equal(keys.size, 0);
  const saved = await fetch(base + "/_ccdx/ui/connections", { method: "POST", headers, body: JSON.stringify(payload) });assert.equal(saved.status, 200);
  const snapshot = await saved.json(), id = snapshot.providers.find(provider => !provider.builtin).id;
  assert.equal(JSON.stringify(snapshot).includes(payload.key), false);assert.equal(JSON.stringify(snapshot).includes("secret_ref"), false);
  for (const name of ["codex", "claude_app"]) {
    const c = snapshot.clients.find(client => client.id === name);
    assert.equal((await fetch(base + "/_ccdx/ui/connections", { method: "POST", headers, body: JSON.stringify({ operation: "client", id: name, source: id, allowed: c.allowed, enabled: true }) })).status, 200);
  }
  const credentials = readClientGatewayKeys({ home, env });
  const denied = await fetch(base + "/v1/models");assert.equal(denied.status, 401);
  const catalog = await fetch(base + "/v1/models?client_version=0.163.0", { headers: { Authorization: `Bearer ${credentials.codex}` } });assert.equal(catalog.status, 200);
  const modelList = await catalog.json();assert.deepEqual(modelList.models.map(model => model.slug), ["response-model"]);
  const native = { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials.claude_app}`, "X-CCDX-Client": "claude-code" },
    body: JSON.stringify({ model: "message-model", messages: [{ role: "user", content: "synthetic" }], max_tokens: 4 }) };
  const reply = await fetch(base + "/anthropic/v1/messages", native);assert.equal(reply.status, 200);assert.equal((await reply.json()).model, "message-model");
  assert.equal(calls.length, 1);assert.equal(calls[0].init.headers["x-api-key"], payload.key);assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal((await fetch(base + "/anthropic/v1/messages", { ...native, headers: { ...native.headers, Origin: base } })).status, 403);
  assert.equal((await fetch(base + "/anthropic/v1/messages", { ...native, headers: { ...native.headers, Authorization: `Bearer ${credentials.claude_code}` } })).status, 503);
  const summary = runtime.snapshot();assert.equal(summary.claude.requests.performance.recent_requests[0].application, "claude_app");
  assert.equal(summary.m365.claude.requests, null, "Custom API messages must not be attributed to M365");
});

test("the shared Claude route recovers on a later request while an earlier response keeps streaming", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-api-recovery-")), stored = new Map(), env = { CCDX_M365: "0" };
  let handler, calls = 0, created = 0, held, drained = false;
  const server = http.createServer((req, res) => handler(req, res));await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const runtime = createProviderRuntime({ home, env, corePort: server.address().port, githubClient: {}, githubRegistry: { models: { data: [] } },
    secretStore: { get: async id => stored.get(id), set: async (id, key) => { stored.set(id, key); }, remove: async id => { stored.delete(id); }, close() {} },
    inspectDesktop: async () => false, configureClaude: () => ({ app: "configured" }), restoreClaude: () => ({ preserved: 0 }),
    createApi: options => createApiProvider({ ...options, networkFactory: async input => {
      created++;
      const network = await createApiNetwork({ ...input, env: {}, platform: "linux", requestImpl: (_options, reply) => {
        const req = new EventEmitter();req.destroy = () => {};
        req.end = () => queueMicrotask(() => {
          calls++;
          if (calls === 2) { req.emit("error", Object.assign(new Error("private fixture text"), { code: "ECONNRESET" }));return; }
          const response = new PassThrough();response.statusCode = 200;
          if (calls === 1) {
            held = response;response.headers = { "content-type": "text/event-stream" };reply(response);
            response.write('event: message_start\ndata: {"type":"message_start","message":{"id":"held","model":"vendor-model","usage":{}}}\n\n');return;
          }
          response.headers = { "content-type": "application/json" };reply(response);
          response.end(JSON.stringify({ type: "message", id: "later", model: "vendor-model", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
        });return req;
      } });
      return { ...network, async retire() { await network.retire();drained = true; } };
    } }) });
  handler = createAdapterHandler({ providerRuntime: runtime, dashboardOptions: { home, env } });
  t.after(async () => { held?.destroy();handler.dispose?.();server.closeAllConnections();await new Promise(resolve => server.close(resolve));await runtime.close();fs.rmSync(home, { recursive: true, force: true }); });
  const saved = await runtime.manageConnections({ operation: "save_api", config: { name: "Recovery", base_url: "https://api.test/v1", endpoints: { messages: "https://api.test/v1/messages" }, auth_header: "bearer",
    models: [{ id: "vendor-model", protocols: ["messages"] }] }, key: "synthetic-key-only", allowed: ["claude_app"] });
  const id = saved.providers.find(value => !value.builtin).id, client = saved.clients.find(value => value.id === "claude_app");
  await runtime.manageConnections({ operation: "client", id: "claude_app", source: id, allowed: client.allowed, enabled: true });
  const key = readClientGatewayKeys({ home, env }).claude_app;
  const send = stream => fetch(base + "/anthropic/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "vendor-model", messages: [{ role: "user", content: "fixture" }], stream, max_tokens: 4 }), signal: AbortSignal.timeout(5000) });
  const first = await send(true), firstBody = first.text();
  const failed = await send(false);assert.equal(failed.status, 502);const error = await failed.json();assert.equal(error.error.diagnostic.code, "ECONNRESET");
  assert.equal(calls, 2, "the failed inference is never replayed");
  const later = await send(false);assert.equal(later.status, 200);assert.equal((await later.json()).content[0].text, "OK");
  assert.equal(calls, 3);assert.equal(created, 2);assert.equal(drained, false);assert.equal(held.destroyed, false);
  held.end('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  assert.match(await firstBody, /message_stop/);await new Promise(resolve => setImmediate(resolve));assert.equal(drained, true);
});
