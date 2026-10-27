import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { parse } from "smol-toml";
import { accessSettingsPath, readAccessSettings, updateAccessSettings, checkedApi, defaultAccessSettings } from "../src/access-settings.mjs";
import { createApiSecretStore } from "../src/api-secrets.mjs";
import { createApiProvider } from "../src/providers/api.mjs";
import { createProviderRuntime } from "../src/provider-runtime.mjs";
import { readClientGatewayKeys } from "../src/client-gateway-keys.mjs";
import { configureCodexApi } from "../src/codex-api-config.mjs";
import { runWithRequestContext } from "../src/request-context.mjs";
import { updateM365Settings } from "../src/m365-settings.mjs";
import { transportErrorDetails } from "../src/operation-error.mjs";
import { claudeModelEntries } from "../src/claude-models.mjs";

process.env.CCDX_DISABLE_USAGE = "1";

const apiConfig = { id: "api_example", name: "Example", enabled: true, base_url: "https://api.example.test/v1", endpoints: {
  messages: "https://api.example.test/v1/messages", responses: "https://api.example.test/v1/responses", chat: "https://api.example.test/v1/chat/completions" },
  auth_header: "x-api-key", secret_ref: "a".repeat(32), models: [{ id: "any-message-model", protocols: ["messages"] }, { id: "custom/response", protocols: ["responses"] }] };
const localHome = t => { const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-connections-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));return home; };
const secrets = () => { const values = new Map();return { values, get: async id => values.get(id) || "synthetic-key-only", set: async (id, key) => { values.set(id, key); }, remove: async id => { values.delete(id); }, close() {} }; };
function runtime(t, overrides = {}) {
  const home = localHome(t), calls = [], catalogCalls = [], stored = secrets(), configured = [];
  overrides.prepareHome?.(home);
  const result = createProviderRuntime({ home, env: { CCDX_M365: "0" }, platform: "linux", secretStore: stored,
    githubClient: {}, githubRegistry: { models: { data: [] } }, inspectDesktop: async () => false,
    configureClaude: input => { configured.push(input);return { [input.client === "claude_app" ? "app" : "code"]: "configured" }; },
    restoreClaude: () => ({ preserved: 0 }),
    createApi: options => createApiProvider({ ...options, networkFactory: async () => ({ close() {}, async fetch(url, init) {
      const body = init.body ? JSON.parse(init.body) : null;(body ? calls : catalogCalls).push({ url, init });
      if (!body) return Response.json({ data: [{ id: "model-new" }] });
      if (url.endsWith("messages")) return Response.json({ type: "message", id: "msg_local", model: body.model, role: "assistant", content: [{ type: "text", text: "synthetic" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } });
      return Response.json({ id: "resp_local", object: "response", status: "completed", model: body.model, output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "synthetic", annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 2 } });
    } }) }), ...overrides });
  t.after(() => result.close());return { home, env: overrides.env || { CCDX_M365: "0" }, runtime: result, calls, catalogCalls, stored, configured };
}
async function save(r, options = {}) {
  const { id, enabled, secret_ref, ...config } = structuredClone(apiConfig);
  const state = await r.manageConnections({ operation: "save_api", config, allowed: ["codex", "claude_app", "claude_code"], key: "synthetic-key-only", ...options });
  const savedId = state.providers.find(p => !p.builtin).id;await r.manageConnections({ operation: "discover", id: savedId });return savedId;
}
function invoke(handler, { url = "/v1/messages", headers = {}, body = { model: "any-message-model", messages: [{ role: "user", content: "synthetic" }], max_tokens: 4 } } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(req, { url, method: "POST", headers: { host: "127.0.0.1:2026", "content-type": "application/json", ...headers }, socket: { remoteAddress: "127.0.0.1" } });
    const res = new EventEmitter();res.headersSent = false;res.writableEnded = false;res.destroyed = false;res.statusCode = 200;let value = "";
    res.setHeader = () => {};res.writeHead = status => { res.statusCode = status;res.headersSent = true; };res.write = chunk => { value += chunk;return true; };res.end = chunk => { value += chunk || "";res.writableEnded = true;res.emit("finish");resolve({ status: res.statusCode, body: value }); };res.destroy = reject;
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test("connections fail closed on corrupt files and validate origin, model APIs and stable IDs", t => {
  const home = localHome(t), options = { home, env: {} }, file = accessSettingsPath(options);
  assert.equal(readAccessSettings(options).clients.codex.enabled, true);assert.equal(fs.existsSync(file), false);
  assert.equal(checkedApi(structuredClone(apiConfig)).id, apiConfig.id);
  for (const bad of [
    { ...apiConfig, base_url: "http://api.example.test/v1" },
    { ...apiConfig, endpoints: { messages: "https://other.test/messages" } },
    { ...apiConfig, models: [{ id: "same", protocols: ["messages"] }, { id: "same", protocols: ["responses"] }] },
    { ...apiConfig, models: [{ id: "a", protocols: [] }] },
    { ...apiConfig, key: "must-not-be-config" },
  ]) assert.throws(() => checkedApi(bad), { statusCode: 400 });
  fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, "{broken");
  assert.throws(() => updateAccessSettings(() => defaultAccessSettings(), options), { code: "ccdx_connections_invalid" });assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});

