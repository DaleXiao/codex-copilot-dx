import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createM365Provider, m365Headers, m365ConversationId, m365Catalog, m365Models } from "../src/providers/m365.mjs";
import { m365Paths, writeM365Json, m365AccountKey } from "../src/m365-settings.mjs";
import { limitM365CacheTtl } from "../src/providers/m365-messages-policy.mjs";

const account = { id: "id-a", tenant: "tenant-a", login: "user@example.test" };
const catalog = { data: [
  { id: "claude-opus-5.5", publisher: "Anthropic", supported_endpoints: ["/v1/messages"] },
  { id: "gpt-6-sol", publisher: "OpenAI", supported_endpoints: ["/responses"] },
  { id: "gpt-6.1-sol", publisher: "unknown", supported_endpoints: ["/responses"] },
] };
function fixture(t) { const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-m365-provider-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));return home; }
function auth(identity = account) { return { getToken: async () => ({ token: "synthetic_entra_secret", account: identity, expiresAt: Date.now() + 3600000 }),
  snapshot: () => ({ token_cached: true, reason: null }), reset() {} }; }

test("explicit directory refresh replaces an old five-model cache with the actual network list", async t => {
  const home = fixture(t), paths = m365Paths({ home }), { M365_API_ORIGIN } = await import("../src/providers/m365-endpoint.mjs");
  const gpt = Array.from({ length: 5 }, (_, i) => ({ id: `gpt-example-${i}`, publisher: "OpenAI", supported_endpoints: ["/responses"] }));
  const all = [...gpt, ...Array.from({ length: 10 }, (_, i) => ({ id: `claude-example-${i}`, publisher: "Anthropic", supported_endpoints: ["/v1/messages"] }))];
  writeM365Json(paths.account, account);writeM365Json(paths.catalog, { service_origin: M365_API_ORIGIN, account_key: m365AccountKey(account), saved_at: Date.now() - 60000, models: { data: gpt } });
  let calls = 0;
  const p = createM365Provider({ home, auth: auth(), fetchImpl: async (_url, init) => {
    calls++;assert.equal(init.method, "GET");assert.equal(init.headers["Cache-Control"], "no-cache");assert.equal(init.headers.Pragma, "no-cache");
    return Response.json({ data: all }, { headers: { "request-id": "catalog-network-1", age: "42" } });
  } });t.after(() => p.close());
  assert.equal(p.catalog().length, 5);assert.equal(p.snapshot().catalog_read.source, "cache");assert.equal(calls, 0);
  await p.refresh();assert.equal(calls, 1);assert.equal(p.catalog().length, 15);
  assert.deepEqual([p.snapshot().catalog_read.total, p.snapshot().catalog_read.claude, p.snapshot().catalog_read.gpt], [15, 10, 5]);
  assert.equal(p.snapshot().catalog_read.local_cache_used, false);assert.equal(p.snapshot().catalog_read.request_id, "catalog-network-1");
  assert.equal(p.snapshot().catalog_read.response_age_seconds, 42);assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(paths.catalog))).includes("synthetic_entra_secret"), false);
});

test("an online five-model result is not expanded from a fifteen-model cache", async t => {
  const home = fixture(t), paths = m365Paths({ home }), { M365_API_ORIGIN } = await import("../src/providers/m365-endpoint.mjs");
  writeM365Json(paths.account, account);writeM365Json(paths.catalog, { service_origin: M365_API_ORIGIN, account_key: m365AccountKey(account), saved_at: Date.now(), models: catalog });
  const one = catalog.data.filter(model => model.publisher === "OpenAI");
  const p = createM365Provider({ home, auth: auth(), fetchImpl: async () => Response.json({ data: one }) });t.after(() => p.close());
  await p.refresh();assert.equal(p.catalog().length, 1);assert.equal(p.snapshot().catalog_read.source, "network");assert.equal(p.snapshot().catalog_read.claude, 0);
});

