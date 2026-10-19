import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProviderRuntime } from "../src/provider-runtime.mjs";
import { createM365Provider } from "../src/providers/m365.mjs";
import { runWithRequestContext } from "../src/request-context.mjs";
import { readProviderSettings } from "../src/provider-settings.mjs";
import { rememberResponseHistoryNode, materializeResponseHistory, clearResponseHistoryForTests } from "../src/response-history.mjs";
import { invokeAdapter } from "../test-support/adapter.mjs";
import { applyResponseHistoryRoutePlan } from "../src/responses-request.mjs";
import { createM365Network } from "../src/providers/m365-network.mjs";

const catalog = { data: [
  { id: "claude-opus-5.5", publisher: "Anthropic", supported_endpoints: ["/v1/messages"] },
  { id: "gpt-6-sol", publisher: "OpenAI", supported_endpoints: ["/responses"], capabilities: { supports: { reasoning_effort: ["low", "medium"] } } },
] };
function completed(model, id) { return Response.json({ id, model, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); }
function setup(t, { failM365 = false, githubRequest, acquireM365, gatewayError, corePort, modelCatalog = catalog, onConfigure = () => {}, m365Network } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-providers-")), calls = [], lifecycle = [];
  const githubClient = { getCachedModelEndpoints: () => ["/responses"], listModels: async () => ({ status: 200, body: JSON.stringify({ data: [] }) }),
    responses: async body => { calls.push({ provider: "github", body: structuredClone(body) });return githubRequest ? githubRequest(body) : completed(body.model, "resp_github"); },
    responsesCompact: async body => completed(body.model, "resp_compact"), runtimeStatus: () => ({}), chatCompletions: () => assert.fail("Unexpected Chat fallback") };
  const runtime = createProviderRuntime({ githubClient, githubRegistry: { models: { data: [] } }, home, env: {}, platform: "darwin", corePort,
    createM365: options => createM365Provider({ ...options, auth: {
      getToken: async () => { if (acquireM365) await acquireM365();if (failM365) throw Object.assign(Error("denied"), { code: "m365_interaction_required" });return { token: "test_entra", expiresAt: Date.now() + 3600000, account: { id: "id", tenant: "tenant", login: "user@example.test" } }; }, snapshot: () => ({}), reset() {},
    }, ...(m365Network ? { createNetwork: m365Network } : { fetchImpl: async (_url, options) => {
      if (options.method === "GET") return Response.json(modelCatalog);
      const body = JSON.parse(options.body);calls.push({ provider: "m365", body });return completed(body.model, "resp_m365");
    } }) }),
    startGateway: async () => { lifecycle.push("start");if (gatewayError) throw Object.assign(Error("Synthetic gateway failure"), { code: gatewayError });return { port: 2027, snapshot: () => ({ active: 0 }), close: async () => lifecycle.push("close") }; },
    configureClients: input => { onConfigure(input);return { code: "configured", app: "configured" }; }, restoreClients: () => ({ remaining: 0, preserved: 0 }),
  });
  const options = { providerRuntime: runtime, codexClient: githubClient, openAIModelEnv: {} };
  t.before(() => { process.env.CCDX_DISABLE_USAGE = "1";clearResponseHistoryForTests(); });
  t.after(async () => { await runtime.close();clearResponseHistoryForTests();fs.rmSync(home, { recursive: true, force: true }); });
  return { runtime, calls, lifecycle, home, options };
}
const choose = runtime => runtime.action({ action: "switch", provider: "m365", model: "gpt-6-sol", auto_review_model: "gpt-6-sol" });

test("system proxy parse failures stay local to M365, retain the cause, and recover without replacing GitHub", async t => {
  let rule = "169.254/33", catalogReads = 0;
  const s = setup(t, { m365Network: async () => {
    const network = await createM365Network({ platform: "darwin", env: {}, execFileImpl: async () => ({ stdout: `ExceptionsList : <array> {\n0 : ${rule}\n}` }),
      requestImpl() { assert.fail("No real transport probe"); } });
    network.close();
    return { fetch: async () => { catalogReads++;return Response.json(catalog); }, snapshot: () => ({ source: "direct", type: "direct" }), healthy: () => true, close() {} };
  } });
  await s.runtime.start();
  const state = s.runtime.snapshot();
  assert.equal(state.m365.state, "unavailable");assert.equal(state.m365.reason, "m365_proxy_settings_unsupported");
  assert.equal(state.m365.network_diagnostic.cause_code, "proxy_bypass_invalid");assert.equal(catalogReads, 0);
  assert.equal(s.runtime.dashboardProviders().find(p => p.id === "m365").network_diagnostic.cause_code, "proxy_bypass_invalid");
  const reply = await invokeAdapter(s.options, { body: { model: "gpt-6.1-sol", input: "still available" } });
  assert.equal(reply.status, 200);assert.deepEqual(s.calls.map(call => call.provider), ["github"]);
  await assert.rejects(s.runtime.dashboardCatalog({ provider: "m365" }), { code: "m365_proxy_settings_unsupported" });
  assert.equal(s.runtime.snapshot().codex_provider, "github");assert.equal(catalogReads, 0);
  rule = "169.254/16";await s.runtime.refresh();
  assert.equal(s.runtime.snapshot().m365.state, "ready");assert.equal(s.runtime.snapshot().m365.network_diagnostic, null);
  assert.equal(s.runtime.snapshot().codex_provider, "github");assert.equal(catalogReads, 1);
});

test("Claude shares a custom core service port without a conflicting listener", async t => {
  const s = setup(t, { corePort: 2027 });await s.runtime.start();
  assert.deepEqual(s.lifecycle, ["start"]);
  assert.equal(s.runtime.snapshot().m365.claude.reason, null);
  assert.equal(s.runtime.snapshot().m365.claude.base_url, "http://127.0.0.1:2027/anthropic");
  await choose(s.runtime);assert.equal(s.runtime.current().id, "m365");
});

test("a Claude gateway failure cannot prevent the independent M365 Codex backup", async t => {
  const s = setup(t, { gatewayError: "EADDRINUSE" });await s.runtime.start();
  await choose(s.runtime);
  assert.equal(s.runtime.snapshot().m365.claude.reason, "m365_gateway_port_busy");
  const result = await invokeAdapter(s.options, { body: { model: "gpt-6-sol", input: "GPT stays available" } });
  assert.equal(result.status, 200);assert.equal(s.calls[0].provider, "m365");assert.deepEqual(s.lifecycle, ["start"]);
});

test("a GPT-only M365 catalog does not configure or launch Claude clients", async t => {
  const s = setup(t, { modelCatalog: { data: [catalog.data[1]] } });await s.runtime.start();
  assert.deepEqual(s.lifecycle, []);assert.equal(s.runtime.snapshot().m365.claude.clients.app, "not_configured");
  await choose(s.runtime);assert.equal(s.runtime.current().id, "m365");
});

test("a slow optional M365 authorization does not hold GitHub inference", async t => {
  let release;const blocked = new Promise(resolve => { release = resolve; });
  const s = setup(t, { acquireM365: () => blocked });
  const started = s.runtime.start();
  const result = await invokeAdapter(s.options, { body: { model: "gpt-6.1-sol", input: "Still available" } });
  assert.equal(result.status, 200);assert.equal(s.calls[0].provider, "github");
  assert.equal(s.runtime.snapshot().m365.state, "checking");release();await started;
});

test("known same-provider history overrides the global prior-source hint after switching back", () => {
  const affinity = { origin: "ccdx", profile: "codex:account", protocol: "openai-responses", model: "gpt-6-sol" };
  const request = { body: { input: [{ type: "function_call_output", output: { encrypted_content: "same-provider-state" } }] },
    historyRouteMetadata: [{ affinity }] };
  runWithRequestContext({ historyTransferNamespace: "m365:prior-account" }, () => {
    assert.equal(applyResponseHistoryRoutePlan(request, { ...affinity, surface: "responses" }), request);
  });
});

test("M365 availability never changes the default GitHub route and failed preflight does not commit", async t => {
  const s = setup(t);await s.runtime.start();assert.equal(s.runtime.current().id, "github");
  await assert.rejects(s.runtime.action({ action: "switch", provider: "m365", model: "gpt-missing", auto_review_model: "gpt-6-sol" }), { code: "m365_model_selection_required" });
  assert.equal(readProviderSettings({ home: s.home, env: {} }).codex, "github");
  const result = await invokeAdapter(s.options, { body: { model: "gpt-6.1-sol", input: "primary" } });
  assert.equal(result.status, 200);assert.equal(s.calls[0].provider, "github");
});

test("source selection pins in-flight requests and preserves isolated Auto-review preferences", async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const s = setup(t, { githubRequest: async body => { entered();await new Promise(resolve => { release = resolve; });return completed(body.model, "resp_old"); } });
  await s.runtime.start();
  const old = invokeAdapter(s.options, { body: { model: "gpt-6.1-sol", input: "old" }, headers: { session_id: "session-one" } });
  await started;await choose(s.runtime);
  const newer = await invokeAdapter(s.options, { body: { model: "codex-auto-review", input: "review" }, headers: { session_id: "session-one" } });
  assert.equal(newer.status, 200);assert.equal(s.calls[1].provider, "m365");assert.equal(s.calls[1].body.model, "gpt-6-sol");
  assert.equal(s.calls[1].body.reasoning.effort, "low");release();assert.equal((await old).status, 200);
  assert.equal(s.runtime.historyContext({ session_id: "session-one" }, s.runtime.current()).historyTransferNamespace, undefined);
  await s.runtime.action({ action: "auto-review", model: "gpt-6-sol", effort: "medium" });
  assert.equal(s.runtime.selection().m365.auto_review_effort, "medium");
  await s.runtime.action({ action: "switch", provider: "github" });assert.equal(s.runtime.current().id, "github");
});

