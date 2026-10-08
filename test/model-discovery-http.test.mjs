import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { invokeAdapter } from "../test-support/adapter.mjs";

function jsonRequest(body, contentEncoding, headers = {}) {
  const req = Readable.from([body]);
  req.headers = { ...headers };
  if (contentEncoding) req.headers["content-encoding"] = contentEncoding;
  return req;
}

test("HTTP models route updates and falls back to last-known-good model metadata", async () => {
  const cached = { data: [{ id: "gpt-cached", supported_endpoints: ["/responses"] }] };
  const live = { data: [{ id: "gpt-live", supported_endpoints: ["/responses"] }] };
  const modelRegistry = { models: cached };
  const request = { method: "GET", url: "/v1/models" };

  const liveResult = await invokeAdapter({
    modelRegistry,
    listModelsFn: async () => ({ status: 200, body: JSON.stringify(live) }),
  }, request);
  assert.equal(liveResult.status, 200);
  assert.deepEqual(modelRegistry.models, live);

  const networkFallback = await invokeAdapter({
    modelRegistry,
    listModelsFn: async () => { throw new Error("offline"); },
  }, request);
  assert.equal(networkFallback.status, 200);
  assert.equal(networkFallback.headers["X-CCDX-Model-Source"], "last-known-good");
  assert.deepEqual(JSON.parse(networkFallback.text), live);

  const transientFallback = await invokeAdapter({
    modelRegistry,
    listModelsFn: async () => ({ status: 503, body: "unavailable" }),
  }, request);
  assert.equal(transientFallback.status, 200);
  assert.deepEqual(JSON.parse(transientFallback.text), live);
});

test("cached model discovery has a short deadline without changing uncached or auth-error behavior", async () => {
  let aborted = false;
  const started = Date.now();
  const result = await invokeAdapter({
    modelRegistry: { models: { data: [{ id: "gpt-cached" }] } },
    upstreamTimeoutMs: 5000, cachedModelsTimeoutMs: 20,
    listModelsFn: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
    }),
  }, { method: "GET", url: "/v1/models" });
  assert.equal(aborted, true);
  assert.equal(result.status, 200);
  assert.equal(result.headers["X-CCDX-Model-Source"], "last-known-good");
  assert.ok(Date.now() - started < 2000);
  for (const status of [401, 403]) {
    const failure = await invokeAdapter({
      modelRegistry: { models: { data: [{ id: "gpt-cached" }] } }, cachedModelsTimeoutMs: 20,
      listModelsFn: async () => ({ status, body: JSON.stringify({ error: "unauthorized" }) }),
    }, { method: "GET", url: "/v1/models" });
    assert.equal(failure.status, status);
    assert.equal(failure.headers["X-CCDX-Model-Source"], undefined);
  }
  const uncached = await invokeAdapter({ cachedModelsTimeoutMs: 1, upstreamTimeoutMs: 5000,
    listModelsFn: async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { status: 200, body: JSON.stringify({ data: [{ id: "gpt-live" }] }) };
    },
  }, { method: "GET", url: "/v1/models" });
  assert.equal(uncached.status, 200);
});

test("HTTP models route adds the complete Codex catalog only for versioned Codex clients", async () => {
  const live = { object: "list", data: [{
    id: "gpt-6-astra",
    vendor: "OpenAI",
    policy: { state: "enabled" },
    model_picker_enabled: true,
    supported_endpoints: ["/responses", "ws:/responses"],
  }] };
  const bundled = { models: [
    { slug: "gpt-5.6-sol", visibility: "list", future_field: { preserved: true } },
    {
      slug: "gpt-6-astra",
      visibility: "hide",
      additional_speed_tiers: ["fast"],
      service_tiers: [{ id: "priority", name: "Fast" }],
      default_service_tier: null,
      supported_reasoning_levels: [{ effort: "ultra" }],
    },
  ] };
  const loads = [];
  const codexModelCatalog = {
    async load(options) {
      loads.push(options);
      return bundled;
    },
  };

  const raw = await invokeAdapter({
    codexModelCatalog,
    listModelsFn: async () => ({ status: 200, body: JSON.stringify(live) }),
  }, { method: "GET", url: "/v1/models" });
  assert.deepEqual(JSON.parse(raw.text), live);
  assert.deepEqual(loads, []);

  const codex = await invokeAdapter({
    codexModelCatalog,
    listModelsFn: async () => ({ status: 200, body: JSON.stringify(live) }),
  }, { method: "GET", url: "/v1/models?client_version=0.153.1" });
  const body = JSON.parse(codex.text);
  assert.deepEqual(loads, [{ clientVersion: "0.153.1" }]);
  assert.deepEqual(body.data, live.data);
  assert.deepEqual(body.models[0], bundled.models[0]);
  assert.deepEqual(body.models[1], {
    slug: "gpt-6-astra",
    visibility: "list",
    additional_speed_tiers: [],
    service_tiers: [],
    supported_reasoning_levels: [{ effort: "ultra" }],
  });
});

