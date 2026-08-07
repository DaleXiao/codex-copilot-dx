import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";
import { createAdapterHandler } from "../src/adapter.mjs";
import {
  ADAPTER_STATUS_PATH,
  classifyAdapterRoute,
  createRequestMetrics,
  isLoopbackAddress,
  runtimeStatusPayload,
} from "../src/observability.mjs";
import { createRequestId, runWithRequestContext } from "../src/request-context.mjs";
import { status } from "../src/status.mjs";

async function invoke(handler, {
  method = "GET",
  url = "/missing",
  remoteAddress = "127.0.0.1",
  headers = {},
} = {}) {
  const req = Readable.from([]);
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress };

  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.destroyed = false;
  res.writableEnded = false;
  res.writableFinished = false;
  const chunks = [];
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.writeHead = (statusCode, responseHeaders = {}) => {
    res.statusCode = statusCode;
    Object.assign(res.headers, responseHeaders);
    return res;
  };
  res.write = (chunk) => {
    chunks.push(Buffer.from(chunk));
    return true;
  };
  res.end = (chunk) => {
    if (chunk !== undefined) chunks.push(Buffer.from(chunk));
    res.writableEnded = true;
    res.writableFinished = true;
    res.emit("finish");
    return res;
  };

  await handler(req, res);
  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: Buffer.concat(chunks).toString("utf8"),
  };
}

test("request context generates local ids and adds them only inside the async scope", () => {
  assert.match(createRequestId(), /^[a-f0-9-]{36}$/);
  assert.equal(
    runWithRequestContext({ requestId: "req-1" }, () => status("info", "hello")),
    "[INFO] hello",
  );
  assert.equal(
    runWithRequestContext({ requestId: "req-1", showRequestId: true }, () => status("info", "hello")),
    "[INFO] request_id=req-1 hello",
  );
  assert.equal(status("info", "hello"), "[INFO] hello");
});

test("request metrics use fixed route buckets and complete exactly once", () => {
  let now = 100;
  const metrics = createRequestMetrics({ now: () => now });
  const finish = metrics.begin("responses");
  now = 125;
  finish({ statusCode: 200 });
  finish({ statusCode: 500 });
  const fail = metrics.begin("unknown-route");
  now = 140;
  fail({ statusCode: 503, aborted: true });

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.total, 2);
  assert.equal(snapshot.completed, 2);
  assert.equal(snapshot.active, 0);
  assert.equal(snapshot.errors, 1);
  assert.equal(snapshot.aborted, 1);
  assert.equal(snapshot.by_route.responses.status_2xx, 1);
  assert.equal(snapshot.by_route.not_found.status_5xx, 1);
  assert.equal(snapshot.duration_ms_max, 25);
  assert.deepEqual(Object.keys(snapshot.by_route), [
    "responses",
    "responses_compact",
    "models",
    "messages",
    "messages_count_tokens",
    "pm_models",
    "pm_chat_completions",
    "pm_responses",
    "pm_embeddings",
    "not_found",
  ]);
});

test("adapter route classification and loopback checks do not trust forwarded addresses", () => {
  assert.equal(classifyAdapterRoute("POST", "/v1/responses/compact"), "responses_compact");
  assert.equal(classifyAdapterRoute("GET", "/v1/models"), "models");
  assert.equal(classifyAdapterRoute("GET", "/pm-ccdx/models"), "pm_models");
  assert.equal(classifyAdapterRoute("POST", "/pm-ccdx/chat/completions"), "pm_chat_completions");
  assert.equal(classifyAdapterRoute("GET", "/other"), "not_found");
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("127.999.0.1"), false);
  assert.equal(isLoopbackAddress("10.0.0.5"), false);
  assert.equal(isLoopbackAddress(""), false);
});

