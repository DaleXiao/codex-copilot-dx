import test from "node:test";
import assert from "node:assert/strict";
import { apiModelMetadata } from "../src/providers/api-model-metadata.mjs";
import { resolveModelCapabilities, deploymentRevision, constrainModelRequest } from "../src/model-capabilities.mjs";
import { createApiProvider } from "../src/providers/api.mjs";
import { sourceModels } from "../src/client-model-plan.mjs";
import { publicModelCatalog } from "../src/provider-metadata.mjs";

const config = { id: "api_test", name: "Test", enabled: true, base_url: "https://example.test/v1", endpoints: { messages: "https://example.test/v1/messages", responses: "https://example.test/v1/responses" }, auth_header: "x-api-key", secret_ref: "a".repeat(32), models: [] };
const evidence = { deployment: deploymentRevision(config), checked_at: "2026-10-24T00:00:00.000Z" };
const native = { id: "unfamiliar-model", type: "model", max_input_tokens: 128000, max_tokens: 16000, capabilities: {
  thinking: { supported: true, types: { enabled: { supported: true }, disabled: { supported: true }, adaptive: { supported: false } } },
  effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, max: { supported: false } },
  server_tools: { web_search: { supported: true } }, image_input: { supported: true }, structured_outputs: { supported: false },
} };

test("native catalog capabilities are automatic, model-name independent and API-scoped", () => {
  const metadata = apiModelMetadata(native, evidence), model = { id: native.id, protocols: ["messages", "responses"], metadata };
  const message = resolveModelCapabilities(model, { revision: evidence.deployment, protocol: "messages" });
  assert.equal(message.values.context_window, 128000);assert.equal(message.values.max_output_tokens, 16000);
  assert.deepEqual(message.values.reasoning_efforts, ["low", "medium", "high"]);assert.deepEqual(message.values.thinking_modes, ["disabled", "enabled"]);
  assert.equal(message.values.reasoning_adaptive, false);assert.equal(message.values.structured_output, false);
  assert.deepEqual(message.values.web_search, ["messages"]);assert.deepEqual(message.values.input_modalities, ["text", "image"]);
  assert.equal(message.values.tools, undefined, "Native server tools do not prove client tool calling");
  assert.deepEqual(resolveModelCapabilities(model, { revision: evidence.deployment, protocol: "responses" }).values, {});
  const provider = createApiProvider({ config: { ...config, models: [model] } });
  assert.equal(sourceModels(provider, "claude_app")[0].capability.values.context_window, 128000);
  assert.deepEqual(sourceModels(provider, "codex")[0].capability.values, {});
  assert.equal(publicModelCatalog(sourceModels(provider, "claude_app"))[0].context_window, 128000);
  assert.deepEqual(publicModelCatalog(sourceModels(provider, "codex"))[0].reasoning_efforts, null);provider.close();
});

test("effort and thinking remain distinct and false or malformed declarations are not promoted", () => {
  const metadata = apiModelMetadata({ ...native, capabilities: { ...native.capabilities, thinking: { supported: false } } }, evidence);
  const capability = resolveModelCapabilities({ metadata }, { revision: evidence.deployment, protocol: "messages" });
  const body = { model: native.id, output_config: { effort: "high" } };
  assert.equal(constrainModelRequest(body, capability, "messages").body, body);
  assert.throws(() => constrainModelRequest({ ...body, thinking: { type: "enabled", budget_tokens: 1000 } }, capability, "messages"), { code: "ccdx_api_thinking_unavailable" });
  assert.equal(apiModelMetadata({ id: "name-with-1m-reasoning" }, evidence).state, "missing");
  assert.equal(apiModelMetadata({ id: "unknown", capabilities: { secret_vendor_field: "do-not-persist" } }, evidence).state, "unrecognized");
  const malformed = apiModelMetadata({ ...native, max_tokens: "16000", max_input_tokens: -1, capabilities: { thinking: { supported: "yes" } } }, evidence);
  assert.deepEqual(malformed.values, {});assert.equal(malformed.protocols, undefined);
  assert.equal(JSON.stringify(malformed).includes("secret_vendor_field"), false);
});

test("catalog pagination uses serial same-origin cursors and never invokes inference", async () => {
  const calls = [], provider = createApiProvider({ config, secrets: { get: async () => "synthetic-only" }, networkFactory: async () => ({ close() {}, async fetch(url, init) {
    calls.push({ url, init });return Response.json(calls.length === 1 ? { data: [native], has_more: true, last_id: native.id } : { data: [{ id: "second-model" }], has_more: false });
  } }) });
  try {
    const models = await provider.discover();assert.equal(models.length, 2);assert.deepEqual(models[0].protocols, []);
    assert.equal(calls[1].url, "https://example.test/v1/models?after_id=unfamiliar-model");assert.ok(calls.every(call => call.init.method === "GET" && call.init.body === undefined));
    assert.equal(models[0].metadata.protocols.messages.max_output_tokens, 16000);
  } finally { provider.close(); }
});

test("repeated and invalid pagination fail without partial catalogs or following a next URL", async () => {
  for (const last_id of ["wrong", "unfamiliar-model"]) {
    let calls = 0;
    const provider = createApiProvider({ config, secrets: { get: async () => "synthetic-only" }, networkFactory: async () => ({ close() {}, async fetch() {
      calls++;return Response.json({ data: [native], has_more: true, last_id, next: "https://untrusted.test/collect" });
    } }) });
    try { await assert.rejects(provider.discover(), { code: "ccdx_api_catalog_invalid" });assert.equal(calls, last_id === "wrong" ? 1 : 2); }
    finally { provider.close(); }
  }
});