test("restoring M365 never selects paused legacy Claude clients and M365 counts stay source-scoped", async t => {
  let legacyConfigured = 0;
  const gpt = id => ({ id, supported_endpoints: ["/responses"], capabilities: { supports: { reasoning_effort: ["low", "high"] } } });
  const models = [{ id: "ms-message", supported_endpoints: ["/v1/messages"] }, gpt("gpt-one"), gpt("gpt-two")];
  const s = runtime(t, { env: {}, platform: "darwin", prepareHome: home => updateM365Settings({ enabled: false }, { home, env: {} }),
    configureClients: () => { legacyConfigured++;return { code: "configured", app: "configured" }; },
    createM365: () => ({ id: "m365", refresh: async () => {}, close() {}, profileId: () => "m365:synthetic-account", registry: { models: { data: models.slice(1) } },
      models: family => family === "claude" ? models.slice(0, 1) : models.slice(1), catalog: () => models,
      snapshot: () => ({ state: "ready", models: { total: 3, claude: 1, gpt: 2, source: "cache" } }),
      client: { messages: async body => Response.json({ type: "message", id: "ms_local", model: body.model, content: [], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }) },
    }) });
  const id = await save(s.runtime);await s.runtime.manageConnections({ operation: "provider", id: "m365", enabled: true });
  assert.equal(legacyConfigured, 0);assert.equal(s.runtime.connections().clients.find(c => c.id === "claude_app").source, null);
  await assert.rejects(invoke(s.runtime.handleClaude), { code: "ccdx_client_source_disabled" });
  for (const [name, source] of [["claude_app", "m365"], ["claude_code", id], ["codex", "m365"]]) {
    const c = s.runtime.connections().clients.find(c => c.id === name);await s.runtime.manageConnections({ operation: "client", id: name, source, enabled: true, allowed: c.allowed });
  }
  const local = readClientGatewayKeys({ home: s.home, env: s.env });
  assert.equal((await invoke(s.runtime.handleClaude, { headers: { authorization: `Bearer ${local.claude_app}` }, body: { model: "ms-message", messages: [{ role: "user", content: "m365-synthetic" }], max_tokens: 4 } })).status, 200);
  assert.equal((await invoke(s.runtime.handleClaude, { headers: { authorization: `Bearer ${local.claude_code}` } })).status, 200);
  const state = s.runtime.snapshot();assert.equal(state.claude.requests.completed, 2);assert.equal(state.m365.claude.requests.completed, 1);assert.equal(state.m365.claude.clients.code, "not_selected");
  await s.runtime.action({ action: "auto-review", provider: "m365", model: "gpt-two", effort: "high" });
  assert.equal(s.runtime.providerPreference("m365").auto_review_model, "gpt-two");assert.equal(s.runtime.snapshot().m365.preference.auto_review_effort, "high");
});

test("OS secrets use private stdin, cache reads, and fail without plaintext fallback", async t => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const home = localHome(t), calls = [], key = "key-TEST-only-123", ref = "b".repeat(32);
    const store = createApiSecretStore({ home, env: {}, platform, run: async (command, args, input) => { calls.push({ command, args, input });
      if (platform === "win32") return input.trimEnd() === key ? "a".repeat(256) : key;return command.endsWith("security") && args.includes("-w") || args[0] === "lookup" ? key : ""; } });
    await store.set(ref, key);assert.equal(await store.get(ref), key);
    assert.ok(calls.every(call => !call.args.join(" ").includes(key)));assert.equal(calls[0].input.includes(key), true);
    store.close();assert.equal(await store.get(ref), key);store.close();
    if (platform === "win32") {
      const file = path.join(path.dirname(accessSettingsPath({ home, env: {} })), "api-secrets", ref);
      assert.equal(fs.readFileSync(file, "utf8").includes(key), false);assert.ok(calls[0].args.at(-1).includes("ProtectedData]::Protect"));
      const before = calls.length;fs.writeFileSync(file, "not encrypted bytes");await assert.rejects(store.get(ref), { code: "ccdx_api_secret_unavailable" });assert.equal(calls.length, before);
    }
    const blocked = createApiSecretStore({ home, env: {}, platform, run: async () => { throw Error("private detail"); } });await assert.rejects(blocked.set("c".repeat(32), key));
    assert.equal(fs.existsSync(accessSettingsPath({ home, env: {} })), false);
  }
});

test("a successful interactive Keychain exit is not accepted until its stored value is confirmed", async t => {
  const home = localHome(t), store = createApiSecretStore({ home, env: {}, platform: "darwin", run: async (_command, args) => args[0] === "-i" ? "" : "different-synthetic-value" });
  await assert.rejects(store.set("f".repeat(32), "synthetic-key-only"), { code: "ccdx_api_secret_unavailable" });store.close();
});

test("manual API save reads only the catalog and does not activate a client", async t => {
  const s = runtime(t), id = await save(s.runtime);
  assert.equal(s.calls.length, 0);assert.equal(s.runtime.selection().codex, "github");
  const publicData = JSON.stringify(s.runtime.connections());assert.equal(publicData.includes("synthetic-key-only"), false);assert.equal(publicData.includes("secret_ref"), false);
  assert.equal(fs.readFileSync(accessSettingsPath({ home: s.home, env: s.env }), "utf8").includes("synthetic-key-only"), false);
  assert.deepEqual(s.runtime.connections().clients.find(c => c.id === "claude_app").allowed, ["m365", id]);
});

