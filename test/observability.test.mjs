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

test("request metrics use fixed Codex route buckets and complete exactly once", () => {
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
  assert.equal(snapshot.errors, 1);
  assert.equal(snapshot.aborted, 1);
  assert.equal(snapshot.by_route.responses.status_2xx, 1);
  assert.equal(snapshot.by_route.not_found.status_5xx, 1);
  assert.deepEqual(Object.keys(snapshot.by_route), [
    "responses",
    "responses_compact",
    "models",
    "not_found",
  ]);
});

test("route classification recognizes only supported Codex routes", () => {
  assert.equal(classifyAdapterRoute("POST", "/v1/responses"), "responses");
  assert.equal(classifyAdapterRoute("POST", "/v1/responses/compact"), "responses_compact");
  assert.equal(classifyAdapterRoute("GET", "/v1/models"), "models");
  assert.equal(classifyAdapterRoute("POST", "/v1/messages"), "not_found");
  assert.equal(classifyAdapterRoute("GET", "/pm-ccdx/models"), "not_found");
  assert.equal(classifyAdapterRoute("GET", "/other"), "not_found");
});

test("loopback checks do not trust non-loopback or malformed addresses", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("127.999.0.1"), false);
  assert.equal(isLoopbackAddress("10.0.0.5"), false);
  assert.equal(isLoopbackAddress(""), false);
});

test("runtime status exposes only bounded Codex client and model health", () => {
  const codexClient = {
    runtimeStatus: () => ({
      token_cached: true,
      token_expires_in_ms: 90_000,
      token_refresh_in_flight: false,
      token_refresh_backoff_ms: 0,
      account_bound: true,
      upstream_host: "api.githubcopilot.com",
      model_endpoint_cache_entries: 4,
      model_list_flights: 1,
      token: "secret-token",
      login: "secret-login",
      credential_path: "/private/token",
    }),
  };
  const payload = runtimeStatusPayload({
    codexClient,
    codexModelRegistry: {
      source: "live",
      models: { data: [{ id: "gpt-a" }, { id: "gpt-b" }] },
      cache_path: "/private/models",
    },
  });

  assert.deepEqual(payload.routing, { responses: "codex" });
  assert.deepEqual(Object.keys(payload.profiles), ["codex"]);
  assert.deepEqual(payload.models, { source: "live", models: 2 });
  assert.strictEqual(payload.copilot, payload.profiles.codex.client);
  assert.strictEqual(payload.models, payload.profiles.codex.models);
  const serialized = JSON.stringify(payload);
  for (const secret of ["secret-token", "secret-login", "/private/token", "/private/models"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("runtime status exposes bounded model-cache refresh diagnostics", () => {
  const savedAtMs = Date.now() - 5000;
  const payload = runtimeStatusPayload({
    codexModelRegistry: {
      source: "cache",
      models: { data: [{ id: "gpt-a" }] },
      cacheState: "stale",
      cacheSavedAtMs: savedAtMs,
      refreshInFlight: true,
      generation: 3,
      lastError: "Copilot models returned HTTP 503",
      lastErrorAtMs: savedAtMs + 1000,
    },
  });

  assert.equal(payload.models.cache_state, "stale");
  assert.equal(payload.models.cache_age_ms >= 5000, true);
  assert.equal(payload.models.refresh_in_flight, true);
  assert.equal(payload.models.generation, 3);
  assert.equal(payload.models.last_error, "Copilot models returned HTTP 503");
  assert.equal(payload.models.last_error_at_ms, savedAtMs + 1000);
});

test("runtime status is loopback-only, owns request ids, and excludes its probes from metrics", async () => {
  const metrics = createRequestMetrics();
  const handler = createAdapterHandler({ requestMetrics: metrics });
  const missing = await invoke(handler, {
    headers: { "x-request-id": "caller-value-is-not-trusted" },
  });
  assert.equal(missing.statusCode, 404);
  assert.match(missing.headers["X-Request-Id"], /^[a-f0-9-]{36}$/);
  assert.notEqual(missing.headers["X-Request-Id"], "caller-value-is-not-trusted");

  const local = await invoke(handler, { url: ADAPTER_STATUS_PATH });
  assert.equal(local.statusCode, 200);
  assert.equal(local.headers["Cache-Control"], "no-store");
  const payload = JSON.parse(local.body);
  assert.equal(payload.requests.total, 1);
  assert.equal(payload.requests.by_route.not_found.status_4xx, 1);
  assert.equal(typeof payload.process.rss_bytes, "number");
  assert.equal(typeof payload.stream_performance.by_route.responses.ttft_ms.samples, "number");
  assert.equal(Object.hasOwn(payload.copilot, "token"), false);
  assert.deepEqual(Object.keys(payload.profiles), ["codex"]);
  assert.deepEqual(payload.routing, { responses: "codex" });

  const remote = await invoke(handler, {
    url: ADAPTER_STATUS_PATH,
    remoteAddress: "10.0.0.5",
    headers: { "x-forwarded-for": "127.0.0.1" },
  });
  assert.equal(remote.statusCode, 403);
  assert.deepEqual(JSON.parse(remote.body), { error: "Runtime status is available only from loopback" });
  assert.equal(metrics.snapshot().total, 1);
});