test("failed optional M365 initialization leaves GitHub inference and unrelated configuration untouched", async t => {
  const s = setup(t, { failM365: true });await s.runtime.start();
  assert.equal(s.runtime.snapshot().m365.state, "unavailable");assert.deepEqual(s.lifecycle, []);
  const result = await invokeAdapter(s.options, { body: { model: "gpt-6.1-sol", input: "healthy" } });
  assert.equal(result.status, 200);assert.equal(s.calls.length, 1);assert.equal(s.calls[0].provider, "github");
  assert.equal(fs.existsSync(path.join(s.home, ".codex")), false);
});

test("response identifiers cannot collide or access another profile without an explicit transfer", () => {
  clearResponseHistoryForTests();
  for (const namespace of ["github:account-a", "m365:account-b"]) runWithRequestContext({ historyNamespace: namespace }, () => {
    rememberResponseHistoryNode({ id: "same_id", inputItems: [{ type: "message", role: "user", content: namespace }], outputItems: [] });
  });
  for (const namespace of ["github:account-a", "m365:account-b"]) runWithRequestContext({ historyNamespace: namespace }, () => {
    assert.equal(materializeResponseHistory("same_id")[0].content, namespace);
    assert.throws(() => materializeResponseHistory("\0m365:account-b\0same_id"), /Invalid previous_response_id/);
  });
  runWithRequestContext({ historyNamespace: "m365:account-b", historyTransferNamespace: "github:account-a" }, () => {
    assert.throws(() => materializeResponseHistory("same_id"), /ambiguous/);
  });clearResponseHistoryForTests();
});