test("a readable catalog never hides an inference refusal or retries another model", async t => {
  let posts = 0;
  const p = createM365Provider({ home: fixture(t), auth: auth(), persist: false, fetchImpl: async (_url, init) => {
    if (init.method === "GET") return Response.json(catalog);
    posts++;return Response.json({ error: { code: "model_access_denied", message: "synthetic refusal" } }, { status: 403, headers: { "request-id": "inference-request-1" } });
  } });t.after(() => p.close());await p.refresh();
  const result = await p.client.messages({ model: "claude-opus-5.5", max_tokens: 1, messages: [{ role: "user", content: "synthetic" }] });
  assert.equal(result.status, 403);assert.equal(result.headers.get("request-id"), "inference-request-1");assert.equal((await result.json()).error.code, "model_access_denied");
  assert.equal(posts, 1);assert.equal(p.snapshot().catalog_read.http_status, 200);
});

test("a catalog refusal retains the last-good list, exposes its reason, and clears on recovery", async t => {
  let refused = false, clock = Date.parse("2026-10-22T07:00:00Z");
  const p = createM365Provider({ home: fixture(t), auth: auth(), now: () => clock,
    fetchImpl: async () => refused ? Response.json({ error: { message: "Copilot CLI Entra access is not enabled for this user." }, extra: "private prompt" },
      { status: 403, headers: { "request-id": "service-request-1" } }) : Response.json(catalog) });
  t.after(() => p.close());await p.refresh();refused = true;clock += 1000;
  await assert.rejects(p.refresh(), error => error.code === "m365_catalog_http_403" && error.catalog_diagnostic.cause_code === "entra_access_disabled");
  const state = p.snapshot();assert.equal(state.catalog_diagnostic.last_success_at, "2026-10-22T07:00:00.000Z");
  assert.equal(state.catalog_diagnostic.checked_at, "2026-10-22T07:00:01.000Z");assert.equal(p.models("claude").length, 1);
  assert.doesNotMatch(JSON.stringify(state), /private prompt|synthetic_entra_secret/);
  refused = false;await p.refresh();assert.equal(p.snapshot().state, "ready");assert.equal(p.snapshot().catalog_diagnostic, null);
});

test("M365 cache TTL adaptation preserves content, breakpoints and nested tool data", () => {
  const control = { type: "ephemeral", ttl: "1h" };
  const body = { model: "claude-opus-5.5", system: [{ type: "text", text: "kept", cache_control: control }],
    tools: [{ name: "read", input_schema: { type: "object" }, cache_control: control }],
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "retained", cache_control: control },
      { type: "tool_use", input: { cache_control: control } }] }], thinking: { type: "adaptive" } };
  const before = structuredClone(body), adjusted = limitM365CacheTtl(body);
  assert.equal(adjusted.changed, 3);assert.deepEqual(body, before);
  assert.equal(adjusted.body.system[0].text, "kept");assert.equal(adjusted.body.system[0].cache_control.ttl, "5m");
  assert.equal(adjusted.body.messages[0].content[0].content, "retained");
  assert.equal(adjusted.body.messages[0].content[1].input.cache_control.ttl, "1h");
  assert.equal(adjusted.body.thinking, body.thinking);assert.equal(limitM365CacheTtl(adjusted.body).body, adjusted.body);
});

test("M365 keeps full discovery isolated while exposing only each protocol's verified family", async t => {
  const home = fixture(t), requests = [];
  const p = createM365Provider({ home, auth: auth(), fetchImpl: async (url, options) => {
    requests.push({ url, options });return Response.json(catalog);
  } });
  await p.refresh();
  assert.deepEqual(p.models("claude").map(x => x.id), ["claude-opus-5.5"]);
  assert.deepEqual(JSON.parse((await p.client.listModels()).body).data.map(x => x.id), ["gpt-6-sol"]);
  assert.equal(requests.length, 1);assert.equal(requests[0].options.redirect, "manual");
  assert.equal(requests[0].options.headers["X-ClientType"], "GitHub");
  assert.equal(p.snapshot().state, "ready");
  for (const file of [m365Paths({ home }).catalog, m365Paths({ home }).account]) assert.doesNotMatch(fs.readFileSync(file, "utf8"), /synthetic_entra_secret/);
  assert.doesNotMatch(JSON.stringify(p.snapshot()), /synthetic_entra_secret|id-a/);
  assert.equal(p.snapshot().account.tenant, account.tenant, "Tenant distinguishes accounts in the local selector");
  await assert.rejects(p.client.messages({ model: "gpt-6-sol", messages: [] }), { code: "m365_model_unavailable" });
  assert.equal(requests.length, 1);p.close();
});

