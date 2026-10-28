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
import { parse } from "smol-toml";
import { createProfileModelRuntime } from "../src/profile-model-runtime.mjs";

process.env.CCDX_DISABLE_USAGE = "1";
test("HTTP 200 model errors remain byte-preserved and become actionable diagnostics without retry", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-model-errors-")), env = { CCDX_M365: "0" };let handler, calls = 0;
  const payload = { type: "error", error: { type: "rate_limit_error", message: "Synthetic refusal" } }, raw = JSON.stringify(payload);
  const runtime = createProviderRuntime({ home, env, githubClient: {}, githubRegistry: { models: { data: [] } },
    secretStore: { set: async () => {}, get: async () => "synthetic-key", close() {} }, inspectDesktop: async () => false,
    configureClaude: () => ({ app: "configured" }), restoreClaude: () => ({ preserved: 0 }),
    createApi: options => createApiProvider({ ...options, networkFactory: async () => ({ close() {}, fetch: async (_url, init) => {
      if (init.method === "GET") return Response.json({ data: [{ id: "demo" }] });
      calls++;const stream = JSON.parse(init.body).stream;
      return new Response(stream ? `event: error\ndata: ${raw}\n\n` : raw, { status: 200, headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
    } }) }) });
  const server = http.createServer((req, res) => handler(req, res));await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  handler = createAdapterHandler({ providerRuntime: runtime, dashboardOptions: { home, env } });
  t.after(async () => { handler.cleanup?.();server.closeAllConnections();await new Promise(resolve => server.close(resolve));await runtime.close();fs.rmSync(home, { recursive: true, force: true }); });
  const saved = await runtime.manageConnections({ operation: "save_api", config: { name: "API", base_url: "https://example.test/v1", endpoints: { messages: "https://example.test/v1/messages" }, auth_header: "bearer", models: [{ id: "demo", protocols: ["messages"] }] }, key: "synthetic-key", allowed: ["claude_app"] });
  const source = saved.providers.find(p => !p.builtin).id;await runtime.manageConnections({ operation: "client", id: "claude_app", enabled: true, source, allowed: [source] });
  const base = `http://127.0.0.1:${server.address().port}`, key = readClientGatewayKeys({ home, env }).claude_app;
  for (const stream of [false, true]) {
    const response = await fetch(base + "/anthropic/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify({ model: "demo", messages: [], max_tokens: 1, stream }) });
    assert.equal(response.status, 200);assert.equal(await response.text(), stream ? `event: error\ndata: ${raw}\n\n` : raw);
  }
  const status = await (await fetch(base + "/_ccdx/status")).json();
  assert.equal(calls, 2);const issues = status.http_errors.recent.filter(row => row.code === "rate_limit_error");
  assert.equal(issues.length, 2);assert(issues.every(row => row.event_type === "model.error" && row.http_status === 200 && row.retried === false));
});
test("reading the GitHub directory publishes new Codex candidates without changing selected models or sign-in", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-shared-catalog-")), env = { CCDX_M365: "0" };
  let incoming = ["gpt-existing"], reads = 0, fail = false, handler;
  const client = { cacheModelEndpoints() {}, listModels: async () => {
    reads++;if (fail) throw new Error("HTTP 503 unavailable");
    return { status: 200, body: JSON.stringify({ data: incoming.map(id => ({ id, vendor: "OpenAI", model_picker_enabled: true, supported_endpoints: ["/responses"] })) }) };
  } };
  const models = createProfileModelRuntime({ home, codexClient: client, log() {} });await models.initialize();
  const server = http.createServer((req, res) => handler(req, res));await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const runtime = createProviderRuntime({ home, env, corePort: server.address().port, githubClient: client, githubRegistry: models.codexRegistry,
    refreshGithubCatalog: () => models.refreshCodex({ strict: true }), secretStore: { close() {} }, inspectDesktop: async () => false });
  handler = createAdapterHandler({ providerRuntime: runtime, modelRegistry: models.codexRegistry, dashboardOptions: { home, env } });
  t.after(async () => { handler.cleanup?.();server.closeAllConnections();await new Promise(resolve => server.close(resolve));await runtime.close();fs.rmSync(home, { recursive: true, force: true }); });
  const saved = await runtime.manageConnections({ operation: "client", id: "codex", enabled: true, allowed: ["github"], deployments: [{ source: "github", model: "gpt-existing" }], default_model: "gpt-existing" });
  const previousDefault = saved.clients.find(client => client.id === "codex").default_model;
  const auth = path.join(home, ".codex/auth.json"), config = path.join(home, ".codex/config.toml");
  fs.writeFileSync(auth, '{"auth_mode":"chatgpt","tokens":{"access_token":"synthetic-only"}}');
  const before = [auth, config].map(file => fs.readFileSync(file, "utf8"));incoming = ["gpt-existing", "gpt-next"];
  const base = `http://127.0.0.1:${server.address().port}`, headers = { "X-CCDX-Dashboard": "1" };
  const response = await fetch(base + "/_ccdx/ui/models/live?provider=github", { headers });
  assert.equal(response.status, 200);assert.deepEqual((await response.json()).models.map(model => model.id), incoming);
  const connections = await (await fetch(base + "/_ccdx/ui/connections", { headers })).json();
  const codex = connections.clients.find(client => client.id === "codex");
  assert.deepEqual(codex.model_plan.available.map(model => model.id), incoming);
  assert.deepEqual(codex.model_plan.models.map(model => model.id), ["gpt-existing"]);
  assert.equal(codex.default_model, previousDefault);assert.equal(reads, 2);
  assert.deepEqual([auth, config].map(file => fs.readFileSync(file, "utf8")), before);
  fail = true;
  assert.equal((await fetch(base + "/_ccdx/ui/models/live?provider=github", { headers })).status, 502);
  assert.deepEqual(models.codexRegistry.models.data.map(model => model.id), incoming);
  assert.deepEqual([auth, config].map(file => fs.readFileSync(file, "utf8")), before);
});

test("an ungranted Claude route returns exactly one error response and keeps the listener healthy", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-ungranted-http-")), writes = [];let handler;
  const runtime = createProviderRuntime({ home, env: { CCDX_M365: "0" }, githubClient: {}, githubRegistry: { models: { data: [] } }, secretStore: { close() {} } });
  const server = http.createServer((req, res) => {
    let count = 0;const write = res.writeHead;res.writeHead = function(...args) { count++;return write.apply(this, args); };
    res.once("finish", () => writes.push(count));handler(req, res);
  });await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  handler = createAdapterHandler({ providerRuntime: runtime, dashboardOptions: { home, env: { CCDX_M365: "0" } } });
  t.after(async () => { handler.cleanup?.();server.closeAllConnections();await new Promise(resolve => server.close(resolve));await runtime.close();fs.rmSync(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`, refused = await fetch(base + "/anthropic/v1/models");
  assert.equal(refused.status, 503);assert.equal((await refused.json()).error.code, "ccdx_client_source_disabled");
  const status = await fetch(base + "/_ccdx/status");assert.equal(status.status, 200);await status.text();
  assert.deepEqual(writes, [1, 1]);
});

test("GitHub-only bindings retain an open native client's auth and expose only selected models", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-github-bindings-")), env = { CCDX_M365: "0" };
  const authFile = path.join(home, ".codex", "auth.json"), authBytes = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic-only" } });
  fs.mkdirSync(path.dirname(authFile));fs.writeFileSync(authFile, authBytes);
  const registry = { models: { data: ["gpt-5.5", "gpt-5.4"].map(id => ({ id, supported_endpoints: ["/responses"] })) } };
  let handler, catalogs = 0, responses = 0, expectedModel = "gpt-5.5";
  const server = http.createServer((req, res) => handler(req, res));await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = { getCachedModelEndpoints: () => ["/responses"], listModels: async () => { catalogs++;throw new Error("Unexpected implicit catalog refresh"); },
    responses: async body => { responses++;assert.equal(body.model, expectedModel);return Response.json({ id: "resp_binding", object: "response", status: "completed", model: body.model, output: [] }); } };
  const runtime = createProviderRuntime({ home, env, corePort: server.address().port, githubClient: client, githubRegistry: registry,
    secretStore: { close() {} }, inspectDesktop: async () => false });
  handler = createAdapterHandler({ providerRuntime: runtime, codexClient: client, modelRegistry: registry,
    codexModelCatalog: { load: async () => ({ models: [{ slug: "gpt-5.5", supported_reasoning_levels: [{ effort: "low", description: "Low" }] }] }) } });
  t.after(async () => { handler.dispose?.();server.closeAllConnections();await new Promise(resolve => server.close(resolve));await runtime.close();fs.rmSync(home, { recursive: true, force: true }); });
  await runtime.manageConnections({ operation: "client", id: "codex", enabled: true, allowed: ["github", "m365"], deployments: [{ source: "github", model: "gpt-5.5" }] });
  const selectedModel = runtime.connections().clients.find(c => c.id === "codex").model_plan.models[0], model = selectedModel.public_id, route = selectedModel.route_id;
  const headers = { Authorization: "Bearer synthetic-existing-chatgpt-token" };
  const paused = async (state = "paused") => {
    const before = responses;
    for (const authorization of [undefined, headers.Authorization, `Bearer ${readClientGatewayKeys({ home, env }).codex}`]) {
      for (const route of ["/v1/models", "/v1/responses", "/v1/responses/compact"]) {
        const response = await fetch(base + route, { method: route.endsWith("models") ? "GET" : "POST",
          headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
          ...(route.endsWith("models") ? {} : { body: JSON.stringify({ model: "gpt-5.5", input: "synthetic" }) }) });
        const body = await response.json();assert.equal(response.status, 503, JSON.stringify(body));
        assert.equal(body.error.code, "ccdx_client_source_disabled");assert.equal(response.headers.get("www-authenticate"), null);
      }
    }
    assert.equal(responses, before);assert.equal(catalogs, 0);
    assert.equal(runtime.connections().clients.find(c => c.id === "codex").setup, state);
    assert.equal(fs.readFileSync(authFile, "utf8"), authBytes);
  };
  await runtime.manageConnections({ operation: "client", id: "codex", enabled: true, allowed: ["github", "m365"], deployments: [] });
  await paused();
  const restarted = createProviderRuntime({ home, env, corePort: server.address().port, githubClient: client, githubRegistry: registry, secretStore: { close() {} }, inspectDesktop: async () => false });
  try {
    await restarted.syncClients();
    assert.throws(() => restarted.current({ method: "GET", headers }), { code: "ccdx_client_source_disabled", statusCode: 503 });
    assert.throws(() => restarted.resolveCodex({ model: "gpt-5.5" }, { headers }), { code: "ccdx_client_source_disabled", statusCode: 503 });
    assert.equal(restarted.connections().clients.find(c => c.id === "codex").setup, "paused");
  } finally { await restarted.close(); }
  await runtime.manageConnections({ operation: "client", id: "codex", enabled: true, allowed: ["github", "m365"], deployments: [{ source: "github", model: "gpt-5.5" }] });
  assert.equal(parse(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).model_provider, undefined);
  const raw = await fetch(base + "/v1/models", { headers });assert.equal(raw.status, 200);assert.deepEqual((await raw.json()).data.map(m => m.id), [model]);
  const native = await fetch(base + "/v1/models?client_version=0.163.0", { headers });assert.equal(native.status, 200);assert.deepEqual((await native.json()).models.map(m => m.slug), [model]);
  const reply = await fetch(base + "/v1/responses", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-5.5", input: "synthetic", stream: false }) });
  assert.equal(reply.status, 200, await reply.text());assert.equal(responses, 1);assert.equal(catalogs, 0);
  await runtime.manageConnections({ operation: "provider", id: "github", enabled: false, replacements: { codex: null } });
  await paused();
  await runtime.manageConnections({ operation: "provider", id: "github", enabled: true });
  await paused();
  await runtime.manageConnections({ operation: "client", id: "codex", enabled: true, allowed: ["github", "m365"], deployments: [{ source: "github", model: "gpt-5.5" }] });
  const denied = await fetch(base + "/v1/responses", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-5.4", input: "synthetic", stream: false }) });
  assert.equal(denied.status, 400);assert.equal(responses, 1, "The transition never reopens an unselected model");
  await runtime.manageConnections({ operation: "client", id: "codex", enabled: true, allowed: ["github", "m365"],
    deployments: [{ source: "github", model: "gpt-5.5" }, { source: "github", model: "gpt-5.4" }], default_model: model });
  registry.models = { data: registry.models.data.slice(1) };await runtime.syncClients();
  const missingDefault = runtime.connections().clients.find(c => c.id === "codex");
  assert.equal(missingDefault.setup, "default_unavailable");assert.equal(missingDefault.default_model, route);
  assert.equal(missingDefault.model_plan.default_model, null);assert.equal(missingDefault.model_plan.default_unavailable, true);
  const remaining = await fetch(base + "/v1/models?client_version=0.163.0", { headers });assert.equal(remaining.status, 200);assert.equal((await remaining.json()).models.length, 1);
  const unavailable = await fetch(base + "/v1/responses", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-5.5", input: "synthetic" }) });
  assert.equal(unavailable.status, 400);assert.equal(unavailable.headers.get("www-authenticate"), null);assert.equal(responses, 1);
  expectedModel = "gpt-5.4";
  const availableReply = await fetch(base + "/v1/responses", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-5.4", input: "synthetic", stream: false }) });
  assert.equal(availableReply.status, 200, await availableReply.text());assert.equal(responses, 2);
  registry.models = { data: [{ id: "gpt-5.5", supported_endpoints: ["/responses"] }, ...registry.models.data] };await runtime.syncClients();assert.equal(runtime.connections().clients.find(c => c.id === "codex").model_plan.default_model, model);
  env.SYNTHETIC_TEST_API_KEY = "synthetic-only";
  const saved = await runtime.manageConnections({ operation: "save_api", allowed: ["codex"], config: { name: "Mixed source", base_url: "https://synthetic.test/v1",
    endpoints: { responses: "https://synthetic.test/v1/responses" }, auth_header: "bearer", key_env: "SYNTHETIC_TEST_API_KEY", models: [{ id: "api-model", protocols: ["responses"] }] } });
  const api = saved.providers.find(source => !source.builtin).id;
  await runtime.manageConnections({ operation: "client", id: "codex", enabled: true, allowed: ["github", "m365", api],
    deployments: [{ source: "github", model: "gpt-5.5" }, { source: api, model: "api-model" }] });
  assert.equal((await fetch(base + "/v1/models", { headers })).status, 403, "An old ChatGPT bearer is refused without an authentication-refresh challenge");
  assert.equal((await fetch(base + "/v1/responses", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-5.5", input: "synthetic" }) })).status, 403);
  const credential = readClientGatewayKeys({ home, env }).codex;
  const config = parse(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"));
  assert.equal(config.model_provider, "ccdx_gateway");assert.equal(config.model_providers.ccdx_gateway.experimental_bearer_token, credential);
  assert.equal(config.model_providers.ccdx_gateway.requires_openai_auth, true);
  const mixed = await fetch(base + "/v1/models", { headers: { Authorization: `Bearer ${credential}` } });assert.equal(mixed.status, 200);assert.equal((await mixed.json()).data.length, 2);
  expectedModel = "gpt-5.5";
  const mixedReply = await fetch(base + "/v1/responses", { method: "POST", headers: { ...headers, Authorization: `Bearer ${credential}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-5.5", input: "synthetic" }) });
  assert.equal(mixedReply.status, 200, await mixedReply.text());assert.equal(responses, 3);assert.equal(catalogs, 0);
  await runtime.manageConnections({ operation: "client", id: "codex", enabled: false, allowed: ["github", "m365", api],
    deployments: [{ source: "github", model: "gpt-5.5" }, { source: api, model: "api-model" }] });
  await paused("disabled");
});

test("same-port HTTP enforces management origin, native client keys and configured model scopes", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-api-http-")), keys = new Map(), calls = [];
  const env = { CCDX_M365: "0" };let handler;
  const server = http.createServer((req, res) => handler(req, res));await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const runtime = createProviderRuntime({ home, env, corePort: server.address().port, githubClient: {}, githubRegistry: { models: { data: [] } },
    secretStore: { get: async id => keys.get(id), set: async (id, key) => { keys.set(id, key); }, remove: async id => { keys.delete(id); }, close() {} },
    inspectDesktop: async () => false, configureClaude: input => ({ [input.client === "claude_app" ? "app" : "code"]: "configured" }), restoreClaude: () => ({ preserved: 0 }),
    createApi: options => createApiProvider({ ...options, networkFactory: async () => ({ close() {}, fetch: async (url, init) => {
      if (!init.body) return Response.json({ data: [] });
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
          if (_options.method === "GET") { const response = new PassThrough();response.statusCode = 200;response.headers = { "content-type": "application/json" };reply(response);response.end('{"data":[]}');return; }
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
  assert.equal(calls, 3);assert.equal(created, 3);assert.equal(drained, false);assert.equal(held.destroyed, false);
  held.end('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  assert.match(await firstBody, /message_stop/);await new Promise(resolve => setImmediate(resolve));assert.equal(drained, true);
});

test("one client selects same-named models from two APIs on the shared port without cross-source retry", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-many-http-")), env = { CCDX_M365: "0" }, stored = new Map(), calls = [];
  let handler;
  const server = http.createServer((req, res) => handler(req, res));await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const runtime = createProviderRuntime({ home, env, corePort: server.address().port, githubClient: {}, githubRegistry: { models: { data: [] } },
    secretStore: { get: async id => stored.get(id), set: async (id, key) => stored.set(id, key), remove: async id => stored.delete(id), close() {} },
    configureClaude: () => ({ app: "configured", code: "configured" }), inspectDesktop: async () => false, restoreClaude: () => ({ preserved: 0 }),
    createApi: options => createApiProvider({ ...options, networkFactory: async () => ({ close() {}, async fetch(url, init) {
      const body = JSON.parse(init.body);calls.push({ url, model: body.model, max_tokens: body.max_tokens, auth: init.headers.Authorization });
      if (url.includes("two.test") && body.messages?.[0]?.content === "fail") return Response.json({ secret: "upstream-key-must-not-leak" }, { status: 500 });
      return url.endsWith("/messages") ? Response.json({ id: "msg_" + calls.length, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })
        : Response.json({ id: "resp_" + calls.length, object: "response", model: body.model, status: "completed", output: [{ id: "msg", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1 } });
    } }) }) });
  handler = createAdapterHandler({ providerRuntime: runtime, dashboardOptions: { home, env } });
  t.after(async () => { handler.dispose?.();server.closeAllConnections();await new Promise(resolve => server.close(resolve));await runtime.close();fs.rmSync(home, { recursive: true, force: true }); });
  const ids = [];
  for (const name of ["one", "two"]) {
    const state = await runtime.manageConnections({ operation: "save_api", config: { name, base_url: `https://${name}.test/v1`, auth_header: "bearer",
      endpoints: { messages: `https://${name}.test/v1/messages`, responses: `https://${name}.test/v1/responses` },
      models: [{ id: "same-model", protocols: ["messages", "responses"], capabilities: { context_window: name === "one" ? 128000 : 1000000, max_output_tokens: 100 } }] }, key: `synthetic-${name}`, allowed: ["claude_app", "codex"] });
    ids.push(state.providers.find(p => p.name === name).id);
  }
  for (const id of ["claude_app", "codex"]) {
    const c = runtime.connections().clients.find(c => c.id === id);
    await runtime.manageConnections({ operation: "client", id, enabled: true, allowed: c.allowed, deployments: ids.map(source => ({ source, model: "same-model" })), auto_sync: true });
  }
  // Editing capability metadata after Codex stores a qualified review route
  // must not mistake that route for an absent upstream model ID.
  const api = runtime.connections().providers.find(p => p.id === ids[0]);
  const { id: ignored, enabled: ignoredEnabled, builtin, key_saved, model_count, codex_model_count, protocols, deployment_revision, discovery, ...config } = api;
  await runtime.manageConnections({ operation: "save_api", id: ids[0], config, allowed: ["claude_app", "codex"] });
  const beforePreview = JSON.stringify(runtime.connections());
  const client = runtime.connections().clients.find(c => c.id === "claude_app");
  const preview = await runtime.manageConnections({ operation: "preview_client", id: "claude_app", enabled: true, allowed: client.allowed, deployments: [{ source: ids[0], model: "same-model" }] });
  assert.equal(preview.preview.saved, false);assert.equal(preview.preview.models.length, 1);assert.equal(JSON.stringify(runtime.connections()), beforePreview);
  const keys = readClientGatewayKeys({ home, env }), headers = client => ({ "Content-Type": "application/json", Authorization: `Bearer ${keys[client]}` });
  const list = await (await fetch(base + "/anthropic/v1/models", { headers: headers("claude_app") })).json();assert.equal(list.data.length, 2);assert.notEqual(list.data[0].id, list.data[1].id);assert.equal(list.data[1].supports_1m, true);assert.equal(list.data[0].supports_1m, undefined);
  for (let i = 0; i < 2; i++) {
    const response = await fetch(base + "/anthropic/v1/messages", { method: "POST", headers: headers("claude_app"), body: JSON.stringify({ model: list.data[i].id, messages: [{ role: "user", content: "unique-" + i }], max_tokens: 1000 }) });
    assert.equal(response.status, 200);assert.equal((await response.json()).model, list.data[i].id);assert.equal(calls.at(-1).url, `https://${["one", "two"][i]}.test/v1/messages`);assert.equal(calls.at(-1).max_tokens, 100);
  }
  const ambiguous = await fetch(base + "/anthropic/v1/messages", { method: "POST", headers: headers("claude_app"), body: JSON.stringify({ model: "same-model", messages: [], max_tokens: 4 }) });assert.equal(ambiguous.status, 400);assert.equal(calls.length, 2);
  const failed = await fetch(base + "/anthropic/v1/messages", { method: "POST", headers: headers("claude_app"), body: JSON.stringify({ model: list.data[1].id, messages: [{ role: "user", content: "fail" }], max_tokens: 4 }) });assert.equal(failed.status, 500);assert.equal((await failed.text()).includes("must-not-leak"), false);assert.equal(calls.length, 3);
  const catalog = await (await fetch(base + "/v1/models?client_version=0.163.0", { headers: headers("codex") })).json();assert.equal(catalog.models.length, 2);
  for (let i = 0; i < 2; i++) {
    const response = await fetch(base + "/v1/responses", { method: "POST", headers: headers("codex"), body: JSON.stringify({ model: catalog.models[i].slug, input: "response-" + i }) });
    assert.equal(response.status, 200, await response.text());assert.equal(calls.at(-1).url, `https://${["one", "two"][i]}.test/v1/responses`);assert.equal(calls.at(-1).model, "same-model");
  }
  const recent = runtime.snapshot().claude.requests.performance.recent_requests;
  assert.ok(recent.some(row => row.provider === ids[0]));assert.ok(recent.some(row => row.provider === ids[1]));
  assert.equal(calls.length, 5);
  const codexClient = runtime.connections().clients.find(c => c.id === "codex");
  await runtime.manageConnections({ operation: "client", id: "codex", enabled: true, allowed: codexClient.allowed, deployments: [] });
  assert.equal(runtime.connections().clients.find(c => c.id === "codex").model_plan.models.length, 0);
  await runtime.action({ action: "switch", provider: ids[0] });
  assert.equal(runtime.selection().codex, ids[0]);assert.equal(runtime.connections().clients.find(c => c.id === "codex").deployments, null);
  assert.equal(calls.length, 5, "Empty selection and legacy switching make no upstream request");
});
