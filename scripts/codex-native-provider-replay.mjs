// Native OpenAI-mode startup against an isolated, synthetic GitHub source.
// No user profile, real provider, external authentication or App restart is used.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createProviderRuntime } from "../src/provider-runtime.mjs";
import { createAdapterHandler } from "../src/adapter.mjs";
import { configureCodexApi } from "../src/codex-api-config.mjs";
import { deploymentModelId } from "../src/model-capabilities.mjs";
import { codexModelEntry } from "../src/clients/codex-models.mjs";

const [flag, binary] = process.argv.slice(2);assert.ok(flag === "--codex" && path.isAbsolute(binary), "Use --codex /absolute/path/to/codex");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-native-provider-")), profile = path.join(root, "codex"), env = { CODEX_HOME: profile, CCDX_M365: "0", CCDX_DISABLE_USAGE: "1" };
process.env.CCDX_DISABLE_USAGE = "1";fs.mkdirSync(profile);
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${encode({ alg: "none" })}.${encode({ email: "synthetic@example.test", exp: 4102444800, "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account", chatgpt_plan_type: "plus" } })}.synthetic`;
const auth = JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: token, access_token: "synthetic-access", refresh_token: "synthetic-refresh", account_id: "synthetic-account" }, last_refresh: new Date().toISOString() });
fs.writeFileSync(path.join(profile, "auth.json"), auth, { mode: 0o600 });
const ids = Array.from({ length: 7 }, (_, i) => `gpt-replay-${i + 1}`), calls = [], results = [];let handler, runtime, child, upgrades = 0, catalogReads = 0;
const registry = { models: { data: ids.map((id, i) => ({ id, name: `Replay ${i + 1}`, supported_endpoints: ["/responses"], policy: { state: "enabled" }, model_picker_enabled: true,
  capabilities: { limits: { max_context_window_tokens: 128000 }, supports: { reasoning_effort: ["low", "high"], tool_calls: true } } })) } };
const client = { getCachedModelEndpoints: () => ["/responses"], responses: async body => {
  assert.ok(ids.includes(body.model));calls.push(body.model);
  const item = { type: "message", id: `msg_replay_${calls.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "NATIVE_PROVIDER_OK", annotations: [] }] };
  const response = { id: `resp_replay_${calls.length}`, object: "response", model: body.model, output: [item], status: "completed", usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } };
  const events = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } }, { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "NATIVE_PROVIDER_OK" }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} };
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/codex/accounts/check")) { res.writeHead(200, { "Content-Type": "application/json" });res.end(JSON.stringify({ accounts: [{ id: "synthetic-account", name: "Synthetic", plan_type: "plus", workspace_backend_origin: "https://chatgpt.com", account_routing_override: "NO_CONSTRAINT" }] }));return; }
  handler(req, res);
});
server.on("upgrade", (_req, socket) => { upgrades++;socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
const watchdog = setTimeout(() => { console.error("Native provider replay exceeded 120 seconds");process.exit(124); }, 120000);watchdog.unref();
function bounded(promise, label) { let timer;return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + " timed out")), 20000); })]).finally(() => clearTimeout(timer)); }
async function stopChild() {
  if (!child || child.exitCode !== null) return;
  const stopped = new Promise(resolve => child.once("exit", resolve));child.kill();await bounded(stopped, "native process stop");child = null;
}
let port = 0, legacyThread, providerGuardObserved = false;
try {
  for (const state of ["legacy", "temporary-repair", "cold", "legacy-resume", "warm", "old-cache"]) {
    if (state === "old-cache") { const file = path.join(profile, "models_cache.json");if (fs.existsSync(file)) { const cache = JSON.parse(fs.readFileSync(file));cache.client_version = "0.0.0";fs.writeFileSync(file, JSON.stringify(cache)); } }
    await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));port = server.address().port;
    runtime = createProviderRuntime({ home: root, env, platform: process.platform, corePort: port, githubClient: client, githubRegistry: registry, secretStore: { close() {} } });
    if (state === "legacy") await runtime.manageConnections({ operation: "client", id: "codex", enabled: true, allowed: ["github", "m365"], deployments: ids.map(model => ({ source: "github", model })) });
    await runtime.start();
    if (state === "legacy") configureCodexApi({ home: root, env, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "c".repeat(64), model: deploymentModelId("github", ids[0]) });
    if (state === "temporary-repair") {
      // The user's temporary repair already used OpenAI mode but cached v1.2.20
      // qualified IDs. Preserve that fresh cache to test real catalog migration.
      configureCodexApi({ home: root, env, native: true, baseUrl: `http://127.0.0.1:${port}/v1`, model: deploymentModelId("github", ids[0]) });
      const current = runtime.current.bind(runtime);
      runtime.current = req => {
        const selected = current(req);if (!selected?.codexCatalog) return selected;
        const project = selected.codexCatalog;
        return { ...selected, codexCatalog: Object.assign((value, catalog) => {
          const result = project(value, catalog);return { ...result, models: result.models.map(model => ({ ...model, slug: deploymentModelId("github", model.slug), display_name: model.display_name + " · GitHub Copilot" })) };
        }, { needsNativeCatalog: project.needsNativeCatalog }) };
      };
    }
    handler = createAdapterHandler({ providerRuntime: runtime, codexClient: client, modelRegistry: registry, codexModelCatalog: { load: async () => {
      catalogReads++;await new Promise(resolve => setTimeout(resolve, 80));return { models: ids.map(id => codexModelEntry({ id })) };
    } } });
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG"].includes(key)));
    Object.assign(childEnv, { HOME: root, CODEX_HOME: profile, HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1,localhost" });
    const overrides = { chatgpt_base_url: `http://127.0.0.1:${port}`, "features.shell_snapshot": false, "features.plugins": false, "features.remote_plugin": false, "features.apps": false,
      "features.skill_search": false, "features.skill_mcp_dependency_install": false, "analytics.enabled": false, "feedback.enabled": false, check_for_update_on_startup: false };
    if (state === "legacy-resume") overrides.model_provider = "ccdx_gateway";
    const configBytes = fs.readFileSync(path.join(profile, "config.toml"));
    const pending = new Map();let next = 0, buffer = "", resolveTurn, authErrors = 0;
    const turn = new Promise(resolve => { resolveTurn = resolve; });
    const call = (method, params) => bounded(new Promise((resolve, reject) => { const id = ++next;pending.set(id, { method, resolve, reject });child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); }), method);
    child = spawn(binary, [...Object.entries(overrides).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]), "app-server", "--stdio"], { env: childEnv, cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", chunk => { if (/Sign in to ChatGPT/.test(String(chunk))) authErrors++; });child.stdin.on("error", () => {});
    child.on("error", error => { for (const request of pending.values()) request.reject(error); });
    child.stdout.setEncoding("utf8");child.stdout.on("data", chunk => {
      buffer += chunk;let boundary;
      while ((boundary = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, boundary);buffer = buffer.slice(boundary + 1);if (!line) continue;
        const value = JSON.parse(line), request = pending.get(value.id);
        if (request) { pending.delete(value.id);value.error ? request.reject(Object.assign(Error(`${request.method}: ${JSON.stringify(value.error)}`), { rpc: value.error })) : request.resolve(value.result); }
        else if (value.method === "turn/completed") resolveTurn(value.params);
      }
    });
    await call("initialize", { clientInfo: { name: "Codex Desktop", version: "1.0" }, capabilities: { experimentalApi: true } });child.stdin.write('{"method":"initialized","params":{}}\n');
    const expectedProvider = ["legacy", "legacy-resume"].includes(state) ? "ccdx_gateway" : "openai";
    // Ask for models first and concurrently with config/auth, as the App can
    // during startup. No warm-up read or model/list retry may hide an empty list.
    const [catalog, configuration, authStatus] = await Promise.all([
      call("model/list", { includeHidden: true, cursor: null, limit: 100 }),
      call("config/read", { includeLayers: false }), call("getAuthStatus", { includeToken: false, refreshToken: false }),
    ]);
    assert.equal(configuration.config.model_provider ?? "openai", expectedProvider, "The App must stay outside its custom-provider branch after migration");
    assert.equal(configuration.config.model, ["legacy", "temporary-repair"].includes(state) ? deploymentModelId("github", ids[0]) : ids[0]);
    assert.equal(authStatus.authMethod, "chatgpt");
    assert.deepEqual(catalog.data.map(model => model.id), state === "temporary-repair" ? ids.map(id => deploymentModelId("github", id)) : ids, "The first model/list must contain every selected model");
    for (const model of catalog.data) { assert.equal(model.hidden, false);assert.equal(model.availableAccessPrograms, null);if (state !== "temporary-repair") assert.doesNotMatch(model.displayName, /·|GitHub/); }
    if (state === "cold") {
      try {
        const resumed = await call("thread/resume", { threadId: legacyThread, cwd: root, approvalPolicy: "never", sandbox: "read-only" });
        assert.equal(resumed.modelProvider, "ccdx_gateway");
      } catch (error) {
        // Codex 0.166 checks both the saved and current provider before overrides.
        // Respect that boundary instead of rewriting metadata or the native default.
        if (error.rpc?.data?.type !== "modelProviderMismatch") throw error;
        const value = error.rpc;
        assert.equal(value.data?.type, "modelProviderMismatch");
        assert.equal(value.data.modelProvider, "ccdx_gateway");assert.equal(value.data.currentModelProvider, "openai");
        providerGuardObserved = true;
      }
      assert.equal((await call("getAuthStatus", { includeToken: false, refreshToken: false })).authMethod, "chatgpt");
      assert.deepEqual((await call("model/list", { includeHidden: true, cursor: null, limit: 100 })).data.map(model => model.id), ids);
    }
    const thread = state === "legacy-resume"
      ? await call("thread/resume", { threadId: legacyThread, cwd: root, approvalPolicy: "never", sandbox: "read-only" })
      : await call("thread/start", { cwd: root, model: ["legacy", "temporary-repair"].includes(state) ? deploymentModelId("github", ids[0]) : ids[0], approvalPolicy: "never", sandbox: "read-only" });
    if (state === "legacy-resume") {
      assert.equal(thread.thread.id, legacyThread);
      assert.match(JSON.stringify(await call("thread/read", { threadId: legacyThread, includeTurns: true })), /NATIVE_PROVIDER_OK/);
    }
    if (state === "legacy") legacyThread = thread.thread.id;
    assert.equal(thread.modelProvider, expectedProvider);
    await call("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Reply with NATIVE_PROVIDER_OK.", text_elements: [] }] });
    const completed = await bounded(turn, "native turn");assert.equal(completed.turn.status, "completed");
    const read = await call("thread/read", { threadId: thread.thread.id, includeTurns: true });assert.match(JSON.stringify(read), /NATIVE_PROVIDER_OK/);
    assert.equal(fs.readFileSync(path.join(profile, "auth.json"), "utf8"), auth);assert.equal(authErrors, 0);
    assert.deepEqual(fs.readFileSync(path.join(profile, "config.toml")), configBytes, "Per-process provider selection must not change the global config");
    results.push({ state, auth: "chatgpt", provider: expectedProvider, ...(state === "cold" ? { provider_guard_observed: providerGuardObserved } : {}), ...(state === "legacy-resume" ? { legacy_session_resumed: true, legacy_turn_completed: true, global_config_unchanged: true } : {}), first_catalog_models: catalog.data.length, completed: true, auth_errors: authErrors });
    await stopChild();handler.dispose?.();server.closeAllConnections();await new Promise(resolve => server.close(resolve));await runtime.close();runtime = null;
  }
  console.log(JSON.stringify({ results, synthetic_upstream_requests: calls.length, catalog_reads: catalogReads, websocket_fallbacks: upgrades, live_provider_calls: 0 }));
} finally {
  await stopChild();handler?.dispose?.();server.closeAllConnections();if (server.listening) await new Promise(resolve => server.close(resolve));await runtime?.close();fs.rmSync(root, { recursive: true, force: true });clearTimeout(watchdog);
}