test("runtime status exposes isolated profile health without credential material", () => {
  const codexClient = {
    runtimeStatus: () => ({
      profile: "codex",
      token_cached: true,
      token_expires_in_ms: 90_000,
      token_refresh_in_flight: false,
      token_refresh_backoff_ms: 0,
      account_bound: true,
      upstream_host: "api.githubcopilot.com",
      model_endpoint_cache_entries: 4,
      model_list_flights: 1,
      token: "codex-secret-token",
      login: "enterprise-user",
      credential_path: "/private/codex-token",
      fingerprint: "codex-secret-fingerprint",
    }),
  };
  const claudeClient = {
    runtimeStatus: () => ({
      profile: "claude",
      token_cached: false,
      token_expires_in_ms: null,
      token_refresh_in_flight: true,
      token_refresh_backoff_ms: 5000,
      account_bound: false,
      upstream_host: "api.githubcopilot.com",
      model_endpoint_cache_entries: 2,
      model_list_flights: 0,
      token: "claude-secret-token",
      login: "personal-user",
      credential_path: "/private/claude-token",
      fingerprint: "claude-secret-fingerprint",
    }),
  };
  const payload = runtimeStatusPayload({
    codexClient,
    claudeClient,
    codexModelRegistry: {
      source: "live",
      models: { data: [{ id: "gpt-a" }, { id: "gpt-b" }] },
      modelDefs: [{ id: "claude-a" }],
      cache_path: "/private/codex-models",
    },
    claudeModelRegistry: {
      source: "custom-source",
      models: { data: [{ id: "claude-a" }] },
      modelDefs: [{ id: "claude-a" }],
      cache_path: "/private/claude-models",
    },
    claudeMode: "isolated",
  });

  assert.equal(payload.profiles.codex.mode, "legacy");
  assert.equal(payload.profiles.claude.mode, "isolated");
  assert.deepEqual(payload.routing, { responses: "codex", messages: "claude" });
  assert.deepEqual(payload.copilot, {
    token_cached: true,
    token_expires_in_ms: 90_000,
    token_refresh_in_flight: false,
    token_refresh_backoff_ms: 0,
    account_bound: true,
    upstream_host: "api.githubcopilot.com",
    model_endpoint_cache_entries: 4,
    model_list_flights: 1,
  });
  assert.deepEqual(payload.models, { source: "live", models: 2, claude_models: 1 });
  assert.strictEqual(payload.copilot, payload.profiles.codex.client);
  assert.strictEqual(payload.models, payload.profiles.codex.models);
  assert.equal(payload.profiles.codex.models.source, "live");
  assert.equal(payload.profiles.claude.models.source, "custom-source");
  assert.equal(payload.profiles.codex.client.model_endpoint_cache_entries, 4);
  assert.equal(payload.profiles.claude.client.token_refresh_in_flight, true);
  assert.deepEqual(Object.keys(payload.profiles.codex.client), [
    "token_cached",
    "token_expires_in_ms",
    "token_refresh_in_flight",
    "token_refresh_backoff_ms",
    "account_bound",
    "upstream_host",
    "model_endpoint_cache_entries",
    "model_list_flights",
  ]);
  const serialized = JSON.stringify(payload);
  for (const secret of [
    "codex-secret-token",
    "enterprise-user",
    "/private/codex-token",
    "codex-secret-fingerprint",
    "claude-secret-token",
    "personal-user",
    "/private/claude-token",
    "claude-secret-fingerprint",
    "/private/codex-models",
    "/private/claude-models",
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("runtime status reuses Codex health for an inherited Claude profile", () => {
  let claudeStatusCalls = 0;
  const codexClient = {
    runtimeStatus: () => ({
      token_cached: true,
      token_expires_in_ms: 60_000,
      upstream_host: "api.githubcopilot.com",
    }),
  };
  const codexModelRegistry = {
    source: "cache",
    models: { data: [{ id: "gpt-a" }] },
    modelDefs: [{ id: "claude-a" }],
  };
  const payload = runtimeStatusPayload({
    codexClient,
    claudeClient: { runtimeStatus: () => { claudeStatusCalls += 1; return {}; } },
    codexModelRegistry,
    claudeModelRegistry: { source: "live", models: { data: [] }, modelDefs: [] },
    claudeMode: "inherited",
  });

  assert.equal(claudeStatusCalls, 0);
  assert.equal(payload.profiles.claude.mode, "inherited");
  assert.strictEqual(payload.profiles.claude.client, payload.profiles.codex.client);
  assert.strictEqual(payload.profiles.claude.models, payload.profiles.codex.models);
  assert.deepEqual(payload.routing, { responses: "codex", messages: "codex" });
});

test("runtime status is loopback-only and excludes its own probe from request metrics", async () => {
  const metrics = createRequestMetrics();
  const handler = createAdapterHandler({ requestMetrics: metrics });
  const missing = await invoke(handler, {
    url: "/missing",
    headers: { "x-request-id": "caller-value-is-not-trusted" },
  });
  assert.equal(missing.statusCode, 404);
  assert.match(missing.headers["X-Request-Id"], /^[a-f0-9-]{36}$/);
  assert.notEqual(missing.headers["X-Request-Id"], "caller-value-is-not-trusted");

  const local = await invoke(handler, { url: ADAPTER_STATUS_PATH });
  assert.equal(local.statusCode, 200);
  assert.equal(local.headers["Cache-Control"], "no-store");
  const payload = JSON.parse(local.body);
  assert.equal(payload.name, "codex-copilot-dx");
  assert.equal(payload.requests.total, 1);
  assert.equal(payload.requests.by_route.not_found.status_4xx, 1);
  assert.equal(typeof payload.process.rss_bytes, "number");
  assert.equal(typeof payload.response_history.entries, "number");
  assert.equal(typeof payload.image_optimization.active, "number");
  assert.equal(typeof payload.stream_performance.by_route.responses.ttft_ms.samples, "number");
  assert.equal(typeof payload.image_optimization.cache_entries, "number");
  assert.equal(typeof payload.image_optimization.cache_bytes, "number");
  assert.equal(typeof payload.image_optimization.cache_inflight, "number");
  assert.equal(typeof payload.copilot.token_cached, "boolean");
  assert.equal(Object.hasOwn(payload.copilot, "token"), false);
  assert.deepEqual(payload.copilot, payload.profiles.codex.client);
  assert.deepEqual(payload.models, payload.profiles.codex.models);
  assert.equal(payload.profiles.codex.mode, "legacy");
  assert.equal(payload.profiles.claude.mode, "inherited");
  assert.deepEqual(payload.routing, { responses: "codex", messages: "codex" });

  const remote = await invoke(handler, {
    url: ADAPTER_STATUS_PATH,
    remoteAddress: "10.0.0.5",
    headers: { "x-forwarded-for": "127.0.0.1" },
  });
  assert.equal(remote.statusCode, 403);
  assert.deepEqual(JSON.parse(remote.body), { error: "Runtime status is available only from loopback" });
});

test("adapter status wiring reports independently injected Codex and Claude profiles", async () => {
  const client = (runtime) => ({
    runtimeStatus: () => runtime,
    chatCompletions: async () => {},
    responses: async () => {},
    responsesCompact: async () => {},
    listModels: async () => ({ status: 200, body: '{"data":[]}' }),
    getCachedModelEndpoints: () => null,
  });
  const handler = createAdapterHandler({
    codexClient: client({ token_cached: true, upstream_host: "codex.example" }),
    claudeClient: client({ token_cached: false, upstream_host: "claude.example" }),
    codexModelRegistry: { source: "live", models: { data: [{ id: "gpt-a" }] }, modelDefs: [] },
    claudeModelRegistry: { source: "cache", models: { data: [{ id: "claude-a" }] }, modelDefs: [{ id: "claude-a" }] },
  });

  const response = await invoke(handler, { url: ADAPTER_STATUS_PATH });
  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.profiles.codex.client.upstream_host, "codex.example");
  assert.equal(payload.profiles.claude.client.upstream_host, "claude.example");
  assert.equal(payload.profiles.codex.models.models, 1);
  assert.equal(payload.profiles.claude.models.claude_models, 1);
  assert.equal(payload.profiles.claude.mode, "isolated");
  assert.deepEqual(payload.routing, { responses: "codex", messages: "claude" });
});