test("plain prior history transfers on explicit switching, but opaque tool content is never discarded", async t => {
  const s = setup(t);await s.runtime.start();
  await invokeAdapter(s.options, { body: { model: "gpt-6.1-sol", input: "Keep this entire message" }, headers: { session_id: "plain-thread" } });
  await choose(s.runtime);
  const result = await invokeAdapter(s.options, { body: { model: "gpt-6-sol", previous_response_id: "resp_github", input: "Continue" }, headers: { session_id: "plain-thread" } });
  assert.equal(result.status, 200);assert.match(JSON.stringify(s.calls.at(-1).body), /Keep this entire message/);
  const count = s.calls.length;
  const rejected = await invokeAdapter(s.options, { body: { model: "gpt-6-sol", input: [
    { type: "function_call_output", call_id: "opaque", output: { type: "encrypted_content", encrypted_content: "do-not-drop" } },
  ] }, headers: { session_id: "another-old-thread" } });
  assert.equal(rejected.status, 400);assert.match(rejected.text, /ccdx_provider_history_rebuild_required/);assert.equal(s.calls.length, count);
});

test("M365 profile removal waits for its active requests and does not stop the selected GitHub provider", async t => {
  const s = setup(t);await s.runtime.start();await choose(s.runtime);
  const release = s.runtime.track(s.runtime.current());
  await assert.rejects(s.runtime.action({ action: "remove" }), { code: "m365_profile_busy" });
  assert.equal(s.runtime.current().id, "m365");release();
  await s.runtime.action({ action: "remove" });assert.equal(s.runtime.current().id, "github");
  assert.equal(s.runtime.snapshot().m365.enabled, false);assert.deepEqual(s.lifecycle, ["start", "close"]);
});

