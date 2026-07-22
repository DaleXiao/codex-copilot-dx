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
    "not_found",
  ]);
});

test("adapter route classification and loopback checks do not trust forwarded addresses", () => {
  assert.equal(classifyAdapterRoute("POST", "/v1/responses/compact"), "responses_compact");
  assert.equal(classifyAdapterRoute("GET", "/v1/models"), "models");
  assert.equal(classifyAdapterRoute("GET", "/other"), "not_found");
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("127.999.0.1"), false);
  assert.equal(isLoopbackAddress("10.0.0.5"), false);
  assert.equal(isLoopbackAddress(""), false);
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
  assert.equal(typeof payload.copilot.token_cached, "boolean");
  assert.equal(Object.hasOwn(payload.copilot, "token"), false);

  const remote = await invoke(handler, {
    url: ADAPTER_STATUS_PATH,
    remoteAddress: "10.0.0.5",
    headers: { "x-forwarded-for": "127.0.0.1" },
  });
  assert.equal(remote.statusCode, 403);
  assert.deepEqual(JSON.parse(remote.body), { error: "Runtime status is available only from loopback" });
});