test("versioned Codex model discovery includes eligible GPT-6.1 Sol without dropping bundled models", async () => {
  const live = { data: [{
    id: "gpt-6.1-sol", vendor: "OpenAI", policy: { state: "enabled" },
    model_picker_enabled: true, supported_endpoints: ["/responses"],
    capabilities: { supports: { reasoning_effort: ["low", "medium", "high", "xhigh", "max"] } },
  }] };
  const bundled = { models: [
    { slug: "gpt-5.6-sol", visibility: "list", future_field: { keep: true } },
    { slug: "gpt-6-sol", visibility: "list", priority: 2,
      supported_reasoning_levels: ["low", "medium", "ultra"].map((effort) => ({ effort })) },
  ] };
  const response = await invokeAdapter({
    codexModelCatalog: { load: async () => bundled },
    listModelsFn: async () => ({ status: 200, body: JSON.stringify(live) }),
  }, { method: "GET", url: "/v1/models?client_version=0.158.0-alpha.2.1" });

  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.deepEqual(body.data, live.data);
  assert.deepEqual(body.models[0], bundled.models[0]);
  assert.deepEqual(body.models.find(({ slug }) => slug === "gpt-6.1-sol")?.supported_reasoning_levels,
    [{ effort: "low" }, { effort: "medium" }]);
});

test("versioned Codex model discovery preserves dual shape for last-known-good fallback", async () => {
  const cached = { object: "list", data: [{
    id: "gpt-6-astra",
    vendor: "OpenAI",
    policy: { state: "enabled" },
    model_picker_enabled: true,
    supported_endpoints: ["/responses"],
  }] };
  const codexModelCatalog = {
    async load() {
      return { models: [{ slug: "gpt-6-astra", visibility: "hide" }] };
    },
  };

  for (const listModelsFn of [
    async () => ({ status: 503, body: "unavailable" }),
    async () => { throw new Error("offline"); },
  ]) {
    const response = await invokeAdapter({
      codexModelCatalog,
      modelRegistry: { models: cached },
      listModelsFn,
    }, { method: "GET", url: "/v1/models?client_version=0.153.1" });
    assert.equal(response.status, 200);
    assert.equal(response.headers["X-CCDX-Model-Source"], "last-known-good");
    const body = JSON.parse(response.text);
    assert.deepEqual(body.data, cached.data);
    assert.equal(body.models[0].visibility, "list");
  }
});

test("versioned Codex model discovery fails closed when the local catalog is unavailable", async () => {
  const live = { object: "list", data: [{ id: "gpt-live" }] };
  for (const load of [async () => null, async () => { throw new Error("catalog failed"); }]) {
    const response = await invokeAdapter({
      codexModelCatalog: { load },
      listModelsFn: async () => ({ status: 200, body: JSON.stringify(live) }),
    }, { method: "GET", url: "/v1/models?client_version=0.153.1" });

    assert.equal(response.status, 503);
    assert.equal(response.headers["Retry-After"], "5");
    assert.equal(JSON.parse(response.text).error.code, "ccdx_codex_model_catalog_unavailable");
  }
});

test("HTTP models route does not hide authentication failures with last-known-good data", async () => {
  const body = JSON.stringify({ error: "expired" });
  let catalogLoads = 0;
  const result = await invokeAdapter({
    codexModelCatalog: { load: async () => { catalogLoads += 1; return { models: [] }; } },
    modelRegistry: { models: { data: [{ id: "gpt-cached" }] } },
    listModelsFn: async () => ({ status: 401, body }),
  }, { method: "GET", url: "/v1/models?client_version=0.153.1" });

  assert.equal(result.status, 401);
  assert.equal(result.text, body);
  assert.equal(result.headers["X-CCDX-Model-Source"], undefined);
  assert.equal(catalogLoads, 0);
});

test("HTTP models route rejects malformed live data when no last-known-good list exists", async () => {
  const result = await invokeAdapter({
    modelRegistry: {},
    listModelsFn: async () => ({ status: 200, body: JSON.stringify({ data: [] }) }),
  }, { method: "GET", url: "/v1/models" });

  assert.equal(result.status, 502);
  assert.match(JSON.parse(result.text).error, /no valid models/);
});
