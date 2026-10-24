import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProviderRuntime } from "../src/provider-runtime.mjs";
import { createApiProvider } from "../src/providers/api.mjs";
import { createAdapterHandler } from "../src/adapter.mjs";
import { readClientGatewayKeys } from "../src/client-gateway-keys.mjs";

const args = new Map();for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const binary = args.get("--codex");assert.ok(path.isAbsolute(binary || ""), "Supply --codex /absolute/path/to/codex");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-api-client-")), profile = path.join(root, "codex"), model = "vendor/replay-model";
const env = { CCDX_M365: "0", CODEX_HOME: profile, CCDX_DISABLE_USAGE: "1" };process.env.CCDX_DISABLE_USAGE = "1";
const secretValues = new Map(), calls = [], authenticated = [], notices = [];
let child, runtime, clientModel = model;
function response(body) {
  const item = { type: "message", id: "msg_api", role: "assistant", status: "completed", content: [{ type: "output_text", text: "SYNTHETIC_API_OK", annotations: [] }] };
  const complete = { id: "resp_api", object: "response", status: "completed", model: body.model, output: [item], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } };
  if (!body.stream) return Response.json(complete);
  const events = [
    { type: "response.created", response: { ...complete, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "SYNTHETIC_API_OK" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: complete },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
const server = http.createServer((req, res) => {
  authenticated.push({ method: req.method, route: new URL(req.url, "http://localhost").pathname, authorized: req.headers.authorization === `Bearer ${readClientGatewayKeys({ home: root, env }).codex}` });
  handler(req, res);
});
let handler;
const pending = new Map();let next = 0, buffer = "", turnResolve;
const turn = new Promise(resolve => { turnResolve = resolve; });
function bounded(promise, label) { let timer;return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + " timed out")), 30000); })]).finally(() => clearTimeout(timer)); }
function call(method, params) { const id = ++next;return bounded(new Promise((resolve, reject) => { pending.set(id, { resolve, reject });child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); }), method); }
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  runtime = createProviderRuntime({ home: root, env, platform: process.platform, corePort: server.address().port, githubClient: {}, githubRegistry: { models: { data: [] } },
    secretStore: { get: async id => secretValues.get(id), set: async (id, key) => { secretValues.set(id, key); }, remove: async id => { secretValues.delete(id); }, close() {} },
    inspectDesktop: async () => false,
    createApi: options => createApiProvider({ ...options, networkFactory: async () => ({ close() {}, async fetch(url, init) {
      assert.equal(init.headers.Authorization, "Bearer synthetic-only-key");assert.equal(init.headers["X-ClientType"], undefined);
      const body = JSON.parse(init.body);calls.push({ model: body.model, stream: body.stream, has_tools: Array.isArray(body.tools) });
      if (url.endsWith("messages")) {
        const message = { id: "msg_claude_api", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } };
        if (!body.stream) return Response.json({ ...message, content: [{ type: "text", text: "SYNTHETIC_API_OK" }], stop_reason: "end_turn" });
        const events = [{ type: "message_start", message }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "SYNTHETIC_API_OK" } }, { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }, { type: "message_stop" }];
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      }
      return response(body);
    } }) }) });
  const saved = await runtime.manageConnections({ operation: "save_api", key: "synthetic-only-key", allowed: ["codex"], config: { name: "Synthetic API", base_url: "https://api.synthetic.test/v1",
    endpoints: { responses: "https://api.synthetic.test/v1/responses" }, auth_header: "bearer", models: [{ id: model, protocols: ["responses"] }] } });
  const id = saved.providers.find(source => !source.builtin).id, c = saved.clients.find(c => c.id === "codex");
  await runtime.manageConnections({ operation: "client", id: c.id, source: id, enabled: true, allowed: c.allowed, model, auto_review_model: model });
  if (args.get("--bindings") === "models") {
    await runtime.manageConnections({ operation: "client", id: c.id, enabled: true, allowed: c.allowed, deployments: [{ source: id, model }] });
    clientModel = runtime.connections().clients.find(c => c.id === "codex").model_plan.models[0].public_id;
  }
  handler = createAdapterHandler({ providerRuntime: runtime, env, modelRegistry: { models: { data: [] } } });
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG"].includes(key)));
  childEnv.CODEX_HOME = profile;
  const overrides = { "features.shell_snapshot": false, "features.plugins": false, "features.remote_plugin": false, "features.apps": false,
    "features.skill_search": false, "features.skill_mcp_dependency_install": false, "analytics.enabled": false, "feedback.enabled": false, check_for_update_on_startup: false,
    "model_providers.ccdx_gateway.request_max_retries": 0, "model_providers.ccdx_gateway.stream_max_retries": 0, "model_providers.ccdx_gateway.supports_websockets": false };
  child = spawn(binary, [...Object.entries(overrides).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]), "app-server", "--stdio"], { cwd: root, env: childEnv, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", () => {});child.stdin.on("error", () => {});
  child.on("error", error => { for (const p of pending.values()) p.reject(error); });
  child.on("exit", code => { for (const p of pending.values()) p.reject(new Error("Codex exited " + code)); });
  child.stdout.setEncoding("utf8");child.stdout.on("data", chunk => {
    buffer += chunk;let boundary;
    while ((boundary = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, boundary);buffer = buffer.slice(boundary + 1);if (!line) continue;
      const value = JSON.parse(line), p = pending.get(value.id);
      if (p) { pending.delete(value.id);value.error ? p.reject(new Error(JSON.stringify(value.error))) : p.resolve(value.result); }
      else if (value.method === "turn/completed") turnResolve(value.params);
      else if (value.method === "error") notices.push(value.params);
    }
  });
  await call("initialize", { clientInfo: { name: "Codex Desktop", version: "1.0" }, capabilities: { experimentalApi: true } });child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const configuration = await call("config/read", { includeLayers: false });assert.equal(configuration.config.model, clientModel);assert.equal(configuration.config.model_provider, "ccdx_gateway");
  const catalog = await call("model/list", {});assert.ok(catalog.data.some(entry => entry.id === clientModel), "The native model selector must include the configured API model");
  const thread = await call("thread/start", { cwd: root, model: clientModel, modelProvider: "ccdx_gateway", approvalPolicy: "never", sandbox: "read-only" });
  await call("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Synthetic API replay. Reply with a short marker.", text_elements: [] }] });
  const completed = await bounded(turn, "native turn");assert.equal(completed.turn.status, "completed", JSON.stringify(completed.turn.error));
  const read = await call("thread/read", { threadId: thread.thread.id, includeTurns: true });assert.ok(JSON.stringify(read).includes("SYNTHETIC_API_OK"));
  assert.ok(calls.length > 0);assert.ok(calls.every(call => call.model === model));assert.ok(authenticated.filter(r => r.route.startsWith("/v1/")).every(r => r.authorized));
  let claudeCode = false, claudeApp = false;
  if (args.get("--claude")) {
    const api = runtime.connections().providers.find(p => p.id === id), { id: ignored, builtin, key_saved, protocols, model_count, codex_model_count, enabled, deployment_revision, discovery, ...config } = api;
    config.endpoints.messages = "https://api.synthetic.test/v1/messages";config.models.push({ id: "claude-sonnet-4.6", protocols: ["messages"] });
    await runtime.manageConnections({ operation: "save_api", id, config, allowed: ["codex", "claude_code", "claude_app"] });
    for (const name of ["claude_code", "claude_app"]) {
      const c = runtime.connections().clients.find(c => c.id === name);await runtime.manageConnections({ operation: "client", id: name, source: id, allowed: c.allowed, enabled: true });
    }
    const keys = readClientGatewayKeys({ home: root, env });
    const codeConfig = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));assert.equal(codeConfig.env.ANTHROPIC_AUTH_TOKEN, keys.claude_code);
    const testEnv = { ...childEnv, CLAUDE_CONFIG_DIR: path.join(root, ".claude"), ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}/anthropic`, ANTHROPIC_AUTH_TOKEN: keys.claude_code,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
    const result = await promisify(execFile)(args.get("--claude"), ["--bare", "-p", "Reply with a synthetic marker.", "--model", "claude-sonnet-4-6", "--tools", "", "--no-session-persistence", "--output-format", "json", "--max-turns", "1"], { cwd: root, env: testEnv, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    assert.ok(result.stdout.includes("SYNTHETIC_API_OK"));claudeCode = true;
    const resultApp = await fetch(`http://127.0.0.1:${server.address().port}/anthropic/v1/messages`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${keys.claude_app}`, "X-CCDX-Client": "claude-code" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 32, messages: [{ role: "user", content: "Synthetic App protocol replay" }] }) });
    assert.equal(resultApp.status, 200);assert.ok((await resultApp.text()).includes("SYNTHETIC_API_OK"));claudeApp = true;
    const recent = runtime.snapshot().claude.requests.performance.recent_requests;assert.ok(recent.some(row => row.application === "claude_app"));assert.ok(recent.some(row => row.application === "claude_code"));
  }
  console.log(JSON.stringify({ native_client: true, qualified_model_routes: clientModel !== model, configured_model: true, catalog_contains_custom_model: catalog.data.some(entry => entry.id === clientModel), completed: true,
    claude_code: claudeCode, claude_app_protocol: claudeApp, upstream_calls: calls.length, authenticated_requests: authenticated.filter(r => r.authorized).length, notices: notices.length, live_provider_calls: 0 }));
} finally {
  if (child && child.exitCode === null) { child.stdin.end();if (process.platform !== "win32") { try { process.kill(-child.pid, "SIGTERM"); } catch {} }else child.kill();await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 1000))]); }
  server.closeAllConnections();await new Promise(resolve => server.close(resolve));await runtime?.close();fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