test("a closed source cannot publish a delayed catalog or revive its last-good snapshot", async t => {
  const home = fixture(t);let release, began, reads = 0, publications = 0;
  const started = new Promise(resolve => { began = resolve; });
  const p = createM365Provider({ home, auth: auth(), onCatalog: () => { publications++; }, fetchImpl: async () => {
    if (++reads === 1) return Response.json(catalog);
    began();return new Promise(resolve => { release = resolve; });
  } });
  await p.refresh();
  const before = fs.readFileSync(m365Paths({ home }).catalog, "utf8");
  const late = p.refresh();await started;p.close();
  release(Response.json({ data: [{ id: "gpt-late", publisher: "OpenAI", supported_endpoints: ["/responses"] }] }));
  await assert.rejects(late);
  assert.equal(p.snapshot().state, "disabled");assert.equal(publications, 1);
  assert.equal(fs.readFileSync(m365Paths({ home }).catalog, "utf8"), before);
});

test("M365 never reuses another account's model cache or opaque replay identity", async t => {
  const home = fixture(t), paths = m365Paths({ home });
  writeM365Json(paths.account, account);
  writeM365Json(paths.catalog, { account_key: m365AccountKey({ ...account, id: "other" }), models: catalog, saved_at: Date.now() });
  const p = createM365Provider({ home, auth: auth(), fetchImpl: async () => Response.json(catalog) });
  assert.equal(p.models("gpt").length, 0);await p.refresh();
  const plan = p.route({}, { upstreamModel: "gpt-6-sol", surface: "responses" });
  assert.equal(plan.origin, "m365");assert.equal(plan.profile, `m365:https://loki.delve.office.com:${m365AccountKey(account)}`);
  p.close();
});

test("M365 Messages preserve bodies and beta headers while never forwarding a caller credential", async t => {
  const sent = [], p = createM365Provider({ home: fixture(t), auth: auth(), fetchImpl: async (url, options) => {
    sent.push({ url, options });return Response.json(options.method === "GET" ? catalog : { type: "message", content: [] });
  } });await p.refresh();
  const body = { model: "claude-opus-5.5", messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }],
    max_tokens: 64, thinking: { type: "adaptive" }, tools: [{ name: "a", input_schema: { type: "object" } }] };
  const before = structuredClone(body);
  await p.client.messages(body, { headers: { authorization: "Bearer local_secret", "x-api-key": "other_secret",
    "anthropic-version": "2023-06-01", "anthropic-beta": "synthetic-beta", "x-claude-code-session-id": "stable-session" } });
  const request = sent[1];assert.deepEqual(JSON.parse(request.options.body), body);assert.deepEqual(body, before);
  assert.equal(request.options.headers.Authorization, "Bearer synthetic_entra_secret");
  assert.equal(request.options.headers["anthropic-beta"], "synthetic-beta");
  assert.doesNotMatch(JSON.stringify(request), /local_secret|other_secret/);
  assert.match(request.options.headers["X-ConversationId"], /^[a-f0-9-]{36}$/);p.close();
});

test("M365 header and conversation mapping use fixed fields and isolated stable identities", () => {
  assert.equal(m365Headers("secret", { headers: { "anthropic-beta": "bad\r\nheader" } })["anthropic-beta"], undefined);
  const header = { "session_id": "same-session" };
  assert.equal(m365ConversationId({}, header, "a"), m365ConversationId({}, header, "a"));
  assert.notEqual(m365ConversationId({}, header, "a"), m365ConversationId({}, header, "b"));
  assert.equal(m365ConversationId({ metadata: { user_id: '{"session_id":"same-session"}' } }, {}, "a"), m365ConversationId({}, header, "a"));
  assert.notEqual(m365ConversationId({}), m365ConversationId({}));
});

