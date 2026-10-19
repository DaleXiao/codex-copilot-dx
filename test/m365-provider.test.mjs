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

test("M365 never reuses another account's model cache or opaque replay identity", async t => {
  const home = fixture(t), paths = m365Paths({ home });
  writeM365Json(paths.account, account);
  writeM365Json(paths.catalog, { account_key: m365AccountKey({ ...account, id: "other" }), models: catalog, saved_at: Date.now() });
  const p = createM365Provider({ home, auth: auth(), fetchImpl: async () => Response.json(catalog) });
  assert.equal(p.models("gpt").length, 0);await p.refresh();
  const plan = p.route({}, { upstreamModel: "gpt-6-sol", surface: "responses" });
  assert.equal(plan.origin, "m365");assert.equal(plan.profile, `m365:${m365AccountKey(account)}`);
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