test("provider model browsing is independent of Codex selection and includes ineligible catalog entries", async t => {
  const data = structuredClone(catalog);
  data.data.push({ id: "other-model", publisher: "Other", supported_endpoints: ["/other"] });
  const s = setup(t, { modelCatalog: data });await s.runtime.start();
  const result = await s.runtime.dashboardCatalog({ provider: "m365" });
  assert.equal(s.runtime.selection().codex, "github");
  assert.equal(result.advertised, 3);assert.equal(result.models.find(model => model.id === "other-model").selectable, false);
  assert.deepEqual(result.models.find(model => model.id.startsWith("claude")).clients, ["claude_code", "claude_app"]);
  await s.runtime.action({ action: "off" });
  await assert.rejects(s.runtime.dashboardCatalog({ provider: "m365" }), { code: "m365_disabled" });
  assert.equal(s.runtime.selection().codex, "github");
});

test("successful background catalogs synchronize Claude configuration and stopping prevents later writes", async t => {
  const data = structuredClone(catalog), configured = [];
  const s = setup(t, { modelCatalog: data, onConfigure: input => configured.push(structuredClone(input.models)) });
  await s.runtime.start();await choose(s.runtime);
  const provider = s.runtime.current();
  data.data[0].capabilities = { supports: { reasoning_effort: ["low", "high"] } };
  await provider.refresh();await new Promise(resolve => setImmediate(resolve));await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(configured.at(-1)[0].capabilities.supports.reasoning_effort, ["low", "high"]);
  const pending = provider.refresh();await s.runtime.action({ action: "off" });await pending.catch(() => {});
  const count = configured.length;await new Promise(resolve => setImmediate(resolve));assert.equal(configured.length, count);
});

test("GitHub review settings share CLI effort filtering and preserve environment ownership", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-review-ui-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const githubRegistry = { models: { data: [{ id: "gpt-6.1-sol", supported_endpoints: ["/responses"], model_picker_enabled: true,
    capabilities: { supports: { reasoning_effort: ["none", "low", "high"] } } }] } };
  const env = {}, runtime = createProviderRuntime({ home, env, githubRegistry });
  await assert.rejects(runtime.action({ action: "auto-review", provider: "m365", model: "gpt-6.1-sol", effort: "low" }), /Save the source/);
  await assert.rejects(runtime.action({ action: "auto-review", provider: "github", model: "gpt-6.1-sol", effort: "none" }), /available review/);
  await runtime.action({ action: "auto-review", provider: "github", model: "gpt-6.1-sol", effort: "high" });
  assert.equal(runtime.snapshot().github.preference.reasoningEffort, "high");
  env.CCDX_AUTO_REVIEW_MODEL = "gpt-6.1-sol";
  await assert.rejects(runtime.action({ action: "auto-review", provider: "github", model: "gpt-6.1-sol", effort: "low" }), /controlled by CCDX/);
  assert.equal(runtime.snapshot().github.preference.reasoningEffort, "high");await runtime.close();
});