test("a slow catalog cannot block unrelated configuration and disabling aborts its publication", async t => {
  let release, signal;
  const s = runtime(t, { createApi: options => createApiProvider({ ...options, networkFactory: async () => ({ close() {}, fetch: async (_url, init) => {
    signal = init.signal;return new Promise(resolve => { release = resolve; });
  } }) }) });
  const { id: _id, enabled: _enabled, secret_ref: _secret, ...config } = structuredClone(apiConfig);
  const saved = await s.runtime.manageConnections({ operation: "save_api", config, key: "synthetic-key-only", allowed: [] });
  const id = saved.providers.find(p => !p.builtin).id;
  await new Promise(resolve => setImmediate(resolve));assert.ok(release);
  const pending = s.runtime.manageConnections({ operation: "discover", id });const failed = assert.rejects(pending, { code: "ccdx_connections_conflict" });
  const changed = await Promise.race([s.runtime.manageConnections({ operation: "client", id: "codex", enabled: false, source: null, allowed: ["github", "m365"] }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Catalog blocked configuration")), 1000);timer.unref(); })]);
  assert.equal(changed.clients.find(c => c.id === "codex").enabled, false);
  await s.runtime.manageConnections({ operation: "provider", id, enabled: false });assert.equal(signal.aborted, true);
  release(Response.json({ data: [{ id: "late", context_window: 1000000 }] }));await failed;
  assert.equal(s.runtime.connections().providers.find(p => p.id === id).checked_at, undefined);
});

test("Claude clients route independently and hints cannot impersonate another credential", async t => {
  const s = runtime(t), id = await save(s.runtime), keys = readClientGatewayKeys({ home: s.home, env: {} });
  const c = s.runtime.connections().clients.find(c => c.id === "claude_app");
  await s.runtime.manageConnections({ operation: "client", id: c.id, enabled: true, allowed: c.allowed, source: id });
  const result = await runWithRequestContext({ requestId: "synthetic-app" }, () => invoke(s.runtime.handleClaude, { headers: { authorization: `Bearer ${keys.claude_app}`, "x-ccdx-client": "claude-code" } }));
  assert.equal(result.status, 200);assert.equal(s.calls.length, 1);assert.equal(s.calls[0].init.headers["x-api-key"], "synthetic-key-only");
  assert.equal(s.calls[0].init.headers["X-ClientType"], undefined);
  assert.ok(s.configured.every(input => input.client === "claude_app"));
  assert.ok(s.configured.every(input => input.desktopAliases === true));
  assert.ok(s.configured.every(input => input.defaultModel === undefined), "Legacy bindings preserve client defaults and model order");
  await assert.rejects(invoke(s.runtime.handleClaude, { headers: { authorization: `Bearer ${keys.claude_code}`, "x-ccdx-client": "claude-app" } }), { code: "ccdx_client_source_disabled" });
  await assert.rejects(invoke(s.runtime.handleClaude, { headers: { authorization: "Bearer invalid", "x-ccdx-client": "claude-app" } }), { statusCode: 401 });
  const stats = s.runtime.snapshot().claude.requests.performance.recent_requests;
  assert.equal(stats[0].application, "claude_app");assert.equal(stats[0].provider, id);
});

test("App aliases stay source-bound and cannot be activated by a Code request header", async t => {
  const s = runtime(t), id = await save(s.runtime), keys = readClientGatewayKeys({ home: s.home, env: {} });
  for (const name of ["claude_app", "claude_code"]) {
    const c = s.runtime.connections().clients.find(c => c.id === name);
    await s.runtime.manageConnections({ operation: "client", id: name, enabled: true, allowed: c.allowed, source: id });
  }
  const alias = claudeModelEntries([{ id: "any-message-model" }], { desktopAliases: true })[0].name;
  const body = { model: alias, messages: [{ role: "user", content: "synthetic" }], max_tokens: 4 };
  const reply = await invoke(s.runtime.handleClaude, { headers: { authorization: `Bearer ${keys.claude_app}` }, body });
  assert.equal(reply.status, 200);assert.equal(JSON.parse(reply.body).model, alias);
  assert.equal(JSON.parse(s.calls[0].init.body).model, "any-message-model");
  assert.equal((await invoke(s.runtime.handleClaude, { headers: { authorization: `Bearer ${keys.claude_code}`, "x-ccdx-client": "claude-app" }, body })).status, 400);
  assert.equal(s.calls.length, 1);
  assert.equal((await invoke(s.runtime.handleClaude, { headers: { authorization: `Bearer ${keys.claude_code}` } })).status, 200);
  assert.equal(s.configured.findLast(input => input.client === "claude_code").desktopAliases, false);
  const unavailable = claudeModelEntries([{ id: "custom/response" }], { desktopAliases: true })[0].name;
  assert.equal((await invoke(s.runtime.handleClaude, { headers: { authorization: `Bearer ${keys.claude_app}` }, body: { ...body, model: unavailable } })).status, 400);
  assert.equal(s.calls.length, 2, "App aliases cannot grant Messages access to a Responses-only model");
});

test("custom Responses requires the Codex credential and exposes only configured models", async t => {
  const s = runtime(t), id = await save(s.runtime), c = s.runtime.connections().clients.find(c => c.id === "codex");
  await s.runtime.manageConnections({ operation: "client", id: c.id, enabled: true, allowed: c.allowed, source: id, model: "custom/response", auto_review_model: "custom/response" });
  const keys = readClientGatewayKeys({ home: s.home, env: {} });
  assert.throws(() => s.runtime.current({ headers: { authorization: `Bearer ${keys.claude_app}` } }), { statusCode: 403 });
  const target = s.runtime.current({ headers: { authorization: `Bearer ${keys.codex}` } });assert.equal(target.id, id);
  assert.deepEqual(JSON.parse((await target.client.listModels()).body).data.map(m => m.id), ["custom/response"]);
  const config = parse(fs.readFileSync(path.join(s.home, ".codex", "config.toml"), "utf8"));
  assert.equal(config.model_providers.ccdx_gateway.base_url, "http://127.0.0.1:2026/v1");assert.equal(config.model_providers.ccdx_gateway.experimental_bearer_token, keys.codex);
  assert.throws(() => target.selectModel({}, { upstreamModel: "any-message-model" }), { code: "ccdx_api_model_unavailable" });
  assert.deepEqual(s.runtime.historyContext({}, target), { historyNamespace: target.profileId() });
});

test("disable rejects new requests, retains in-flight providers and restores without silent switching", async t => {
  const s = runtime(t), id = await save(s.runtime), c = s.runtime.connections().clients.find(c => c.id === "codex");
  await s.runtime.manageConnections({ operation: "client", id: c.id, enabled: true, allowed: c.allowed, source: id });
  const selected = s.runtime.current(), finish = s.runtime.track(selected);
  await assert.rejects(s.runtime.manageConnections({ operation: "provider", id, enabled: false }), { code: "ccdx_source_in_use" });
  await s.runtime.manageConnections({ operation: "provider", id, enabled: false, replacements: { codex: null } });
  assert.equal(s.runtime.dashboardProviders().some(p => p.id === id), false);assert.equal(s.runtime.connections().providers.find(p => p.id === id).enabled, false);
  assert.throws(() => s.runtime.current(), { code: "ccdx_client_source_disabled" });
  assert.equal((await selected.client.responses({ model: "custom/response", input: [] })).status, 200);finish();
  await s.runtime.manageConnections({ operation: "provider", id, enabled: true });assert.equal(s.runtime.selection().codex, null);
  assert.equal(s.runtime.connections().providers.find(p => p.id === id).key_saved, true);
});

test("catalog discovery does not invent API support or make inference calls", async t => {
  const s = runtime(t), id = await save(s.runtime), result = await s.runtime.manageConnections({ operation: "discover", id });
  assert.deepEqual(result.discovered.map(({ id, protocols, metadata }) => ({ id, protocols, state: metadata.state })), [{ id: "model-new", protocols: [], state: "missing" }]);assert.equal(s.calls.length, 0);assert.equal(s.catalogCalls.length, 1);assert.equal(s.catalogCalls[0].init.method, "GET");
});

test("Codex ownership preserves unrelated configuration and user edits", t => {
  const home = localHome(t), file = path.join(home, ".codex", "config.toml");fs.mkdirSync(path.dirname(file));
  const before = '# keep this comment\nmodel = "chosen"\n[features]\ncontext_management = true\n';fs.writeFileSync(file, before);
  assert.equal(configureCodexApi({ home, env: {}, baseUrl: "http://127.0.0.1:2026/v1", apiKey: "d".repeat(64) }).state, "configured");
  const after = fs.readFileSync(file, "utf8");assert.match(after, /# keep this comment/);assert.equal(parse(after).features.context_management, true);
  configureCodexApi({ home, env: {}, restore: true });assert.equal(parse(fs.readFileSync(file, "utf8")).model, "chosen");assert.equal(parse(fs.readFileSync(file, "utf8")).model_provider, undefined);
  configureCodexApi({ home, env: {}, baseUrl: "http://127.0.0.1:2026/v1", apiKey: "d".repeat(64) });fs.appendFileSync(file, "# custom provider edit\n");
  assert.equal(configureCodexApi({ home, env: {}, restore: true }).state, "preserved");
});

test("Codex gateway retains existing sign-in without changing its credentials", t => {
  const home = localHome(t), directory = path.join(home, ".codex"), file = path.join(directory, "config.toml"), authFile = path.join(directory, "auth.json");
  fs.mkdirSync(directory);const before = 'model = "original"\n';fs.writeFileSync(file, before);
  const options = { home, env: {}, baseUrl: "http://127.0.0.1:2026/v1", apiKey: "d".repeat(64) };
  for (const auth of [{ auth_mode: "chatgpt", tokens: { access_token: "synthetic-only" } }, { OPENAI_API_KEY: "synthetic-only" }]) {
    const bytes = JSON.stringify(auth);fs.writeFileSync(authFile, bytes);const modified = fs.statSync(authFile).mtimeMs;
    configureCodexApi(options);assert.equal(parse(fs.readFileSync(file, "utf8")).model_providers.ccdx_gateway.requires_openai_auth, true);
    if (auth.auth_mode === "chatgpt") {
      const journal = path.join(path.dirname(accessSettingsPath({ home, env: {} })), "codex-gateway-owner.json");
      const owner = JSON.parse(fs.readFileSync(journal, "utf8")), oldSection = owner.section.replace(/^requires_openai_auth = true\n/m, "");
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(owner.section, oldSection));owner.section = oldSection;fs.writeFileSync(journal, JSON.stringify(owner));
      configureCodexApi(options);assert.equal(parse(fs.readFileSync(file, "utf8")).model_providers.ccdx_gateway.requires_openai_auth, true, "An unchanged 1.2.17 owned section is repaired");
    }
    assert.equal(fs.readFileSync(authFile, "utf8"), bytes);assert.equal(fs.statSync(authFile).mtimeMs, modified);
    configureCodexApi({ ...options, restore: true });assert.equal(parse(fs.readFileSync(file, "utf8")).model, "original");
    assert.equal(parse(fs.readFileSync(file, "utf8")).model_provider, undefined);
  }
  fs.rmSync(authFile);configureCodexApi(options);
  assert.equal(parse(fs.readFileSync(file, "utf8")).model_providers.ccdx_gateway.requires_openai_auth, false, "A fresh API-only installation needs no OpenAI sign-in");
  configureCodexApi({ ...options, restore: true });
  fs.writeFileSync(file, before + 'cli_auth_credentials_store = "keyring"\n');configureCodexApi(options);
  assert.equal(parse(fs.readFileSync(file, "utf8")).model_providers.ccdx_gateway.requires_openai_auth, true, "Keychain sign-in must not be masked when no auth.json exists");
  configureCodexApi({ ...options, restore: true });
  fs.writeFileSync(file, before);fs.writeFileSync(authFile, "invalid synthetic auth");
  assert.throws(() => configureCodexApi(options), { code: "ccdx_codex_config_invalid" });assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("a native model choice does not block repair of the separately owned Codex auth section", t => {
  const home = localHome(t), directory = path.join(home, ".codex"), file = path.join(directory, "config.toml");fs.mkdirSync(directory);
  fs.writeFileSync(file, 'model = "original"\n');
  const options = { home, env: {}, baseUrl: "http://127.0.0.1:2026/v1", apiKey: "d".repeat(64), model: "gateway-default" };
  configureCodexApi(options);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('model = "gateway-default"', 'model = "user-chosen-model"'));
  const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic-only" } });fs.writeFileSync(path.join(directory, "auth.json"), auth);
  assert.equal(configureCodexApi(options).state, "preserved");
  const result = parse(fs.readFileSync(file, "utf8"));assert.equal(result.model, "user-chosen-model");assert.equal(result.model_providers.ccdx_gateway.requires_openai_auth, true);
  assert.equal(fs.readFileSync(path.join(directory, "auth.json"), "utf8"), auth);
  const before = fs.readFileSync(file, "utf8");assert.equal(configureCodexApi({ ...options, restore: true }).state, "preserved");assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("upstream errors cannot echo the API key or leak vendor error bodies", async () => {
  const p = createApiProvider({ config: apiConfig, secrets: { get: async () => "synthetic-key-only" }, networkFactory: async () => ({ close() {}, fetch: async () => Response.json({ error: { message: "synthetic-key-only private vendor body" } }, { status: 403 }) }) });
  try { const response = await p.client.messages({ model: "any-message-model", messages: [] });assert.equal(response.status, 403);const text = await response.text();assert.equal(text.includes("synthetic-key-only"), false);assert.match(text, /ccdx_api_http_403/); } finally { p.close(); }
});

test("public snapshots and save inputs cannot mutate the live connection graph", async t => {
  const s = runtime(t), id = await save(s.runtime), before = fs.readFileSync(accessSettingsPath({ home: s.home, env: s.env }), "utf8");
  const view = s.runtime.connections(), api = view.providers.find(p => p.id === id);
  api.models.length = 0;api.endpoints.responses = "https://other.test/responses";view.clients[0].allowed.length = 0;
  assert.equal(s.runtime.connections().providers.find(p => p.id === id).models.length, 2);
  const { id: omitted, enabled, secret_ref, ...config } = structuredClone(apiConfig);
  await s.runtime.manageConnections({ operation: "save_api", id, config, allowed: ["codex", "claude_app", "claude_code"] });
  config.models.length = 0;
  assert.equal(s.runtime.connections().providers.find(p => p.id === id).models.length, 2);
  assert.equal(fs.readFileSync(accessSettingsPath({ home: s.home, env: s.env }), "utf8").includes("other.test"), false);assert.ok(before.length > 0);
});

test("headless API keys can use an explicit environment reference without any credential utility", async t => {
  const external = "synthetic-env-key-only", s = runtime(t, { env: { CCDX_M365: "0", CCDX_TEST_API_KEY: external } });
  const config = { name: "Environment API", base_url: apiConfig.base_url, endpoints: { responses: apiConfig.endpoints.responses }, auth_header: "bearer",
    key_env: "CCDX_TEST_API_KEY", models: [{ id: "env-model", protocols: ["responses"] }] };
  const saved = await s.runtime.manageConnections({ operation: "save_api", config, allowed: ["codex"] });
  assert.equal(s.stored.values.size, 0);assert.equal(JSON.stringify(saved).includes(external), false);
  assert.equal(fs.readFileSync(accessSettingsPath({ home: s.home, env: s.env }), "utf8").includes(external), false);
  const id = saved.providers.find(p => !p.builtin).id, c = saved.clients.find(c => c.id === "codex");
  await s.runtime.manageConnections({ operation: "client", id: c.id, enabled: true, allowed: c.allowed, source: id });
  assert.equal((await s.runtime.current().client.responses({ model: "env-model", input: [] })).status, 200);
  assert.equal(s.calls[0].init.headers.Authorization, `Bearer ${external}`);
});

test("a missing environment key can be configured but cannot activate a client", async t => {
  const s = runtime(t), config = { name: "Missing", base_url: apiConfig.base_url, endpoints: { responses: apiConfig.endpoints.responses }, auth_header: "bearer",
    key_env: "CCDX_ABSENT_API_KEY", models: [{ id: "env-model", protocols: ["responses"] }] };
  const saved = await s.runtime.manageConnections({ operation: "save_api", config, allowed: ["codex"] }), api = saved.providers.find(p => !p.builtin), c = saved.clients.find(c => c.id === "codex");
  assert.equal(api.key_saved, false);
  await assert.rejects(s.runtime.manageConnections({ operation: "client", id: c.id, enabled: true, allowed: c.allowed, source: api.id }), { code: "ccdx_api_environment_key_missing" });
  assert.equal(s.runtime.selection().codex, "github");assert.equal(s.calls.length, 0);
});

test("conflicting external settings are preserved and a candidate key is rolled back", async t => {
  const s = runtime(t), id = await save(s.runtime), file = accessSettingsPath({ home: s.home, env: s.env });
  const next = readAccessSettings({ home: s.home, env: s.env });next.clients.codex.enabled = false;fs.writeFileSync(file, JSON.stringify(next));const bytes = fs.readFileSync(file);
  const { id: ignored, enabled, secret_ref, ...config } = structuredClone(apiConfig);
  await assert.rejects(s.runtime.manageConnections({ operation: "save_api", id, config, key: "replacement-synthetic-key", allowed: ["codex", "claude_app", "claude_code"] }), { code: "ccdx_connections_conflict" });
  assert.equal(fs.readFileSync(file).equals(bytes), true);assert.equal(s.stored.values.size, 1);assert.equal([...s.stored.values.values()][0], "synthetic-key-only");
});

test("Codex model selection survives repeated owned configuration updates and restores the original model", t => {
  const home = localHome(t), file = path.join(home, ".codex", "config.toml");fs.mkdirSync(path.dirname(file));fs.writeFileSync(file, 'model = "original"\n');
  const options = { home, env: {}, baseUrl: "http://127.0.0.1:2026/v1", apiKey: "d".repeat(64), model: "vendor/model" };
  configureCodexApi(options);const first = fs.statSync(file).mtimeMs;configureCodexApi(options);assert.equal(fs.statSync(file).mtimeMs, first);
  configureCodexApi({ ...options, model: "vendor/second" });configureCodexApi({ home, env: {}, restore: true });
  const config = parse(fs.readFileSync(file, "utf8"));assert.equal(config.model, "original");assert.equal(config.model_provider, undefined);assert.equal(config.model_providers?.ccdx_gateway, undefined);
});

test("Windows CurrentUser credential protection round-trips without storing the plaintext", { skip: process.platform !== "win32" }, async t => {
  const home = localHome(t), env = { ...process.env, XDG_CONFIG_HOME: path.join(home, ".config") }, store = createApiSecretStore({ home, env }), ref = "e".repeat(32), key = "ccdx-synthetic-roundtrip-only";
  await store.set(ref, key);store.close();assert.equal(await store.get(ref), key);
  const file = path.join(path.dirname(accessSettingsPath({ home, env })), "api-secrets", ref);assert.equal(fs.readFileSync(file, "utf8").includes(key), false);await store.remove(ref);assert.equal(fs.existsSync(file), false);store.close();
});

test("Claude App can rebuild a selected source after key rotation and retains only hashes", async t => {
  const s = runtime(t), id = await save(s.runtime), c = s.runtime.connections().clients.find(c => c.id === "claude_app");
  await s.runtime.manageConnections({ operation: "client", id: c.id, enabled: true, allowed: c.allowed, source: id });
  const key = readClientGatewayKeys({ home: s.home, env: s.env }).claude_app, headers = { Authorization: `Bearer ${key}`, "x-conversation-id": "synthetic-session-only" };
  // IncomingMessage normalizes header names; use that same native shape here.
  headers.authorization = headers.Authorization;delete headers.Authorization;
  assert.equal((await invoke(s.runtime.handleClaude, { headers })).status, 200);
  const { id: omitted, enabled, secret_ref, ...config } = structuredClone(apiConfig);
  await s.runtime.manageConnections({ operation: "save_api", id, config, key: "rotated-synthetic-key", allowed: ["codex", "claude_app", "claude_code"] });
  const old = await invoke(s.runtime.handleClaude, { headers, body: { model: "any-message-model", messages: [{ role: "user", content: "synthetic" }, { role: "assistant", content: "old" }, { role: "user", content: "next" }], max_tokens: 4 } });
  assert.equal(old.status, 200);assert.equal(s.calls.length, 2);
  assert.equal((await invoke(s.runtime.handleClaude, { headers: { ...headers, "x-conversation-id": "fresh-session-only" } })).status, 200);
  const owners = fs.readFileSync(path.join(path.dirname(accessSettingsPath({ home: s.home, env: s.env })), "conversation-sources.json"), "utf8");
  for (const secret of ["synthetic-session-only", "fresh-session-only", "synthetic-key-only", "rotated-synthetic-key", "any-message-model"]) assert.equal(owners.includes(secret), false);
});

test("Claude Code retains its source guard across API key rotation", async t => {
  const s = runtime(t), id = await save(s.runtime), client = s.runtime.connections().clients.find(c => c.id === "claude_code");
  await s.runtime.manageConnections({ operation: "client", id: client.id, enabled: true, allowed: client.allowed, source: id });
  const headers = { authorization: `Bearer ${readClientGatewayKeys({ home: s.home, env: s.env }).claude_code}`, "x-conversation-id": "code-session" };
  assert.equal((await invoke(s.runtime.handleClaude, { headers })).status, 200);
  const { id: omitted, enabled, secret_ref, ...config } = structuredClone(apiConfig);
  await s.runtime.manageConnections({ operation: "save_api", id, config, key: "rotated-synthetic-key", allowed: ["codex", "claude_app", "claude_code"] });
  assert.equal((await invoke(s.runtime.handleClaude, { headers, body: { model: "any-message-model", messages: [{ role: "user", content: "synthetic" }, { role: "assistant", content: "old" }, { role: "user", content: "next" }], max_tokens: 4 } })).status, 409);
  assert.equal(s.calls.length, 1);
});

test("API worker recovery is deferred to a later request and never replays a failed call", async () => {
  let created = 0, requests = 0, healthy = true;
  const provider = createApiProvider({ config: apiConfig, secrets: { get: async () => "synthetic-key-only" }, networkFactory: async () => {
    const first = ++created === 1;return { healthy: () => !first || healthy, close() {}, async fetch() { requests++;if (first) { healthy = false;throw Error("worker ended"); }return Response.json({ ok: true }); } };
  } });
  try { await assert.rejects(provider.client.messages({ model: "any-message-model", messages: [] }), { code: "ccdx_api_network_unavailable" });assert.equal(requests, 1);
    assert.equal((await provider.client.messages({ model: "any-message-model", messages: [] })).status, 200);assert.equal(created, 2);assert.equal(requests, 2);
  } finally { provider.close(); }
});

test("API transport errors preserve only bounded diagnostic fields without exposing upstream secrets", async () => {
  const cause = Object.assign(new Error("https://private.test synthetic-key-only private prompt"), { code: "ECONNRESET",
    transport: { code: "ECONNRESET", phase: "tls", reused_socket: true, hostname: "private.test", key: "synthetic-key-only" } });
  const provider = createApiProvider({ config: apiConfig, secrets: { get: async () => "synthetic-key-only" },
    networkFactory: async () => ({ close() {}, fetch: async () => { throw cause; } }) });
  try {
    await assert.rejects(provider.client.messages({ model: "any-message-model", messages: [] }), error => {
      assert.equal(error.code, "ccdx_api_network_unavailable");assert.equal(error.cause, cause);
      assert.deepEqual(error.transport, { code: "ECONNRESET", phase: "tls", reused_socket: true });
      const json = JSON.stringify(error.jsonBody);assert.equal(json.includes("private"), false);assert.equal(json.includes("synthetic-key-only"), false);return true;
    });
  } finally { provider.close(); }
});

test("unrecognized transport codes and phases cannot carry arbitrary diagnostic content", () => {
  assert.deepEqual(transportErrorDetails({ code: "synthetic-private-key", message: "private prompt", transport: { code: "synthetic-private-key", phase: "https://private.test", reused_socket: "private" } }),
    { code: "unknown", phase: "unknown", reused_socket: null });
  assert.equal(transportErrorDetails({ code: "HPE_INVALID_CONSTANT" }).code, "HPE_INVALID_CONSTANT");
});

test("catalog and display edits refresh metadata without changing existing Responses history identity", () => {
  const initial = { ...structuredClone(apiConfig), endpoints: { responses: apiConfig.endpoints.responses }, models: apiConfig.models.filter(m => m.protocols.includes("responses")) };
  const updated = { ...structuredClone(initial), name: "Renamed", endpoints: { ...initial.endpoints, messages: apiConfig.endpoints.messages },
    models: [...initial.models, { id: "new-message-model", protocols: ["messages"] }] };
  const a = createApiProvider({ config: initial, secrets: {} }), b = createApiProvider({ config: updated, secrets: {} });
  try { assert.equal(a.profileId(), b.profileId());assert.notEqual(a.registry.generation, b.registry.generation);assert.notEqual(a.profileId("messages"), b.profileId("messages")); }
  finally { a.close();b.close(); }
});

test("new requests cannot retain an old credential after its last pinned request finishes", async t => {
  const s = runtime(t), id = await save(s.runtime), c = s.runtime.connections().clients.find(c => c.id === "codex");
  await s.runtime.manageConnections({ operation: "client", id: c.id, source: id, enabled: true, allowed: c.allowed });
  const old = s.runtime.current(), finishOld = s.runtime.track(old), oldRef = [...s.stored.values.keys()][0];
  const { id: ignored, enabled, secret_ref, ...config } = structuredClone(apiConfig);
  await s.runtime.manageConnections({ operation: "save_api", id, config, key: "new-synthetic-credential", allowed: ["codex", "claude_app", "claude_code"] });
  const finishNew = s.runtime.track(s.runtime.current());assert.equal(s.stored.values.has(oldRef), true);finishOld();
  await Promise.resolve();assert.equal(s.stored.values.has(oldRef), false);assert.equal(s.stored.values.size, 1);finishNew();
});

test("the full declared source/model capacity reloads while live status stays compact", t => {
  const home = localHome(t), graph = defaultAccessSettings();graph.providers.m365 = false;graph.clients.codex.source = "github";
  graph.apis = Array.from({ length: 16 }, (_, index) => ({ ...structuredClone(apiConfig), id: "api_bulk_" + index, name: "Bulk " + index,
    models: Array.from({ length: 500 }, (_, model) => ({ id: `vendor-${index}/${model}-` + "x".repeat(130), protocols: ["messages", "responses"] })) }));
  updateAccessSettings(() => graph, { home, env: {} });assert.equal(readAccessSettings({ home, env: {} }).apis[15].models.length, 500);
  const r = createProviderRuntime({ home, env: { CCDX_M365: "0" }, githubClient: {}, githubRegistry: { models: { data: [] } }, secretStore: secrets(), createApi: () => assert.fail("status must not construct a provider transport") });
  t.after(() => r.close());const state = r.snapshot(), text = JSON.stringify(state);assert.ok(Buffer.byteLength(text) < 20000);assert.equal(text.includes("vendor-15/499"), false);
  assert.equal(state.connections.providers.find(p => p.id === "api_bulk_15").model_count, 500);
});


test("saving model selections cannot remove models used by an active client", async t => {
  for (const client of ["claude_app", "codex"]) {
    const s = runtime(t), id = await save(s.runtime), c = s.runtime.connections().clients.find(c => c.id === client);
    await s.runtime.manageConnections({ operation: "client", id: client, enabled: true, allowed: c.allowed, source: id });
    const before = fs.readFileSync(accessSettingsPath({ home: s.home, env: s.env }));
    const { id: omitted, enabled, secret_ref, ...config } = structuredClone(apiConfig);
    config.models = client === "claude_app" ? config.models.filter(model => !model.protocols.includes("messages")) : [...config.models.filter(model => !model.protocols.includes("responses")), { id: "replacement-response", protocols: ["responses"] }];
    await assert.rejects(s.runtime.manageConnections({ operation: "save_api", id, config, allowed: ["codex", "claude_app", "claude_code"] }), { code: "ccdx_api_model_unavailable" });
    assert.equal(fs.readFileSync(accessSettingsPath({ home: s.home, env: s.env })).equals(before), true);
  }
});

test("automatic catalog refresh preserves bindings, native sign-in, manual overrides and active snapshots", async t => {
  let clock = Date.now(), output = 16000, failure = false, reads = 0, closes = 0;
  const s = runtime(t, { now: () => clock, createApi: options => createApiProvider({ ...options, networkFactory: async () => ({ close() { closes++; }, async fetch(_url, init) {
    if (init.body) return Response.json(JSON.parse(init.body));
    reads++;if (failure) return Response.json({ secret: "not-public" }, { status: 403 });
    return Response.json({ data: [{ id: "any-message-model", type: "model", max_input_tokens: 128000, max_tokens: output, capabilities: {
      thinking: { supported: true }, effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true } },
    } }] });
  } }) }) });
  const auth = path.join(s.home, ".codex", "auth.json");fs.mkdirSync(path.dirname(auth), { recursive: true });
  fs.writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic-native-sign-in", refresh_token: "synthetic-refresh" } }));
  const authBytes = fs.readFileSync(auth), id = await save(s.runtime);
  assert.equal(reads, 1);const c = s.runtime.connections().clients.find(c => c.id === "claude_app");
  await s.runtime.manageConnections({ operation: "client", id: c.id, enabled: true, allowed: c.allowed, deployments: [{ source: id, model: "any-message-model" }] });
  const before = s.runtime.connections().clients.find(c => c.id === "claude_app"), old = s.runtime.source(id), finish = s.runtime.track(old);
  const oldCloses = closes;
  const api = readAccessSettings({ home: s.home, env: s.env }).apis.find(api => api.id === id);
  assert.equal(api.models[0].metadata.protocols.messages.max_output_tokens, 16000);
  await Promise.all(Array.from({ length: 12 }, () => s.runtime.refresh()));assert.equal(reads, 1);
  clock += 31 * 60000;output = 8000;await s.runtime.refresh();assert.equal(reads, 2);
  const current = s.runtime.connections().clients.find(c => c.id === "claude_app");
  assert.deepEqual(current.deployments, before.deployments);assert.equal(current.default_model, before.default_model);
  assert.equal(current.model_plan.models[0].capability.values.max_output_tokens, 8000);
  assert.equal(s.configured.at(-1).models[0].capability.values.max_output_tokens, 8000);
  assert.equal((await (await old.client.messages({ model: "any-message-model", max_tokens: 30000 })).json()).max_tokens, 16000);
  assert.equal(closes, oldCloses, "Active source still owns its transport");finish();assert.equal(closes, oldCloses + 1);
  const saved = fs.readFileSync(accessSettingsPath({ home: s.home, env: s.env }));
  clock += 31 * 60000;failure = true;await s.runtime.refresh();await s.runtime.refresh();assert.equal(reads, 3);
  assert.equal(s.runtime.connections().providers.find(p => p.id === id).discovery.state, "stale");
  assert.ok(fs.readFileSync(accessSettingsPath({ home: s.home, env: s.env })).equals(saved));assert.ok(fs.readFileSync(auth).equals(authBytes));
  assert.equal(JSON.stringify(s.runtime.connections()).includes("not-public"), false);
});

test("environment-key changes create isolated profiles while existing requests retain the old key", async t => {
  const env = { CCDX_M365: "0", TEST_GATEWAY_KEY: "first-synthetic-key" }, seen = [];
  const s = runtime(t, { env, createApi: options => createApiProvider({ ...options, networkFactory: async () => ({ close() {}, async fetch(_url, init) {
    seen.push(init.headers.Authorization);return Response.json(init.body ? JSON.parse(init.body) : { data: [] });
  } }) }) });
  const { id: ignored, enabled, secret_ref, ...config } = structuredClone(apiConfig);config.key_env = "TEST_GATEWAY_KEY";
  const id = await save(s.runtime, { config, key: undefined }), old = s.runtime.source(id), finish = s.runtime.track(old);
  env.TEST_GATEWAY_KEY = "second-synthetic-key";const current = s.runtime.source(id);
  assert.notEqual(current.profileId(), old.profileId());
  await old.client.responses({ model: "custom/response", input: "synthetic" });await current.client.responses({ model: "custom/response", input: "synthetic" });
  assert.deepEqual(seen.slice(-2), ["Bearer first-synthetic-key", "Bearer second-synthetic-key"]);finish();
});

test("legacy single-source Codex review choices use refreshed capability evidence", async t => {
  const s = runtime(t, { createApi: options => createApiProvider({ ...options, networkFactory: async () => ({ close() {}, async fetch() {
    return Response.json({ data: [{ id: "custom/response", capabilities: { supports: { reasoning_effort: ["low", "high"] } } }] });
  } }) }) });
  const id = await save(s.runtime), c = s.runtime.connections().clients.find(c => c.id === "codex");
  await s.runtime.manageConnections({ operation: "client", id: c.id, enabled: true, allowed: c.allowed, source: id, auto_review_effort: "high" });
  assert.equal(s.runtime.providerPreference(id).auto_review_effort, "high");
  assert.deepEqual(s.runtime.dashboardCatalog({ provider: id }).models.find(m => m.id === "custom/response").auto_review_efforts, ["low", "high"]);
});

test('maintenance startup cannot call client writers or publish background API discovery', async t => {
 let preserving=false,writes=0;
 const s=runtime(t,{preserveClientConfiguration:()=>preserving,configureCodex:()=>{writes++;return {state:'configured'};}});
 await save(s.runtime);const before=writes;preserving=true;
 await s.runtime.syncClients();await s.runtime.start();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(writes,before);assert.equal(s.calls.length,0);
 preserving=false;await s.runtime.syncClients(['codex']);assert.ok(writes>before);
});
test('private cached keys hand off only to their unchanged allowed reference set', async () => {
 const ref='e'.repeat(32),other='d'.repeat(32),key='synthetic-private-key';
 const store=createApiSecretStore({platform:'darwin',env:{},run:async()=>key});await store.get(ref);await store.get(other);
 const state=store.exportState([ref]);assert.deepEqual(state,[[ref,key]]);
 const restored=createApiSecretStore({platform:'darwin',env:{},run:async()=>{throw Error('vault should not be read');}});
 restored.importState(state,[ref]);assert.equal(await restored.get(ref),key);
 assert.throws(()=>restored.importState([[other,key]],[ref]));assert.equal(await restored.get(ref),key);store.close();restored.close();
});