test("M365 rejects invalid catalogs and unsupported fast without a silent downgrade", async t => {
  assert.throws(() => m365Catalog({ data: [catalog.data[0], catalog.data[0]] }), { code: "m365_catalog_invalid" });
  assert.deepEqual(m365Models({ data: [{ id: "claude-injected", publisher: "OpenAI", supported_endpoints: ["/v1/messages"] }] }, "claude"), []);
  assert.deepEqual(m365Models({ data: [{ ...catalog.data[0], publisher: 42 }] }, "claude"), []);
  for (const denied of [{ policy: { state: "disabled" } }, { model_picker_enabled: false }]) {
    assert.deepEqual(m365Models({ data: [{ ...catalog.data[0], ...denied }] }, "claude"), []);
  }
  const p = createM365Provider({ home: fixture(t), auth: auth(), fetchImpl: async () => Response.json(catalog) });await p.refresh();
  assert.throws(() => p.selectModel({ service_tier: "priority" }, { requestedModel: "gpt-6-sol", upstreamModel: "gpt-6-sol" }), { code: "m365_priority_unverified" });
  assert.throws(() => p.selectModel({}, { requestedModel: "codex-auto-review", upstreamModel: "gpt-6.1-sol" }), { code: "m365_model_unavailable" });
  const body = { tools: [{ type: "image_generation" }, { type: "function", name: "mcp__ccdx_image.generate_image" }] };
  p.applyRequestPolicies(body);
  assert.deepEqual(body.tools, [{ type: "function", name: "mcp__ccdx_image.generate_image" }]);
  p.close();
});

test("M365 failures preserve their diagnostic and redact upstream token echoes", async t => {
  let healthy = true;
  const p = createM365Provider({ home: fixture(t), auth: auth(), fetchImpl: async () => healthy
    ? Response.json(catalog) : Response.json({ error: { message: "echo synthetic_entra_secret" } }, { status: 403 }) });
  await p.refresh();healthy = false;
  const response = await p.client.messages({ model: "claude-opus-5.5", messages: [] });
  assert.equal(response.status, 403);assert.doesNotMatch(await response.text(), /synthetic_entra_secret/);
  await assert.rejects(p.refresh());assert.equal(p.snapshot().reason, "m365_catalog_http_403");
  p.close();
});

test("Claude aliases preserve effort and signed blocks; unsupported advertised efforts never dispatch", async t => {
  const sent = [];
  const entry = { ...catalog.data[0], capabilities: { supports: { reasoning_effort: ["low", "high", "future"] } } };
  const p = createM365Provider({ home: fixture(t), auth: auth(), fetchImpl: async (_url, options) => {
    if (options.method === "GET") return Response.json({ data: [entry] });
    sent.push(JSON.parse(options.body));return Response.json({ type: "message", content: [], stop_reason: "end_turn" });
  } });t.after(() => p.close());await p.refresh();
  const content = [{ type: "thinking", thinking: "retained", signature: "stable-signature" }];
  for (const effort of ["low", "high", "future"]) await p.client.messages({ model: "claude-opus-5-5", messages: [{ role: "assistant", content }], output_config: { effort }, thinking: { type: "adaptive" } });
  assert.equal(sent.length, 3);
  for (const body of sent) { assert.equal(body.model, entry.id);assert.deepEqual(body.messages[0].content, content); }
  await assert.rejects(p.client.messages({ model: "claude-opus-5-5", messages: [], output_config: { effort: "medium" } }), { code: "m365_effort_unavailable" });
  assert.equal(sent.length, 3);
});

test('M365 cache publication is account-and-origin bound; old environment files are preserved until success', async t => {
  const home = fixture(t), paths = m365Paths({ home });writeM365Json(paths.account, account);
  for (const service_origin of [undefined, 'https://df.loki.delve.office.com']) {
    writeM365Json(paths.catalog, { account_key: m365AccountKey(account), service_origin, models: catalog, saved_at: Date.now() });
    const before = fs.readFileSync(paths.catalog, 'utf8');
    const p = createM365Provider({ home, auth: auth(), fetchImpl: async () => Response.json({}, { status: 403 }) });
    assert.equal(p.catalog().length, 0);await assert.rejects(p.refresh());assert.equal(fs.readFileSync(paths.catalog, 'utf8'), before);p.close();
  }
  const p = createM365Provider({ home, auth: auth(), fetchImpl: async () => Response.json(catalog) });await p.refresh();p.close();
  assert.equal(JSON.parse(fs.readFileSync(paths.catalog)).service_origin, 'https://loki.delve.office.com');
  const cached = createM365Provider({ home, auth: auth() });assert.equal(cached.catalog().length, catalog.data.length);cached.close();
});
