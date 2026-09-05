import { test } from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import { cacheModelEndpoints, resetModelEndpointCacheForTests } from "../src/copilot.mjs";
import { prepareResponsesChatPayload } from "../src/responses-chat-payload.mjs";
import {
  abortErrorStatusCode,
  clearResponseHistoryForTests,
  configureResponseHistoryForTests,
  createAdapterHandler,
  createRequestAdmission,
  createRequestAbort,
  isAbortLikeError,
  isEncryptedContentVerificationError,
  isImageNamespaceCollisionError,
  forwardToChat,
  openCopilotResponse,
  prepareResponsesRequest,
  readJsonBody,
  rememberResponseHistory,
  responseHistoryStats,
  requestPath,
  responsesToChat,
  sanitizeImageNamespaceCollisionRequest,
  sanitizeEncryptedReasoningRequest,
  stripInternalResponsesInputFields,
  writeOrDrain,
} from "../src/adapter.mjs";
import { autoReviewModelPreference, writeAutoReviewModel } from "../src/user-settings.mjs";
import { responsesHistoricalImageStats } from "../src/responses-byte-budget.mjs";
import { isResponsesToolOutputItem, readResponsesToolOutputParts } from "../src/responses-content.mjs";
import { createResponsesImagePressureController } from "../src/responses-image-pressure.mjs";
import {
  MAX_UPSTREAM_CHAT_SUCCESS_BODY_BYTES,
  MAX_UPSTREAM_RESPONSES_SUCCESS_BODY_BYTES,
} from "../src/http-transport.mjs";
import { RUNTIME_DEFAULTS } from "../src/runtime-config.mjs";

const gzipAsync = promisify(zlib.gzip);
const zstdCompressAsync = zlib.zstdCompress ? promisify(zlib.zstdCompress) : null;

function jsonRequest(body, contentEncoding, headers = {}) {
  const req = Readable.from([body]);
  req.headers = { ...headers };
  if (contentEncoding) req.headers["content-encoding"] = contentEncoding;
  return req;
}

async function invokeAdapterRequest(options, req) {
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.headersSent = false;
  res.statusCode = 200;
  res.headers = {};
  const chunks = [];
  res.writeHead = (statusCode, headers = {}) => {
    res.statusCode = statusCode;
    res.headers = { ...res.headers, ...headers };
    res.headersSent = true;
    return res;
  };
  res.write = (chunk) => {
    chunks.push(Buffer.from(chunk));
    return true;
  };
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  res.end = (chunk) => {
    if (chunk !== undefined) chunks.push(Buffer.from(chunk));
    res.writableEnded = true;
    finish();
    return res;
  };

  const handler = createAdapterHandler(options);
  try {
    const pending = handler(req, res);
    await Promise.all([pending, finished]);
    return {
      status: res.statusCode,
      headers: res.headers,
      text: Buffer.concat(chunks).toString("utf8"),
    };
  } finally {
    handler.cleanup?.();
  }
}

async function invokeAdapter(options, { method = "POST", url = "/v1/responses", body, headers = {} } = {}) {
  const req = jsonRequest(Buffer.from(JSON.stringify(body ?? {})), undefined, { "content-type": "application/json", ...headers });
  req.method = method;
  req.url = url;
  req.socket = { remoteAddress: "127.0.0.1" };
  return invokeAdapterRequest(options, req);
}

test("requestPath: ignores query strings on API routes", () => {
  assert.equal(requestPath("/v1/responses?stream=true"), "/v1/responses");
  assert.equal(requestPath("/v1/responses/compact?stream=true"), "/v1/responses/compact");
  assert.equal(requestPath("/v1/models?foo=bar"), "/v1/models");
});

test("createAdapterHandler rejects a malformed request target without throwing", async () => {
  const response = await invokeAdapter({}, { method: "GET", url: "http://[" });

  assert.equal(response.status, 400);
  assert.equal(response.headers.Connection, "close");
  assert.deepEqual(JSON.parse(response.text), { error: "Invalid request target" });
});

test("createAdapterHandler: tracks terminal activity for one request lifecycle", () => {
  let started = 0;
  let finished = 0;
  const terminalActivity = {
    beginRequest() {
      started += 1;
      return () => { finished += 1; };
    },
  };
  const req = Readable.from([]);
  req.method = "GET";
  req.url = "/missing";
  req.headers = {};

  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.writeHead = (statusCode) => { res.statusCode = statusCode; };
  res.end = () => {
    res.writableEnded = true;
    res.writableFinished = true;
    res.emit("finish");
    res.emit("close");
  };

  createAdapterHandler({ terminalActivity })(req, res);
  assert.equal(started, 1);
  assert.equal(finished, 1);
});

test("createAdapterHandler contains unexpected synchronous and asynchronous dispatch failures", async () => {
  for (const dispatchRequestForTests of [
    () => { throw new Error("secret synchronous detail"); },
    async () => { throw new Error("secret asynchronous detail"); },
  ]) {
    const response = await invokeAdapter({ dispatchRequestForTests }, { body: { input: "hello" } });
    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(response.text), {
      error: {
        message: "Internal adapter error",
        type: "server_error",
        code: "ccdx_internal_error",
      },
    });
    assert.equal(response.text.includes("secret"), false);
  }
});

test("createAdapterHandler contains non-Error rejection and metric completion failures", async () => {
  for (const rejection of [null, "secret rejection value"]) {
    const response = await invokeAdapter({
      dispatchRequestForTests: () => Promise.reject(rejection),
      requestMetrics: {
        begin() { return () => { throw new Error("metrics failure"); }; },
      },
    }, { body: { input: "hello" } });
    assert.equal(response.status, 500);
    assert.equal(JSON.parse(response.text).error.code, "ccdx_internal_error");
    assert.equal(response.text.includes("secret"), false);
  }
});

test("HTTP retired Claude routes return 410 without reading the body or contacting upstream", async () => {
  const upstreamCalls = [];
  const unexpectedCall = (name) => () => {
    upstreamCalls.push(name);
    throw new Error(`${name} should not be called`);
  };
  const options = {
    acquireRequest: unexpectedCall("request admission"),
    chatCompletionsFn: unexpectedCall("Chat Completions"),
    responsesFn: unexpectedCall("Responses"),
    responsesCompactFn: unexpectedCall("Responses compact"),
    listModelsFn: unexpectedCall("models"),
  };

  for (const url of ["/v1/messages?beta=true", "/v1/messages/count_tokens?beta=true"]) {
    let bodyRead = false;
    const req = new Readable({
      read() {
        bodyRead = true;
        this.push(Buffer.from("{not valid json"));
        this.push(null);
      },
    });
    req.method = "POST";
    req.url = url;
    req.headers = { "content-type": "application/json" };
    req.socket = { remoteAddress: "127.0.0.1" };

    const result = await invokeAdapterRequest(options, req);
    assert.equal(result.status, 410);
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.equal(JSON.parse(result.text).error.code, "ccdx_claude_retired");
    assert.equal(bodyRead, false);
  }
  assert.deepEqual(upstreamCalls, []);
});

test("HTTP PM Studio namespace is not mounted", async () => {
  for (const [method, url] of [
    ["GET", "/pm-ccdx/models"],
    ["POST", "/pm-ccdx/chat/completions"],
    ["POST", "/pm-ccdx/responses"],
    ["POST", "/pm-ccdx/embeddings"],
  ]) {
    const result = await invokeAdapter({}, { method, url, body: { model: "gpt-5.6-sol" } });
    assert.equal(result.status, 404);
    assert.deepEqual(JSON.parse(result.text), { error: "Not found" });
  }
});

test("createRequestAbort: records client close reason", () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writableEnded = false;

  const abort = createRequestAbort(req, res);
  res.emit("close");

  assert.equal(abort.signal.aborted, true);
  assert.equal(abort.reason, "client_closed");
  abort.cleanup();
});

test("createRequestAbort: ignores normal response close after end", () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writableEnded = true;

  const abort = createRequestAbort(req, res);
  res.emit("close");

  assert.equal(abort.signal.aborted, false);
  assert.equal(abort.reason, null);
  abort.cleanup();
});

test("createRequestAbort: records timeout reason", async () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writableEnded = false;

  const abort = createRequestAbort(req, res);
  abort.setTimeout(1);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(abort.signal.aborted, true);
  assert.equal(abort.reason, "upstream_timeout");
  abort.cleanup();
});

test("createRequestAdmission: shares a byte budget without blocking a fitting request", async () => {
  const acquire = createRequestAdmission({ maxBytes: 10, maxQueued: 2, waitTimeoutMs: 1000 });
  const request = (bytes) => ({ headers: { "content-length": String(bytes) } });
  const releaseFirst = await acquire(request(8));
  let secondStarted = false;
  const second = acquire(request(8)).then((release) => {
    secondStarted = true;
    return release;
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(secondStarted, false);
  const releaseSmall = await acquire(request(2));
  assert.deepEqual(acquire.stats(), { activeBytes: 10, queued: 1, maxBytes: 10 });
  assert.deepEqual(
    Object.fromEntries(Object.entries(acquire.diagnostics()).filter(([key]) => ["activeRequests", "total", "activated", "queuedTotal"].includes(key))),
    { activeRequests: 2, total: 3, activated: 2, queuedTotal: 1 },
  );

  releaseSmall();
  releaseFirst();
  const releaseSecond = await second;
  assert.equal(secondStarted, true);
  releaseSecond();
  assert.deepEqual(acquire.stats(), { activeBytes: 0, queued: 0, maxBytes: 10 });
});

test("createRequestAdmission: bounds and times out its waiting queue", async () => {
  const request = { headers: { "content-length": "10" } };
  const acquire = createRequestAdmission({ maxBytes: 10, maxQueued: 1, waitTimeoutMs: 10 });
  const releaseFirst = await acquire(request);
  const second = acquire(request);
  const keepAlive = setTimeout(() => {}, 1000);

  try {
    await assert.rejects(acquire(request), (error) => error.statusCode === 503 && /queue is full/.test(error.message));
    await assert.rejects(second, (error) => error.statusCode === 503 && /admission timed out/.test(error.message));
    assert.equal(acquire.stats().queued, 0);
    assert.deepEqual(
      Object.fromEntries(Object.entries(acquire.diagnostics()).filter(([key]) => ["rejected", "timedOut", "aborted"].includes(key))),
      { rejected: 1, timedOut: 1, aborted: 0 },
    );
  } finally {
    clearTimeout(keepAlive);
    releaseFirst();
  }
});

test("createRequestAdmission: weights compressed bodies and treats unknown bodies as exclusive", async () => {
  const acquire = createRequestAdmission({ maxBytes: 10, maxQueued: 2, waitTimeoutMs: 1000 });
  const releaseCompressed = await acquire({ headers: { "content-length": "3", "content-encoding": "gzip" } });
  let nextStarted = false;
  const next = acquire({ headers: { "content-length": "1" } }).then((release) => {
    nextStarted = true;
    return release;
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(nextStarted, false);
  releaseCompressed();
  const releaseNext = await next;
  releaseNext();

  const releaseUnknown = await acquire({ headers: {} });
  assert.equal(acquire.stats().activeBytes, 10);
  releaseUnknown();
});

test("createRequestAdmission: a waiting unknown body blocks later arrivals without starving", async () => {
  const acquire = createRequestAdmission({ maxBytes: 10, maxQueued: 2, waitTimeoutMs: 1000 });
  const releaseActive = await acquire({ headers: { "content-length": "6" } });
  let exclusiveStarted = false;
  let laterStarted = false;
  const exclusive = acquire({ headers: {} }).then((release) => {
    exclusiveStarted = true;
    return release;
  });
  const later = acquire({ headers: { "content-length": "4" } }).then((release) => {
    laterStarted = true;
    return release;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exclusiveStarted, false);
  assert.equal(laterStarted, false);
  assert.deepEqual(acquire.stats(), { activeBytes: 6, queued: 2, maxBytes: 10 });

  releaseActive();
  const releaseExclusive = await exclusive;
  assert.equal(exclusiveStarted, true);
  assert.equal(laterStarted, false);
  releaseExclusive();
  const releaseLater = await later;
  assert.equal(laterStarted, true);
  releaseLater();
  assert.deepEqual(acquire.stats(), { activeBytes: 0, queued: 0, maxBytes: 10 });
});

test("createRequestAdmission: aborting an exclusive waiter immediately removes its fairness barrier", async () => {
  const acquire = createRequestAdmission({ maxBytes: 10, maxQueued: 1, waitTimeoutMs: 1000 });
  const releaseActive = await acquire({ headers: { "content-length": "6" } });
  const controller = new AbortController();
  const exclusive = acquire({ headers: {} }, { signal: controller.signal });

  await assert.rejects(
    acquire({ headers: { "content-length": "4" } }),
    (error) => error.statusCode === 503 && /queue is full/.test(error.message),
  );

  controller.abort();
  await assert.rejects(exclusive, (error) => error.name === "AbortError");
  const releaseLater = await acquire({ headers: { "content-length": "4" } });
  assert.equal(acquire.stats().activeBytes, 10);
  releaseLater();
  releaseActive();
  assert.deepEqual(
    Object.fromEntries(Object.entries(acquire.diagnostics()).filter(([key]) => ["rejected", "aborted"].includes(key))),
    { rejected: 1, aborted: 1 },
  );
});

test("readJsonBody reserves actual decoded bytes until the request admission is released", async () => {
  const raw = Buffer.from(JSON.stringify({ input: "x".repeat(2048) }));
  const compressed = await gzipAsync(raw);
  const req = jsonRequest(compressed, "gzip", { "content-length": String(compressed.length) });
  const acquire = createRequestAdmission({ maxBytes: 4096, maxQueued: 2, waitTimeoutMs: 1000 });
  const admission = await acquire(req);

  const parsed = await readJsonBody(req, { admission });

  assert.equal(parsed.input.length, 2048);
  assert.equal(acquire.diagnostics().decompressionsActive, 0);
  assert.equal(acquire.diagnostics().decodedBodyBytes, raw.length);
  admission();
  assert.equal(acquire.diagnostics().decodedBodyBytes, 0);
});

test("request admission accounts for response history separately from the small inbound body", async () => {
  const acquire = createRequestAdmission({ maxBytes: 4096, maxQueued: 2, waitTimeoutMs: 1000 });
  const admission = await acquire({ headers: { "content-length": "64" } });

  await admission.reserveResponseHistory(2048);

  assert.equal(acquire.diagnostics().activeBytes, 64);
  assert.equal(acquire.diagnostics().responseHistoryBytes, 2048);
  admission();
  assert.equal(acquire.diagnostics().responseHistoryBytes, 0);
});

test("supplemental admission lets a fitting history reservation bypass a larger waiter", async () => {
  const acquire = createRequestAdmission({ maxBytes: 10, maxQueued: 2, waitTimeoutMs: 1000 });
  const first = await acquire({ headers: { "content-length": "1" } });
  const second = await acquire({ headers: { "content-length": "1" } });
  const third = await acquire({ headers: { "content-length": "1" } });
  await first.reserveResponseHistory(6);
  const waiting = second.reserveResponseHistory(6);
  await new Promise((resolve) => setImmediate(resolve));

  await third.reserveResponseHistory(4);

  assert.equal(acquire.diagnostics().responseHistoryBytes, 10);
  assert.equal(acquire.diagnostics().responseHistoriesQueued, 1);
  third();
  first();
  await waiting;
  second();
  assert.equal(acquire.diagnostics().responseHistoryBytes, 0);
});

test("abort helpers classify expected abort errors", () => {
  assert.equal(isAbortLikeError(new DOMException("This operation was aborted", "AbortError")), true);
  assert.equal(isAbortLikeError(new Error("This operation was aborted")), true);
  assert.equal(isAbortLikeError(new Error("socket hang up")), false);
  assert.equal(abortErrorStatusCode("upstream_timeout"), 504);
  assert.equal(abortErrorStatusCode("stream_handshake_timeout"), 504);
  assert.equal(abortErrorStatusCode("request_body_timeout"), 408);
  assert.equal(abortErrorStatusCode("stream_idle_timeout"), 504);
  assert.equal(abortErrorStatusCode("client_closed"), 499);
  assert.equal(abortErrorStatusCode(), 502);
});

test("HTTP responses body timeout aborts a stalled read and releases admission", async () => {
  const body = Buffer.from(JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }));
  const req = Readable.from((async function* slowBody() {
    yield body.subarray(0, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    yield body.subarray(1);
  })());
  req.headers = { "content-length": String(body.length), "content-type": "application/json" };
  req.method = "POST";
  req.url = "/v1/responses";
  req.socket = { remoteAddress: "127.0.0.1" };
  const destroyRequest = req.destroy.bind(req);
  let requestDestroyed = false;
  req.destroy = (...args) => {
    requestDestroyed = true;
    return destroyRequest(...args);
  };
  const admission = createRequestAdmission({ maxBytes: 1024, maxQueued: 2, waitTimeoutMs: 1000 });
  let upstreamCalled = false;

  const response = await invokeAdapterRequest({
    acquireRequest: admission,
    requestBodyTimeoutMs: 5,
    responsesFn: async () => {
      upstreamCalled = true;
      return Response.json({ id: "unexpected", output: [] });
    },
  }, req);

  assert.equal(response.status, 408);
  assert.equal(response.headers.Connection, "close");
  assert.equal(upstreamCalled, false);
  assert.equal(requestDestroyed, false);
  assert.equal(admission.diagnostics().activeRequests, 0);
});

test("HTTP proxy routes classify upstream network failures as Bad Gateway", async () => {
  const failure = async () => { throw new Error("upstream unavailable"); };
  const cases = [
    [{ responsesFn: failure }, { body: { model: "gpt-5.6-sol", input: "hello" } }],
    [{ responsesCompactFn: failure }, { url: "/v1/responses/compact", body: { model: "gpt-5.6-sol", input: "hello" } }],
  ];

  for (const [options, request] of cases) {
    const result = await invokeAdapter(options, request);
    assert.equal(result.status, 502);
    assert.deepEqual(JSON.parse(result.text), { error: "upstream unavailable" });
  }
});

test("HTTP native Responses releases request admission after upstream opens", async () => {
  clearResponseHistoryForTests();
  const history = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "earlier context" });
  rememberResponseHistory(history, { id: "resp_release_root", status: "completed", output: [] });
  let released = false;
  let observedContext;
  const result = await invokeAdapter({
    acquireRequest: async () => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        released = true;
      };
    },
    imagePressure: {
      apply(context) {
        observedContext = context;
        return { adapted: false, pressureEligible: false };
      },
    },
    responsesFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => {
        assert.equal(released, true);
        assert.equal(observedContext.body.input.length, 1);
        assert.equal(observedContext.currentInputStart, 0);
        return JSON.stringify({ id: "resp_release", output: [] });
      },
    }),
  }, {
    body: {
      model: "gpt-5.6-sol",
      stream: false,
      previous_response_id: "resp_release_root",
      input: "hello",
    },
  });

  assert.equal(result.status, 200);
  assert.equal(released, true);
  clearResponseHistoryForTests();
});

test("HTTP compact releases original and compatibility-retry tool caches after upstream opens", async () => {
  const output = JSON.stringify([{ type: "input_text", text: "cached compact output" }]);
  const originalParse = JSON.parse;
  let parses = 0;
  let attempts = 0;
  JSON.parse = function countedParse(value, ...args) {
    if (value === output) parses += 1;
    return originalParse.call(this, value, ...args);
  };

  try {
    const result = await invokeAdapter({
      responsesCompactFn: async (body) => {
        attempts += 1;
        if (attempts === 1) {
          assert.equal(parses, 1);
          return new Response(JSON.stringify({
            error: { message: "Encrypted content could not be verified because it could not be decrypted" },
          }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const toolOutput = body.input.find((item) => item?.type === "function_call_output");
        readResponsesToolOutputParts(toolOutput);
        assert.equal(parses, 2);
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: async () => {
            readResponsesToolOutputParts(toolOutput);
            assert.equal(parses, 3);
            return JSON.stringify({
              id: "resp_compact_cache_release",
              status: "completed",
              output: [{ type: "compaction", id: "cmp_cache_release", encrypted_content: "fresh-state" }],
            });
          },
        };
      },
    }, {
      url: "/v1/responses/compact",
      body: {
        model: "gpt-5.6-sol",
        input: [
          { type: "function_call_output", call_id: "call_cache", output },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "keep", encrypted_content: "stale" }],
          },
        ],
      },
    });

    assert.equal(result.status, 200);
    assert.equal(attempts, 2);
    assert.equal(parses, 3);
  } finally {
    JSON.parse = originalParse;
  }
});

test("HTTP Responses does not start upstream after synchronous prepare work exceeds its deadline", async () => {
  clearResponseHistoryForTests();
  const history = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "visual history" });
  rememberResponseHistory(history, { id: "resp_prepare_deadline", status: "completed", output: [] });
  let clock = 0;
  let upstreamCalled = false;
  let timeoutMarked = false;
  let cooperativeCheckReceived = false;

  const result = await invokeAdapter({
    now: () => clock,
    upstreamTimeoutMs: 100,
    imagePressure: {
      apply(_context, { assertActive }) {
        cooperativeCheckReceived = typeof assertActive === "function";
        clock = 101;
        return { adapted: false, pressureEligible: true };
      },
      markTimeout(_rootId, { eligible }) {
        timeoutMarked = eligible;
        return eligible;
      },
    },
    responsesFn: async () => {
      upstreamCalled = true;
      return Response.json({ id: "unexpected", output: [] });
    },
  }, {
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_prepare_deadline",
      input: "continue",
    },
  });

  assert.equal(result.status, 504);
  assert.equal(JSON.parse(result.text).error.code, "ccdx_visual_history_timeout");
  assert.equal(upstreamCalled, false);
  assert.equal(timeoutMarked, true);
  assert.equal(cooperativeCheckReceived, true);
  clearResponseHistoryForTests();
});

test("HTTP Responses records visual timeout against the original root after an encrypted route rebase", async () => {
  clearResponseHistoryForTests();
  try {
    const imagePressure = createResponsesImagePressureController();
    const historicalInput = Array.from({ length: 36 }, (_, index) => ({
      type: "message",
      role: "user",
      content: [{
        type: "input_image",
        image_url: `data:image/png;base64,${Buffer.alloc(128, index + 1).toString("base64")}`,
      }],
    }));
    let upstreamCalls = 0;
    const responsesFn = async (_body, { onUpstreamStart, signal }) => {
      upstreamCalls += 1;
      onUpstreamStart();
      if (upstreamCalls === 1) {
        return Response.json({
          id: "resp_rebase_timeout_root",
          status: "completed",
          output: [{ type: "reasoning", encrypted_content: "route-bound-state", summary: [] }],
        });
      }
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason || new DOMException("This operation was aborted", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    };
    // Keep the wall deadline above CI scheduling jitter so this exercises the
    // upstream-timeout rebase path instead of expiring during preparation.
    const options = { imagePressure, responsesFn, upstreamTimeoutMs: 100 };

    const root = await invokeAdapter(options, {
      body: { model: "gpt-5.5", input: historicalInput },
    });
    assert.equal(root.status, 200);

    const rebased = await invokeAdapter(options, {
      body: {
        model: "gpt-5.6-sol",
        previous_response_id: "resp_rebase_timeout_root",
        input: "continue on the new route",
      },
    });
    assert.equal(rebased.status, 504);
    assert.equal(JSON.parse(rebased.text).error.code, "ccdx_visual_history_timeout");
    assert.equal(imagePressure.snapshot().timeouts_recorded, 1);
    assert.equal(imagePressure.snapshot().active_recovery_trees, 1);
  } finally {
    clearResponseHistoryForTests();
  }
});

test("HTTP Responses does not start a compatibility retry after the upstream wall deadline", async () => {
  let clock = 0;
  let attempts = 0;
  const result = await invokeAdapter({
    now: () => clock,
    upstreamTimeoutMs: 100,
    imagePressure: {
      apply() {
        return { adapted: false, pressureEligible: true };
      },
      markTimeout() {
        return true;
      },
    },
    responsesFn: async (_body, requestOptions) => {
      attempts += 1;
      requestOptions.onUpstreamStart();
      if (attempts === 1) {
        clock = 101;
        return new Response(JSON.stringify({
          error: { message: "Encrypted content could not be verified because it could not be decrypted" },
        }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      return Response.json({ id: "unexpected_retry", status: "completed", output: [] });
    },
  }, {
    body: {
      model: "gpt-5.6-sol",
      input: [{ type: "reasoning", encrypted_content: "stale", summary: [] }],
    },
  });

  assert.equal(result.status, 504);
  assert.equal(JSON.parse(result.text).error.code, "ccdx_visual_history_timeout");
  assert.equal(attempts, 1);
});

test("HTTP streaming responses time out while waiting for upstream headers", async () => {
  const result = await invokeAdapter({
    streamHandshakeTimeoutMs: 5,
    chatCompletionsFn: (_body, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")), { once: true });
    }),
  }, {
    body: { model: "gpt-4o", stream: true, input: "hello" },
  });

  assert.equal(result.status, 504);
  assert.match(result.text, /aborted/i);
});

test("HTTP streaming responses time out when the upstream body becomes idle", async () => {
  const result = await invokeAdapter({
    streamIdleTimeoutMs: 5,
    chatCompletionsFn: (_body, { signal }) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"));
          signal.addEventListener("abort", () => controller.error(new DOMException("This operation was aborted", "AbortError")), { once: true });
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    },
  }, {
    body: { model: "gpt-4o", stream: true, input: "hello" },
  });

  assert.equal(result.status, 200);
  assert.match(result.text, /response\.output_text\.delta/);
  assert.match(result.text, /event: error\ndata: \{"type":"error"/);
  assert.match(result.text, /stream_idle_timeout/);
});

test("HTTP native Responses stream emits a valid SSE error after headers", async () => {
  const result = await invokeAdapter({
    streamIdleTimeoutMs: 5,
    responsesFn: (_body, { signal }) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n"));
          signal.addEventListener("abort", () => controller.error(new DOMException("This operation was aborted", "AbortError")), { once: true });
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    },
  }, {
    body: { model: "gpt-5.6-sol", stream: true, input: "hello" },
  });

  assert.equal(result.status, 200);
  assert.match(result.text, /response\.output_text\.delta/);
  assert.match(result.text, /event: error\ndata: \{"type":"error"/);
  assert.match(result.text, /stream_idle_timeout/);
});

test("HTTP native Responses stream stops at a terminal event within the same upstream chunk", async () => {
  const completed = {
    type: "response.completed",
    response: { id: "resp_terminal", status: "completed", output: [] },
  };
  const trailing = {
    type: "response.output_text.delta",
    delta: "must-not-leak",
  };
  const upstreamBody = [
    `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify(trailing)}\n\n`,
  ].join("");

  const result = await invokeAdapter({
    responsesFn: async () => new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  }, {
    body: { model: "gpt-5.6-sol", stream: true, input: "hello" },
  });

  assert.equal(result.status, 200);
  assert.match(result.text, /response\.completed/);
  assert.doesNotMatch(result.text, /must-not-leak/);
  assert.doesNotMatch(result.text, /response\.output_text\.delta/);
});

test("HTTP native Responses stream scans an 8 MiB fragmented event linearly across CRLF boundaries", async () => {
  const maxEventBytes = RUNTIME_DEFAULTS.maxSseBufferBytes;
  const eventPrefix = Buffer.from('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"');
  const eventSuffix = Buffer.from('"}');
  const eventBody = Buffer.concat([
    eventPrefix,
    Buffer.alloc(maxEventBytes - eventPrefix.byteLength - eventSuffix.byteLength, 0x78),
    eventSuffix,
  ]);
  const event = Buffer.concat([eventBody, Buffer.from("\r\n\r\n")]);
  const completed = JSON.stringify({
    type: "response.completed",
    response: { id: "resp_fragmented", status: "completed", output: [] },
  });
  const terminalPrefix = Buffer.from(`event: response.completed\r\ndata: ${completed}\r\n\r`);
  const terminalSuffix = Buffer.from("\nevent: response.output_text.delta\ndata: must-not-leak\n\n");
  const chunks = [];
  for (let offset = 0; offset < event.byteLength; offset += 16 * 1024) {
    chunks.push(event.subarray(offset, Math.min(offset + 16 * 1024, event.byteLength)));
  }
  chunks.push(terminalPrefix, terminalSuffix);
  let chunkIndex = 0;
  const upstreamBody = new ReadableStream({
    pull(controller) {
      if (chunkIndex >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[chunkIndex]);
      chunkIndex += 1;
    },
  }, { highWaterMark: 0 });

  const originalByteLength = Buffer.byteLength;
  let scannedBytes = 0;
  Buffer.byteLength = function trackedByteLength(value, ...args) {
    const bytes = originalByteLength(value, ...args);
    scannedBytes += bytes;
    return bytes;
  };
  let result;
  try {
    result = await invokeAdapter({
      responsesFn: async () => new Response(upstreamBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    }, {
      body: { model: "gpt-5.6-sol", stream: true, input: "hello" },
    });
  } finally {
    Buffer.byteLength = originalByteLength;
  }

  assert.equal(result.status, 200);
  assert.equal(eventBody.byteLength, maxEventBytes);
  assert.ok(scannedBytes < maxEventBytes * 2, `rescanned ${scannedBytes} bytes`);
  assert.match(result.text, /response\.completed/);
  assert.doesNotMatch(result.text, /must-not-leak/);
});

test("HTTP native Responses stream rejects an event above the configured byte limit", async () => {
  const oversized = Buffer.concat([
    Buffer.alloc(RUNTIME_DEFAULTS.maxSseBufferBytes + 1, 0x78),
    Buffer.from("\n\n"),
  ]);
  const result = await invokeAdapter({
    responsesFn: async () => new Response(oversized, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  }, {
    body: { model: "gpt-5.6-sol", stream: true, input: "hello" },
  });

  assert.equal(result.status, 200);
  assert.match(result.text, /SSE buffer exceeds 8388608 bytes/);
  assert.match(result.text, /event: error/);
});

test("HTTP native unary Responses validates a successful envelope before forwarding", async () => {
  for (const upstreamBody of ["not-json", JSON.stringify({ output: [] })]) {
    const result = await invokeAdapter({
      responsesFn: async () => new Response(upstreamBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    }, {
      body: { model: "gpt-5.6-sol", input: "hello" },
    });

    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.text).error.code, "ccdx_invalid_responses_response");
    assert.doesNotMatch(result.text, /not-json/);
  }
});

test("HTTP native unary Responses preserves valid HTTP 200 incomplete and failed resources", async () => {
  for (const status of ["incomplete", "failed"]) {
    const upstream = {
      id: `resp_${status}`,
      object: "response",
      status,
      output: [],
    };
    const result = await invokeAdapter({
      responsesFn: async () => Response.json(upstream),
    }, {
      body: { model: "gpt-5.6-sol", input: "hello" },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.text), upstream);
  }
});

test("HTTP native unary Responses keeps successful bodies above the error-body limit byte-equivalent", async () => {
  const upstreamText = JSON.stringify({
    id: "resp_large_success",
    status: "completed",
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "x".repeat((1024 * 1024) + 1) }],
    }],
  });
  const response = await invokeAdapter({
    responsesFn: async () => new Response(upstreamText, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  }, {
    body: { model: "gpt-5.6-sol", input: "large success" },
  });

  assert.equal(response.status, 200);
  assert.equal(response.text, upstreamText);
});

test("HTTP unary Responses applies separate high success-body budgets to native and Chat routes", async () => {
  const native = await invokeAdapter({
    responsesFn: async () => new Response(JSON.stringify({ id: "resp_native_limit", output: [] }), {
      headers: { "Content-Length": String(MAX_UPSTREAM_RESPONSES_SUCCESS_BODY_BYTES + 1) },
    }),
  }, {
    body: { model: "gpt-5.6-sol", input: "native limit" },
  });
  assert.equal(native.status, 502);
  assert.equal(JSON.parse(native.text).error.code, "ccdx_upstream_response_too_large");

  const chat = await invokeAdapter({
    chatCompletionsFn: async () => new Response(JSON.stringify({ choices: [] }), {
      headers: { "Content-Length": String(MAX_UPSTREAM_CHAT_SUCCESS_BODY_BYTES + 1) },
    }),
  }, {
    body: { model: "gpt-4o", input: "chat limit" },
  });
  assert.equal(chat.status, 502);
  assert.equal(JSON.parse(chat.text).error.code, "ccdx_upstream_response_too_large");
});

test("HTTP native unary Responses cancels an oversized upstream error body", async () => {
  let cancelled = false;
  const response = await invokeAdapter({
    responsesFn: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.alloc((1024 * 1024) + 1, 0x78));
      },
      cancel() { cancelled = true; },
    }), { status: 500 }),
  }, {
    body: { model: "gpt-5.6-sol", input: "oversized error" },
  });

  assert.equal(response.status, 502);
  assert.equal(JSON.parse(response.text).error.code, "ccdx_upstream_response_too_large");
  assert.equal(cancelled, true);
});

test("prepareResponsesRequest: expands previous response history locally", () => {
  clearResponseHistoryForTests();

  const first = prepareResponsesRequest({
    model: "gpt-5.5",
    store: true,
    input: "Remember marker alpha.",
  });
  assert.equal(first.body.store, undefined);
  assert.deepEqual(first.body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Remember marker alpha." }] },
  ]);

  rememberResponseHistory(first, {
    id: "resp_1",
    output: [
      { type: "reasoning", id: "rs_1", encrypted_content: "opaque-reasoning", summary: [] },
      { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "STORED" }] },
      { type: "future_output_item", id: "future_1", state: { opaque: true } },
    ],
  });

  const second = prepareResponsesRequest({
    model: "gpt-5.5",
    previous_response_id: "resp_1",
    store: true,
    input: "What marker?",
  });

  assert.equal(second.body.previous_response_id, undefined);
  assert.equal(second.body.store, undefined);
  assert.deepEqual(second.body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Remember marker alpha." }] },
    { type: "reasoning", id: "rs_1", encrypted_content: "opaque-reasoning", summary: [] },
    { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "STORED" }] },
    { type: "future_output_item", id: "future_1", state: { opaque: true } },
    { type: "message", role: "user", content: [{ type: "input_text", text: "What marker?" }] },
  ]);
});

test("prepareResponsesRequest preserves custom tool call pairing across local history", () => {
  clearResponseHistoryForTests();

  const first = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "Run the custom tool." });
  rememberResponseHistory(first, {
    id: "resp_custom_call",
    status: "completed",
    output: [{
      type: "custom_tool_call",
      id: "custom_call_1",
      call_id: "call_custom_1",
      name: "shell",
      input: "pwd",
    }],
  });

  const second = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    previous_response_id: "resp_custom_call",
    input: [{
      type: "custom_tool_call_output",
      call_id: "call_custom_1",
      output: "/tmp",
    }],
  });

  assert.deepEqual(second.body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Run the custom tool." }] },
    {
      type: "custom_tool_call",
      id: "custom_call_1",
      call_id: "call_custom_1",
      name: "shell",
      input: "pwd",
    },
    { type: "custom_tool_call_output", call_id: "call_custom_1", output: "/tmp" },
  ]);
  clearResponseHistoryForTests();
});

test("prepareResponsesRequest reports the current input start after top-level history images are pruned", () => {
  clearResponseHistoryForTests();

  const historyImages = Array.from({ length: 50 }, (_, index) => ({
    type: "input_image",
    image_url: `data:image/png;base64,aGlzdG9yeS0${index}`,
  }));
  const original = prepareResponsesRequest({ model: "gpt-5.6-sol", input: historyImages });
  rememberResponseHistory(original, { id: "resp_image_boundary", output: [] });

  const prepared = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    previous_response_id: "resp_image_boundary",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,Y3VycmVudA==" }],
    }],
  });

  assert.equal(prepared.body.input.length, 50);
  assert.equal(prepared.currentInputStart, 49);
  assert.equal(prepared.body.input[prepared.currentInputStart].type, "message");
  clearResponseHistoryForTests();
});

test("HTTP compact response stores the upstream canonical output as a new replay root", async () => {
  clearResponseHistoryForTests();

  const original = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "old user context" });
  rememberResponseHistory(original, {
    id: "resp_before_compact",
    output: [{
      type: "message",
      id: "msg_old",
      role: "assistant",
      content: [{ type: "output_text", text: "old assistant context" }],
    }],
  });

  const compactOutput = [
    { type: "reasoning", id: "rs_compact", summary: [{ type: "summary_text", text: "retained summary" }] },
    {
      type: "message",
      id: "msg_retained",
      role: "assistant",
      content: [{ type: "output_text", text: "retained compact context" }],
    },
    { type: "compaction", id: "cmp_1", encrypted_content: "opaque-compact-state" },
  ];
  let compactBody;
  const result = await invokeAdapter({
    responsesCompactFn: async (body) => {
      compactBody = structuredClone(body);
      return new Response(JSON.stringify({
        id: "resp_after_compact",
        object: "response",
        status: "completed",
        output: compactOutput,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  }, {
    url: "/v1/responses/compact",
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_before_compact",
      input: "compact this conversation",
    },
  });

  assert.equal(result.status, 200);
  assert.equal(compactBody.stream, false);
  assert.equal(compactBody.input.filter((item) => item.type === "compaction_trigger").length, 1);
  assert.deepEqual(compactBody.input.at(-1), { type: "compaction_trigger" });
  const response = JSON.parse(result.text);
  assert.equal(response.object, "response.compaction");
  assert.deepEqual(response.output, compactOutput);
  const replay = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    previous_response_id: "resp_after_compact",
    input: "continue from compact",
  }).body.input;
  assert.deepEqual(replay.slice(0, -1), compactOutput);
  assert.equal(replay.at(-1).content[0].text, "continue from compact");
  assert.deepEqual(
    prepareResponsesRequest({
      model: "gpt-5.6-sol",
      previous_response_id: "resp_before_compact",
      input: "continue old branch",
    }).body.input.map((item) => item.id || item.content?.[0]?.text),
    ["old user context", "msg_old", "continue old branch"],
  );
  assert.equal(responseHistoryStats().entries, 2);
  clearResponseHistoryForTests();
});

test("successful compact response without a compaction item fails closed and stores no history", async () => {
  clearResponseHistoryForTests();

  const original = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "old context" });
  rememberResponseHistory(original, { id: "resp_append_root", output: [] });
  const result = await invokeAdapter({
    responsesCompactFn: async () => new Response(JSON.stringify({
      id: "resp_not_compacted",
      status: "completed",
      output: [{
        type: "message",
        id: "msg_no_compaction",
        role: "assistant",
        content: [{ type: "output_text", text: "not compacted" }],
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  }, {
    url: "/v1/responses/compact",
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_append_root",
      input: "compact attempt",
    },
  });

  assert.equal(result.status, 502);
  assert.equal(JSON.parse(result.text).error.code, "ccdx_invalid_compaction_response");
  assert.throws(
    () => prepareResponsesRequest({
      model: "gpt-5.6-sol",
      previous_response_id: "resp_not_compacted",
      input: "next",
    }),
    /previous_response_id is not available/,
  );
  assert.deepEqual(
    prepareResponsesRequest({ model: "gpt-5.6-sol", previous_response_id: "resp_append_root", input: "next" })
      .body.input.map((item) => item.content?.[0]?.text),
    ["old context", "next"],
  );
  clearResponseHistoryForTests();
});

test("HTTP 200 non-completed compact responses fail closed and cannot replace existing history", async () => {
  for (const responseStatus of ["failed", "incomplete"]) {
    clearResponseHistoryForTests();
    const rootId = `resp_${responseStatus}_compact_root`;
    const compactId = `resp_${responseStatus}_compact`;
    const original = prepareResponsesRequest({ model: "gpt-5.6-sol", input: `${responseStatus} preserved context` });
    rememberResponseHistory(original, { id: rootId, status: "completed", output: [] });

    const result = await invokeAdapter({
      responsesCompactFn: async () => new Response(JSON.stringify({
        id: compactId,
        object: "response.compaction",
        status: responseStatus,
        output: [{ type: "compaction", id: `cmp_${responseStatus}`, encrypted_content: "partial-state" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    }, {
      url: "/v1/responses/compact",
      body: {
        model: "gpt-5.6-sol",
        previous_response_id: rootId,
        input: `${responseStatus} compact attempt`,
      },
    });

    assert.equal(result.status, 502);
    assert.throws(
      () => prepareResponsesRequest({
        model: "gpt-5.6-sol",
        previous_response_id: compactId,
        input: "continue",
      }),
      /previous_response_id is not available/,
    );
    assert.deepEqual(
      prepareResponsesRequest({ model: "gpt-5.6-sol", previous_response_id: rootId, input: "continue" })
        .body.input.map((item) => item.content?.[0]?.text),
      [`${responseStatus} preserved context`, "continue"],
    );
  }
  clearResponseHistoryForTests();
});

test("failed compact response cannot replace existing history", async () => {
  clearResponseHistoryForTests();

  const original = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "preserved context" });
  rememberResponseHistory(original, { id: "resp_failed_compact_root", output: [] });
  const result = await invokeAdapter({
    responsesCompactFn: async () => new Response(JSON.stringify({
      id: "resp_failed_compact",
      status: "failed",
      output: [{ type: "compaction", id: "cmp_failed", encrypted_content: "must-not-store" }],
    }), { status: 500, headers: { "Content-Type": "application/json" } }),
  }, {
    url: "/v1/responses/compact",
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_failed_compact_root",
      input: "failed compact attempt",
    },
  });

  assert.equal(result.status, 500);
  assert.throws(
    () => prepareResponsesRequest({
      model: "gpt-5.6-sol",
      previous_response_id: "resp_failed_compact",
      input: "must be unavailable",
    }),
    /previous_response_id is not available/,
  );
  assert.deepEqual(
    prepareResponsesRequest({
      model: "gpt-5.6-sol",
      previous_response_id: "resp_failed_compact_root",
      input: "old branch still works",
    }).body.input.map((item) => item.content?.[0]?.text),
    ["preserved context", "old branch still works"],
  );
  clearResponseHistoryForTests();
});

test("compact snapshots use the sanitized body that actually succeeded upstream", async () => {
  let attempts = 0;
  let successfulBody;
  const result = await invokeAdapter({
    responsesCompactFn: async (body) => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({
          error: { message: "Encrypted content could not be verified because it could not be decrypted" },
        }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      successfulBody = structuredClone(body);
      return new Response(JSON.stringify({
        id: "resp_sanitized_compact",
        status: "completed",
        output: [{ type: "compaction", id: "cmp_sanitized", encrypted_content: "fresh-state" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  }, {
    url: "/v1/responses/compact",
    body: {
      model: "gpt-5.6-sol",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "keep me", encrypted_content: "stale-secret" }],
      }],
    },
  });

  assert.equal(result.status, 200);
  assert.equal(attempts, 2);
  assert.equal(Object.hasOwn(successfulBody.input[0].content[0], "encrypted_content"), false);
  const response = JSON.parse(result.text);
  assert.deepEqual(response.output, [
    { type: "compaction", id: "cmp_sanitized", encrypted_content: "fresh-state" },
  ]);
});

test("compact route forces a requested stream into unary mode and stores the valid snapshot", async () => {
  clearResponseHistoryForTests();

  const original = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "stream old context" });
  rememberResponseHistory(original, { id: "resp_stream_root", output: [] });
  const compactOutput = [
    {
      type: "message",
      id: "msg_stream_retained",
      role: "assistant",
      content: [{ type: "output_text", text: "stream retained context" }],
    },
    { type: "compaction", id: "cmp_stream", encrypted_content: "opaque-stream-state" },
  ];
  let compactBody;
  const result = await invokeAdapter({
    responsesCompactFn: async (body) => {
      compactBody = body;
      return new Response(JSON.stringify({
        id: "resp_stream_compacted",
        object: "response",
        status: "completed",
        output: compactOutput,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  }, {
    url: "/v1/responses/compact",
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_stream_root",
      input: "stream compact attempt",
      stream: true,
    },
  });

  assert.equal(result.status, 200);
  assert.equal(compactBody.stream, false);
  assert.deepEqual(compactBody.input.at(-1), { type: "compaction_trigger" });
  assert.equal(JSON.parse(result.text).object, "response.compaction");
  const replay = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    previous_response_id: "resp_stream_compacted",
    input: "stream next",
  }).body.input;
  assert.deepEqual(replay.map((item) => item.type), ["message", "compaction", "message"]);
  assert.deepEqual(replay.slice(0, 2), compactOutput);
  assert.equal(replay.at(-1).content[0].text, "stream next");
  clearResponseHistoryForTests();
});

test("compact snapshot remains available when normal LRU eviction removes its older branch", async () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 1_000_000, maxEntries: 3 });

  const root = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "old root" });
  rememberResponseHistory(root, { id: "resp_lru_old_root", status: "completed", output: [] });
  const child = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    previous_response_id: "resp_lru_old_root",
    input: "old child",
  });
  rememberResponseHistory(child, { id: "resp_lru_old_child", status: "completed", output: [] });

  const result = await invokeAdapter({
    responsesCompactFn: async () => new Response(JSON.stringify({
      id: "resp_lru_compact",
      status: "completed",
      output: [{ type: "compaction", id: "cmp_lru", encrypted_content: "compact-state" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  }, {
    url: "/v1/responses/compact",
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_lru_old_child",
      input: "compact old branch",
    },
  });
  assert.equal(result.status, 200);
  assert.equal(responseHistoryStats().entries, 3);

  rememberResponseHistory(
    prepareResponsesRequest({ model: "gpt-5.6-sol", input: "new independent root" }),
    { id: "resp_lru_new_root", status: "completed", output: [] },
  );

  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.6-sol", previous_response_id: "resp_lru_old_child", input: "evicted" }),
    /was evicted after reaching the local history limit/,
  );
  const replay = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    previous_response_id: "resp_lru_compact",
    input: "continue compact",
  }).body.input;
  assert.deepEqual(replay.map((item) => item.type), ["compaction", "message"]);
  assert.deepEqual(replay[0], { type: "compaction", id: "cmp_lru", encrypted_content: "compact-state" });
  clearResponseHistoryForTests();
});

test("compact can replace a full pinned history pool with its replayable new root", async () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 1024 * 1024, maxEntries: 1 });
  try {
    const root = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "old root" });
    rememberResponseHistory(root, { id: "resp_compact_full_root", status: "completed", output: [] });

    const compact = await invokeAdapter({
      responsesCompactFn: async () => Response.json({
        id: "resp_compact_full_new",
        object: "response.compaction",
        status: "completed",
        output: [{ type: "compaction", id: "cmp_full", encrypted_content: "compact-state" }],
      }),
    }, {
      url: "/v1/responses/compact",
      body: {
        model: "gpt-5.6-sol",
        previous_response_id: "resp_compact_full_root",
        input: "compact",
      },
    });
    assert.equal(compact.status, 200);
    assert.equal(responseHistoryStats().entries, 1);

    const replay = await invokeAdapter({
      responsesFn: async () => Response.json({ id: "resp_compact_full_replay", status: "completed", output: [] }),
    }, {
      body: {
        model: "gpt-5.6-sol",
        previous_response_id: "resp_compact_full_new",
        input: "continue",
      },
    });
    assert.equal(replay.status, 200);
  } finally {
    clearResponseHistoryForTests();
  }
});

test("response history stores incremental nodes and enforces a byte budget", () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 500, maxEntries: 100 });

  const first = prepareResponsesRequest({ model: "gpt-5.5", input: "a".repeat(300) });
  rememberResponseHistory(first, {
    id: "resp_large",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "b".repeat(300) }] }],
  });

  assert.equal(responseHistoryStats().entries, 0);
  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "resp_large", input: "next" }),
    /was evicted after reaching the local history limit/,
  );
  clearResponseHistoryForTests();
});

test("oversized history entries do not evict unrelated conversations", () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 500, maxEntries: 100 });

  const small = prepareResponsesRequest({ model: "gpt-5.5", input: "small" });
  rememberResponseHistory(small, { id: "resp_small", output: [] });
  const large = prepareResponsesRequest({ model: "gpt-5.5", input: "x".repeat(600) });
  rememberResponseHistory(large, { id: "resp_large", output: [] });

  assert.equal(responseHistoryStats().entries, 1);
  assert.equal(
    prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "resp_small", input: "next" }).body.input.length,
    2,
  );
  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "resp_large", input: "next" }),
    /was evicted after reaching the local history limit/,
  );
  clearResponseHistoryForTests();
});

test("response history byte accounting matches serialized JSON", () => {
  clearResponseHistoryForTests();
  const prepared = prepareResponsesRequest({ model: "gpt-5.5", input: `quote=\" slash=\\ newline=\n unicode=é😀 lone=\ud800` });
  const output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }];
  rememberResponseHistory(prepared, { id: "resp_bytes", output });

  assert.equal(
    responseHistoryStats().bytes,
    Buffer.byteLength(JSON.stringify([prepared.historyInputItems, output])),
  );
  clearResponseHistoryForTests();
});

test("response history grows linearly across chained turns", () => {
  clearResponseHistoryForTests();
  let previousId = null;
  for (let i = 0; i < 20; i += 1) {
    const prepared = prepareResponsesRequest({
      model: "gpt-5.5",
      ...(previousId ? { previous_response_id: previousId } : {}),
      input: `turn-${i}`,
    });
    previousId = `resp_${i}`;
    rememberResponseHistory(prepared, {
      id: previousId,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `answer-${i}` }] }],
    });
  }

  const stats = responseHistoryStats();
  assert.equal(stats.entries, 20);
  assert.ok(stats.bytes < 20_000);
  const final = prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: previousId, input: "final" });
  assert.equal(final.body.input.length, 41);
  clearResponseHistoryForTests();
});

test("response history eviction removes descendants without affecting other roots", () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 1_000_000, maxEntries: 3 });

  const root = prepareResponsesRequest({ model: "gpt-5.5", input: "root" });
  rememberResponseHistory(root, { id: "resp_root", output: [] });
  const child = prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "resp_root", input: "child" });
  rememberResponseHistory(child, { id: "resp_child", output: [] });
  rememberResponseHistory(prepareResponsesRequest({ model: "gpt-5.5", input: "other" }), { id: "resp_other", output: [] });
  rememberResponseHistory(prepareResponsesRequest({ model: "gpt-5.5", input: "newer" }), { id: "resp_newer", output: [] });

  assert.equal(responseHistoryStats().entries, 2);
  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "resp_child", input: "next" }),
    /was evicted after reaching the local history limit/,
  );
  assert.equal(
    prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "resp_other", input: "next" }).body.input.length,
    2,
  );
  clearResponseHistoryForTests();
});

test("response history tree LRU preserves active image history for compaction", async () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 1_000_000, maxEntries: 4 });
  const imageUrl = "data:image/png;base64,aW1hZ2U=";

  const activeRoot = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: imageUrl }],
    }],
  });
  rememberResponseHistory(activeRoot, { id: "resp_active_root", output: [] });
  rememberResponseHistory(
    prepareResponsesRequest({ model: "gpt-5.6-sol", input: "idle" }),
    { id: "resp_idle", output: [] },
  );
  const activeChild = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    previous_response_id: "resp_active_root",
    input: "continue",
  });
  rememberResponseHistory(activeChild, { id: "resp_active_child", output: [] });
  rememberResponseHistory(
    prepareResponsesRequest({ model: "gpt-5.6-sol", input: "newer-a" }),
    { id: "resp_newer_a", output: [] },
  );
  rememberResponseHistory(
    prepareResponsesRequest({ model: "gpt-5.6-sol", input: "newer-b" }),
    { id: "resp_newer_b", output: [] },
  );

  let compactBody;
  const result = await invokeAdapter({
    responsesCompactFn: async (body) => {
      compactBody = body;
      return new Response(JSON.stringify({
        id: "resp_compacted",
        status: "completed",
        output: [{ type: "compaction", id: "cmp_image", encrypted_content: "image-state" }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  }, {
    url: "/v1/responses/compact",
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_active_child",
      input: "compact",
    },
  });

  assert.equal(result.status, 200);
  assert.equal(compactBody.input[0].content[0].image_url, imageUrl);
  assert.deepEqual(compactBody.input.at(-1), { type: "compaction_trigger" });
  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.6-sol", previous_response_id: "resp_idle", input: "next" }),
    /was evicted after reaching the local history limit/,
  );
  clearResponseHistoryForTests();
});

test("response history tree LRU treats successful materialization as recent use", () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 1_000_000, maxEntries: 2 });

  rememberResponseHistory(
    prepareResponsesRequest({ model: "gpt-5.6-sol", input: "active" }),
    { id: "resp_active", output: [] },
  );
  rememberResponseHistory(
    prepareResponsesRequest({ model: "gpt-5.6-sol", input: "idle" }),
    { id: "resp_idle", output: [] },
  );
  prepareResponsesRequest({ model: "gpt-5.6-sol", previous_response_id: "resp_active", input: "retry" });
  rememberResponseHistory(
    prepareResponsesRequest({ model: "gpt-5.6-sol", input: "new" }),
    { id: "resp_new", output: [] },
  );

  assert.equal(
    prepareResponsesRequest({ model: "gpt-5.6-sol", previous_response_id: "resp_active", input: "next" }).body.input.length,
    2,
  );
  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.6-sol", previous_response_id: "resp_idle", input: "next" }),
    /was evicted after reaching the local history limit/,
  );
  clearResponseHistoryForTests();
});

test("response history tree LRU keeps hard limits for a single oversized tree", () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 1_000_000, maxEntries: 2 });

  let previousId = null;
  for (let index = 0; index < 3; index += 1) {
    const prepared = prepareResponsesRequest({
      model: "gpt-5.6-sol",
      ...(previousId ? { previous_response_id: previousId } : {}),
      input: `turn-${index}`,
    });
    previousId = `resp_hard_limit_${index}`;
    rememberResponseHistory(prepared, { id: previousId, output: [] });
  }

  assert.equal(responseHistoryStats().entries, 0);
  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.6-sol", previous_response_id: previousId, input: "next" }),
    /was evicted after reaching the local history limit/,
  );
  clearResponseHistoryForTests();
});

test("HTTP response history remains replayable when unrelated roots arrive during admission", async () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 1024 * 1024, maxEntries: 2 });
  try {
    const rootContext = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "root input" });
    rememberResponseHistory(rootContext, {
      id: "resp_admission_pinned_root",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "root output" }] }],
    });

    let injected = false;
    const acquireRequest = async () => {
      const release = () => {};
      release.reserveResponseHistory = async () => {
        if (injected) return () => {};
        injected = true;
        for (const id of ["resp_unrelated_a", "resp_unrelated_b"]) {
          const context = prepareResponsesRequest({ model: "gpt-5.6-sol", input: id });
          rememberResponseHistory(context, { id, status: "completed", output: [] });
        }
        return () => {};
      };
      return release;
    };

    const child = await invokeAdapter({
      acquireRequest,
      responsesFn: async () => Response.json({
        id: "resp_admission_pinned_child",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "child output" }] }],
      }),
    }, {
      body: {
        model: "gpt-5.6-sol",
        previous_response_id: "resp_admission_pinned_root",
        input: "child input",
      },
    });
    assert.equal(child.status, 200);

    let replayBody;
    const replay = await invokeAdapter({
      acquireRequest,
      responsesFn: async (body) => {
        replayBody = structuredClone(body);
        return Response.json({ id: "resp_admission_replayed", status: "completed", output: [] });
      },
    }, {
      body: {
        model: "gpt-5.6-sol",
        previous_response_id: "resp_admission_pinned_child",
        input: "continue",
      },
    });

    assert.equal(replay.status, 200);
    const serialized = JSON.stringify(replayBody);
    assert.equal(serialized.includes("root output"), true);
    assert.equal(serialized.includes("child output"), true);
    assert.equal(serialized.includes("continue"), true);
  } finally {
    clearResponseHistoryForTests();
  }
});

test("prepareResponsesRequest: rejects missing local previous response history", () => {
  clearResponseHistoryForTests();

  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "missing", input: "hello" }),
    /previous_response_id is not available/,
  );
});

test("prepareResponsesRequest: drops unsupported image generation tools", () => {
  const prepared = prepareResponsesRequest({
    model: "gpt-5.5",
    input: "hello",
    tools: [
      { type: "image_generation" },
      { type: "function", name: "lookup" },
    ],
  });

  assert.deepEqual(prepared.body.tools, [{ type: "function", name: "lookup" }]);

  const onlyUnsupported = prepareResponsesRequest({
    model: "gpt-5.5",
    input: "hello",
    tools: [{ type: "image_generation" }],
  });
  assert.equal(onlyUnsupported.body.tools, undefined);

  const similarlyNamedFunction = prepareResponsesRequest({
    model: "gpt-5.5",
    input: "hello",
    tools: [{ type: "function", name: "image_generation_status", parameters: { type: "object" } }],
  });
  assert.deepEqual(similarlyNamedFunction.body.tools, [
    { type: "function", name: "image_generation_status", parameters: { type: "object" } },
  ]);

  const forcedUnsupported = prepareResponsesRequest({
    model: "gpt-5.5",
    input: "hello",
    tools: [
      { type: "image_generation" },
      { type: "function", name: "lookup" },
    ],
    tool_choice: { type: "image_generation" },
  });
  assert.deepEqual(forcedUnsupported.body.tools, [{ type: "function", name: "lookup" }]);
  assert.equal(forcedUnsupported.body.tool_choice, undefined);

  const requiredWithoutTools = prepareResponsesRequest({
    model: "gpt-5.5",
    input: "hello",
    tools: [{ type: "image_generation" }],
    tool_choice: "required",
  });
  assert.equal(requiredWithoutTools.body.tools, undefined);
  assert.equal(requiredWithoutTools.body.tool_choice, undefined);

  const requiredWithSurvivingTool = prepareResponsesRequest({
    model: "gpt-5.5",
    input: "hello",
    tools: [
      { type: "image_generation" },
      { type: "function", name: "lookup" },
    ],
    tool_choice: "required",
  });
  assert.equal(requiredWithSurvivingTool.body.tool_choice, "required");
});

test("responsesToChat: preserves flat Responses function tools", () => {
  const converted = responsesToChat({
    model: "gpt-4o",
    input: "hello",
    tools: [{
      type: "function",
      name: "lookup",
      description: "Look something up",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      strict: true,
    }],
  });

  assert.deepEqual(converted.tools, [{
    type: "function",
    function: {
      name: "lookup",
      description: "Look something up",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      strict: true,
    },
  }]);
});

test("responsesToChat: preserves image detail and unsupported content as text", () => {
  const converted = responsesToChat({
    model: "gpt-4o",
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "inspect" },
        { type: "input_image", image_url: "data:image/png;base64,YQ==", detail: "high" },
        { type: "input_file", filename: "note.txt", file_data: "data:text/plain;base64,YQ==" },
      ],
    }],
  });

  assert.deepEqual(converted.messages[0].content, [
    { type: "text", text: "inspect" },
    { type: "image_url", image_url: { url: "data:image/png;base64,YQ==", detail: "high" } },
    { type: "text", text: JSON.stringify({ type: "input_file", filename: "note.txt", file_data: "data:text/plain;base64,YQ==" }) },
  ]);
});

test("responsesToChat: preserves top-level and Anthropic base64 images as user image messages", () => {
  const converted = responsesToChat({
    model: "gpt-4o",
    input: [
      { type: "input_image", image_url: "data:image/png;base64,YQ==", detail: "high" },
      { type: "image_url", image_url: { url: "https://example.test/image.webp", detail: "low" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "Yg==" } },
    ],
  });

  assert.deepEqual(converted.messages, [
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,YQ==", detail: "high" } }] },
    { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/image.webp", detail: "low" } }] },
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,Yg==" } }] },
  ]);
});

test("prepareResponsesChatPayload fast-path serializes a 20MiB text Chat body only once", async () => {
  const largeText = "x".repeat(20 * 1024 * 1024);
  const body = {
    model: "gpt-4o",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: largeText }] }],
  };
  const originalStringify = JSON.stringify;
  let largeChatSerializations = 0;
  let responsesSerializations = 0;
  JSON.stringify = function countedStringify(value, ...args) {
    if (value?.messages?.[0]?.content === largeText) largeChatSerializations += 1;
    if (value?.input === body.input) responsesSerializations += 1;
    return originalStringify.call(this, value, ...args);
  };

  let payload;
  try {
    payload = await prepareResponsesChatPayload({ body, currentInputStart: 0 }, {
      payloadOptions: { maxBytes: 30 * 1024 * 1024 },
      stream: false,
    });
  } finally {
    JSON.stringify = originalStringify;
  }

  assert.equal(largeChatSerializations, 1);
  assert.equal(responsesSerializations, 0);
  assert.equal(payload.bodyText, originalStringify(payload.chatReq));
});

test("prepareResponsesChatPayload keeps trimming positive-saving history until the final Chat body fits", async () => {
  const historyImage = (digit) => ({
    type: "input_image",
    image_url: `data:image/png;base64,${String(digit).repeat(2000)}`,
  });
  const body = {
    model: "gpt-4o",
    input: [
      historyImage(1),
      historyImage(2),
      historyImage(3),
      { type: "function_call_output", call_id: "call_large", output: "x".repeat(2000) },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
  };

  const payload = await prepareResponsesChatPayload({ body, currentInputStart: 4 }, {
    payloadOptions: {
      maxBytes: 550,
      profiles: [],
      optimizeImage: async (dataUrl) => dataUrl,
    },
    stream: false,
  });

  assert.equal(payload.bodyBytes, Buffer.byteLength(payload.bodyText));
  assert.ok(payload.bodyBytes <= 550);
  assert.equal(body.input[4].content[0].text, "continue");
  assert.ok(body.input.slice(0, 3).every((item) => item.type === "message"));
  assert.match(body.input[3].output, /earlier tool output omitted/);
});

test("HTTP responses route preserves 0.4.23 image_gen compatibility", async () => {
  let upstreamBody;
  const response = await invokeAdapter({
    responsesFn: async (body) => {
      upstreamBody = body;
      return new Response(JSON.stringify({ id: "resp_img", status: "completed", output: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  }, {
    body: {
      model: "gpt-5.6-sol",
      input: "hello",
      tools: [
        { type: "image_generation", namespace: "image_gen" },
        { type: "function", name: "lookup", parameters: { type: "object" } },
      ],
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(upstreamBody.tools, [
    { type: "function", name: "lookup", parameters: { type: "object" } },
  ]);
});

test("HTTP responses route retries large visual history in recovery mode without replaying the timed-out POST", async () => {
  clearResponseHistoryForTests();
  const history = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    input: Array.from({ length: 36 }, (_, index) => ({
      type: "message",
      role: "user",
      content: [{
        type: "input_image",
        image_url: `data:image/png;base64,${Buffer.alloc(128, index + 1).toString("base64")}`,
      }],
    })),
  });
  rememberResponseHistory(history, { id: "resp_visual_root", status: "completed", output: [] });

  const imagePressure = createResponsesImagePressureController();
  const upstreamImageCounts = [];
  let upstreamCalls = 0;
  const responsesFn = async (body, { currentInputStart, onUpstreamStart, signal }) => {
    upstreamCalls += 1;
    upstreamImageCounts.push(responsesHistoricalImageStats(body.input, currentInputStart).historicalImages);
    onUpstreamStart();
    if (upstreamCalls === 1) {
      await new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    }
    const event = {
      type: "response.completed",
      response: {
        id: `resp_visual_${upstreamCalls}`,
        object: "response",
        status: "completed",
        model: body.model,
        output: [],
      },
    };
    return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  const options = {
    imagePressure,
    responsesFn,
    streamHandshakeTimeoutMs: 5,
    streamIdleTimeoutMs: 1000,
    upstreamTimeoutMs: 1000,
  };

  const first = await invokeAdapter(options, {
    body: {
      model: "gpt-5.6-sol",
      stream: true,
      previous_response_id: "resp_visual_root",
      input: "continue",
    },
  });
  assert.equal(first.status, 504);
  assert.equal(JSON.parse(first.text).error.code, "ccdx_visual_history_timeout");
  assert.equal(upstreamCalls, 1);
  assert.deepEqual(upstreamImageCounts, [16]);

  const second = await invokeAdapter(options, {
    body: {
      model: "gpt-5.6-sol",
      stream: true,
      previous_response_id: "resp_visual_root",
      input: "continue",
    },
  });
  assert.equal(second.status, 200);
  assert.equal(upstreamCalls, 2);
  assert.deepEqual(upstreamImageCounts, [16, 8]);
  assert.equal(imagePressure.snapshot().active_recovery_trees, 1);
  clearResponseHistoryForTests();
});

test("HTTP Responses activates stricter visual-history recovery after an upstream 408", async () => {
  clearResponseHistoryForTests();
  const history = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    input: Array.from({ length: 36 }, (_, index) => ({
      type: "message",
      role: "user",
      content: [{
        type: "input_image",
        image_url: `data:image/png;base64,${Buffer.alloc(128, index + 1).toString("base64")}`,
      }],
    })),
  });
  rememberResponseHistory(history, { id: "resp_http_408_root", status: "completed", output: [] });

  const imagePressure = createResponsesImagePressureController();
  const upstreamImageCounts = [];
  let upstreamCalls = 0;
  const responsesFn = async (body, { currentInputStart, onUpstreamStart }) => {
    upstreamCalls += 1;
    upstreamImageCounts.push(responsesHistoricalImageStats(body.input, currentInputStart).historicalImages);
    onUpstreamStart();
    if (upstreamCalls === 1) {
      return Response.json({ error: { message: "request timed out" } }, { status: 408 });
    }
    return Response.json({
      id: "resp_http_408_recovered",
      object: "response",
      status: "completed",
      model: body.model,
      output: [],
    });
  };
  const options = { imagePressure, responsesFn };

  const first = await invokeAdapter(options, {
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_http_408_root",
      input: "continue",
    },
  });
  assert.equal(first.status, 408);
  assert.deepEqual(upstreamImageCounts, [16]);
  assert.equal(imagePressure.snapshot().active_recovery_trees, 1);

  const second = await invokeAdapter(options, {
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_http_408_root",
      input: "continue",
    },
  });
  assert.equal(second.status, 200);
  assert.equal(upstreamCalls, 2);
  assert.deepEqual(upstreamImageCounts, [16, 8]);
  clearResponseHistoryForTests();
});

test("successful compaction clears visual-history recovery for the compacted tree", async () => {
  clearResponseHistoryForTests();
  const history = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "before compaction" });
  rememberResponseHistory(history, { id: "resp_pressure_compact_root", status: "completed", output: [] });
  const imagePressure = createResponsesImagePressureController();
  imagePressure.markTimeout("resp_pressure_compact_root", { eligible: true });

  const result = await invokeAdapter({
    imagePressure,
    responsesCompactFn: async (_body, { onUpstreamStart }) => {
      onUpstreamStart();
      return Response.json({
        id: "resp_pressure_compacted",
        object: "response.compaction",
        status: "completed",
        output: [{ type: "compaction", id: "cmp_pressure", encrypted_content: "state" }],
      });
    },
  }, {
    url: "/v1/responses/compact",
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_pressure_compact_root",
      input: "compact",
    },
  });

  assert.equal(result.status, 200);
  assert.equal(imagePressure.snapshot().active_recovery_trees, 0);
  clearResponseHistoryForTests();
});

test("compact preserves its first visual request and applies recovery only after timeout", async () => {
  clearResponseHistoryForTests();
  try {
    const history = prepareResponsesRequest({
      model: "gpt-5.6-sol",
      input: Array.from({ length: 36 }, (_, index) => ({
        type: "message",
        role: "user",
        content: [{
          type: "input_image",
          image_url: `data:image/png;base64,${Buffer.alloc(128, index + 1).toString("base64")}`,
        }],
      })),
    });
    rememberResponseHistory(history, { id: "resp_compact_pressure_root", status: "completed", output: [] });
    const imagePressure = createResponsesImagePressureController();
    const historicalCounts = [];
    let upstreamCalls = 0;
    const responsesCompactFn = async (body, { currentInputStart, onUpstreamStart, signal }) => {
      upstreamCalls += 1;
      historicalCounts.push(responsesHistoricalImageStats(body.input, currentInputStart).historicalImages);
      onUpstreamStart();
      if (upstreamCalls === 1) {
        await new Promise((resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      }
      return Response.json({
        id: "resp_compact_pressure_recovered",
        object: "response.compaction",
        status: "completed",
        output: [{ type: "compaction", id: "cmp_pressure_recovered", encrypted_content: "state" }],
      });
    };
    const options = {
      imagePressure,
      responsesCompactFn,
      upstreamTimeoutMs: 5,
    };
    const request = {
      url: "/v1/responses/compact",
      body: {
        model: "gpt-5.6-sol",
        previous_response_id: "resp_compact_pressure_root",
        input: "compact",
      },
    };

    const first = await invokeAdapter(options, request);
    assert.equal(first.status, 504);
    assert.equal(upstreamCalls, 1);
    assert.equal(imagePressure.snapshot().active_recovery_trees, 1);

    const second = await invokeAdapter({ ...options, upstreamTimeoutMs: 1000 }, request);
    assert.equal(second.status, 200);
    assert.deepEqual(historicalCounts, [36, 8]);
    assert.equal(imagePressure.snapshot().active_recovery_trees, 0);
  } finally {
    clearResponseHistoryForTests();
  }
});

test("compact preserves an upstream 408 and applies visual recovery on the next request", async () => {
  clearResponseHistoryForTests();
  try {
    const history = prepareResponsesRequest({
      model: "gpt-5.6-sol",
      input: Array.from({ length: 36 }, (_, index) => ({
        type: "message",
        role: "user",
        content: [{
          type: "input_image",
          image_url: `data:image/png;base64,${Buffer.alloc(128, index + 1).toString("base64")}`,
        }],
      })),
    });
    rememberResponseHistory(history, { id: "resp_compact_408_root", status: "completed", output: [] });
    const imagePressure = createResponsesImagePressureController();
    const historicalCounts = [];
    let upstreamCalls = 0;
    const responsesCompactFn = async (body, { currentInputStart }) => {
      upstreamCalls += 1;
      historicalCounts.push(responsesHistoricalImageStats(body.input, currentInputStart).historicalImages);
      if (upstreamCalls === 1) {
        return new Response(JSON.stringify({ error: { code: "user_request_timeout" } }), {
          status: 408,
          headers: { "Content-Type": "application/json" },
        });
      }
      return Response.json({
        id: "resp_compact_408_recovered",
        object: "response.compaction",
        status: "completed",
        output: [{ type: "compaction", id: "cmp_408_recovered", encrypted_content: "state" }],
      });
    };
    const options = { imagePressure, responsesCompactFn };
    const request = {
      url: "/v1/responses/compact",
      body: {
        model: "gpt-5.6-sol",
        previous_response_id: "resp_compact_408_root",
        input: "compact",
      },
    };

    const first = await invokeAdapter(options, request);
    assert.equal(first.status, 408);
    assert.deepEqual(JSON.parse(first.text), { error: { code: "user_request_timeout" } });
    assert.equal(imagePressure.snapshot().active_recovery_trees, 1);

    const second = await invokeAdapter(options, request);
    assert.equal(second.status, 200);
    assert.deepEqual(historicalCounts, [36, 8]);
  } finally {
    clearResponseHistoryForTests();
  }
});

test("HTTP responses route maps Codex auto-review directly to Responses", async () => {
  let upstreamBody;
  let chatCalled = false;
  const response = await invokeAdapter({
    openAIModelEnv: {},
    responsesFn: async (body) => {
      upstreamBody = body;
      return new Response(JSON.stringify({ id: "resp_review", status: "completed", output: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    chatCompletionsFn: async () => {
      chatCalled = true;
      throw new Error("auto-review must not use Chat Completions");
    },
  }, {
    body: {
      model: "codex-auto-review",
      input: "Review this command",
      tools: [{ type: "function", name: "approve", parameters: { type: "object" } }],
      text: {
        format: {
          type: "json_schema",
          name: "review",
          schema: { type: "object", properties: { approved: { type: "boolean" } } },
        },
      },
    },
  });

  assert.equal(response.status, 200);
  assert.equal(chatCalled, false);
  assert.equal(upstreamBody.model, "gpt-5.5");
  assert.deepEqual(upstreamBody.tools, [
    { type: "function", name: "approve", parameters: { type: "object" } },
  ]);
  assert.equal(upstreamBody.text.format.name, "review");
});

test("HTTP Responses maps Codex App priority tier to a catalog-approved fast model for JSON and SSE", async () => {
  const codexModelRegistry = { models: { data: [{
    id: "gpt-5.6-sol-fast",
    vendor: "OpenAI",
    policy: { state: "enabled" },
    model_picker_enabled: true,
    supported_endpoints: ["/responses", "ws:/responses"],
  }] } };

  for (const stream of [false, true]) {
    let upstreamBody;
    const response = await invokeAdapter({
      codexModelRegistry,
      responsesFn: async (body) => {
        upstreamBody = structuredClone(body);
        const completed = {
          id: `resp_fast_${stream}`,
          object: "response",
          status: "completed",
          model: "gpt-5.6-sol",
          output: [],
        };
        if (!stream) return Response.json(completed);
        const event = { type: "response.completed", response: completed };
        return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    }, {
      body: { model: "gpt-5.6-sol", service_tier: "priority", stream, input: "hello" },
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamBody.model, "gpt-5.6-sol-fast");
    assert.equal(Object.hasOwn(upstreamBody, "service_tier"), false);
  }
});

test("HTTP Responses preserves service tiers when a fast mapping is not explicitly eligible", async () => {
  for (const { serviceTier, modelRegistry } of [
    { serviceTier: "default", modelRegistry: { models: { data: [] } } },
    { serviceTier: "ultrafast", modelRegistry: { models: { data: [] } } },
    { serviceTier: "priority", modelRegistry: { models: { data: [] } } },
  ]) {
    let upstreamBody;
    const response = await invokeAdapter({
      codexModelRegistry: modelRegistry,
      responsesFn: async (body) => {
        upstreamBody = structuredClone(body);
        return Response.json({ id: `resp_${serviceTier}`, status: "completed", output: [] });
      },
    }, {
      body: { model: "gpt-5.6-sol", service_tier: serviceTier, input: "hello" },
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamBody.model, "gpt-5.6-sol");
    assert.equal(upstreamBody.service_tier, serviceTier);
  }
});

test("GPT-6 drops unsupported inherited priority tiers without changing other requests", async () => {
  for (const { compact, stream } of [
    { compact: false, stream: false },
    { compact: false, stream: true },
    { compact: true, stream: false },
  ]) {
    let upstreamBody;
    const upstream = async (body) => {
      upstreamBody = structuredClone(body);
      if (compact) {
        return Response.json({
          id: "resp_gpt6_compact",
          object: "response.compaction",
          status: "completed",
          output: [{ type: "compaction", id: "cmp_gpt6", encrypted_content: "gpt6-state" }],
        });
      }
      const completed = { id: "resp_gpt6", object: "response", status: "completed", output: [] };
      if (!stream) return Response.json(completed);
      return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    const response = await invokeAdapter({
      getCachedModelEndpointsFn: () => ["/responses"],
      ...(compact ? { responsesCompactFn: upstream } : { responsesFn: upstream }),
    }, {
      url: compact ? "/v1/responses/compact" : "/v1/responses",
      body: { model: "gpt-6-astra", service_tier: "priority", stream, input: "hello" },
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamBody.model, "gpt-6-astra");
    assert.equal(Object.hasOwn(upstreamBody, "service_tier"), false);
  }

  let defaultTierBody;
  await invokeAdapter({
    getCachedModelEndpointsFn: () => ["/responses"],
    responsesFn: async (body) => {
      defaultTierBody = structuredClone(body);
      return Response.json({ id: "resp_gpt6_default", status: "completed", output: [] });
    },
  }, {
    body: { model: "gpt-6-astra", service_tier: "default", input: "hello" },
  });
  assert.equal(defaultTierBody.service_tier, "default");
});

test("direct fast requests are not rewritten by the priority-tier resolver", async () => {
  const eligibleRegistry = { models: { data: [{
    id: "gpt-5.6-sol-fast",
    vendor: "OpenAI",
    policy: { state: "enabled" },
    model_picker_enabled: true,
    supported_endpoints: ["/responses", "ws:/responses"],
  }] } };
  let upstreamBody;
  const response = await invokeAdapter({
    codexModelRegistry: eligibleRegistry,
    getCachedModelEndpointsFn: () => ["/responses"],
    responsesFn: async (body) => {
      upstreamBody = structuredClone(body);
      return Response.json({ id: "resp_direct_fast", status: "completed", output: [] });
    },
  }, {
    body: { model: "gpt-5.6-sol-fast", service_tier: "priority", input: "hello" },
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamBody.model, "gpt-5.6-sol-fast");
  assert.equal(upstreamBody.service_tier, "priority");
});

test("Auto Review drops inherited priority tiers without applying the Fast model mapping", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-adapter-auto-review-tier-"));
  const savedEnv = {};
  writeAutoReviewModel("gpt-5.6-sol", { env: savedEnv, home });
  const eligibleRegistry = { models: { data: [{
    id: "gpt-5.6-sol-fast",
    vendor: "OpenAI",
    policy: { state: "enabled" },
    model_picker_enabled: true,
    supported_endpoints: ["/responses", "ws:/responses"],
  }] } };
  const modelCases = [
    { name: "default", options: { openAIModelEnv: {} }, expectedModel: "gpt-5.5" },
    {
      name: "saved",
      options: {
        openAIModelEnv: savedEnv,
        autoReviewModelResolver: () => autoReviewModelPreference({ env: savedEnv, home }).model,
      },
      expectedModel: "gpt-5.6-sol",
    },
    {
      name: "environment",
      options: { openAIModelEnv: { CCDX_AUTO_REVIEW_MODEL: "gpt-5.6-sol" } },
      expectedModel: "gpt-5.6-sol",
    },
  ];

  for (const { name, options, expectedModel } of modelCases) {
    for (const compact of [false, true]) {
      let upstreamBody;
      const upstream = async (body) => {
        upstreamBody = structuredClone(body);
        if (!compact) return Response.json({ id: `resp_review_${name}`, status: "completed", output: [] });
        return Response.json({
          id: `resp_review_${name}_compact`,
          object: "response.compaction",
          status: "completed",
          output: [{ type: "compaction", id: `cmp_review_${name}`, encrypted_content: "review-state" }],
        });
      };
      const response = await invokeAdapter({
        ...options,
        codexModelRegistry: eligibleRegistry,
        ...(compact ? { responsesCompactFn: upstream } : { responsesFn: upstream }),
      }, {
        url: compact ? "/v1/responses/compact" : "/v1/responses",
        body: { model: "codex-auto-review", service_tier: "priority", input: "review" },
      });

      assert.equal(response.status, 200, `${name} ${compact ? "compact" : "responses"}`);
      assert.equal(upstreamBody.model, expectedModel, `${name} ${compact ? "compact" : "responses"}`);
      assert.equal(Object.hasOwn(upstreamBody, "service_tier"), false, `${name} ${compact ? "compact" : "responses"}`);
    }
  }
});

test("HTTP compact maps a catalog-approved priority tier before the upstream request", async () => {
  let upstreamBody;
  const response = await invokeAdapter({
    codexModelRegistry: { models: { data: [{
      id: "gpt-5.6-sol-fast",
      vendor: "OpenAI",
      policy: { state: "enabled" },
      model_picker_enabled: true,
      supported_endpoints: ["/responses", "ws:/responses"],
    }] } },
    responsesCompactFn: async (body) => {
      upstreamBody = structuredClone(body);
      return Response.json({
        id: "resp_fast_compact",
        object: "response.compaction",
        status: "completed",
        output: [{ type: "compaction", id: "cmp_fast", encrypted_content: "fast-state" }],
      });
    },
  }, {
    url: "/v1/responses/compact",
    body: { model: "gpt-5.6-sol", service_tier: "priority", input: "compact" },
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamBody.model, "gpt-5.6-sol-fast");
  assert.equal(Object.hasOwn(upstreamBody, "service_tier"), false);
});

test("priority-tier model mapping sanitizes encrypted history across the effective model boundary", async () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 1024 * 1024, maxEntries: 1 });
  const codexModelRegistry = { models: { data: [{
    id: "gpt-5.6-sol-fast",
    vendor: "OpenAI",
    policy: { state: "enabled" },
    model_picker_enabled: true,
    supported_endpoints: ["/responses", "ws:/responses"],
  }] } };
  try {
    const root = await invokeAdapter({
      codexModelRegistry,
      responsesFn: async () => Response.json({
        id: "resp_fast_affinity_root",
        status: "completed",
        output: [
          { type: "reasoning", id: "rs_fast", encrypted_content: "standard-cipher", summary: [] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible standard history" }] },
        ],
      }),
    }, {
      body: { model: "gpt-5.6-sol", input: "start" },
    });
    assert.equal(root.status, 200);

    let upstreamBody;
    const continuation = await invokeAdapter({
      codexModelRegistry,
      responsesFn: async (body) => {
        upstreamBody = structuredClone(body);
        return Response.json({ id: "resp_fast_affinity_child", status: "completed", output: [] });
      },
    }, {
      body: {
        model: "gpt-5.6-sol",
        service_tier: "priority",
        previous_response_id: "resp_fast_affinity_root",
        input: "continue fast",
      },
    });

    assert.equal(continuation.status, 200);
    assert.equal(upstreamBody.model, "gpt-5.6-sol-fast");
    assert.equal(JSON.stringify(upstreamBody).includes("encrypted_content"), false);
    assert.equal(JSON.stringify(upstreamBody).includes("visible standard history"), true);
    assert.equal(JSON.stringify(upstreamBody).includes("continue fast"), true);
    assert.equal(responseHistoryStats().entries, 1);

    const replay = await invokeAdapter({
      codexModelRegistry,
      responsesFn: async () => Response.json({ id: "resp_fast_affinity_replay", status: "completed", output: [] }),
    }, {
      body: {
        model: "gpt-5.6-sol",
        service_tier: "priority",
        previous_response_id: "resp_fast_affinity_child",
        input: "replay fast",
      },
    });
    assert.equal(replay.status, 200);
  } finally {
    clearResponseHistoryForTests();
  }
});

test("same priority tier preserves fast encrypted history while switching back to default sanitizes it", async () => {
  clearResponseHistoryForTests();
  const codexModelRegistry = { models: { data: [{
    id: "gpt-5.6-sol-fast",
    vendor: "OpenAI",
    policy: { state: "enabled" },
    model_picker_enabled: true,
    supported_endpoints: ["/responses", "ws:/responses"],
  }] } };
  try {
    const root = await invokeAdapter({
      codexModelRegistry,
      responsesFn: async () => Response.json({
        id: "resp_fast_same_root",
        status: "completed",
        model: "gpt-5.6-sol",
        output: [
          { type: "reasoning", id: "rs_fast_same", encrypted_content: "fast-cipher", summary: [] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible fast history" }] },
        ],
      }),
    }, {
      body: { model: "gpt-5.6-sol", service_tier: "priority", input: "start fast" },
    });
    assert.equal(root.status, 200);

    let sameTierBody;
    const sameTier = await invokeAdapter({
      codexModelRegistry,
      responsesFn: async (body) => {
        sameTierBody = structuredClone(body);
        return Response.json({ id: "resp_fast_same_child", status: "completed", output: [] });
      },
    }, {
      body: {
        model: "gpt-5.6-sol",
        service_tier: "priority",
        previous_response_id: "resp_fast_same_root",
        input: "continue fast",
      },
    });
    assert.equal(sameTier.status, 200);
    assert.equal(JSON.stringify(sameTierBody).includes("fast-cipher"), true);

    let defaultTierBody;
    const defaultTier = await invokeAdapter({
      codexModelRegistry,
      responsesFn: async (body) => {
        defaultTierBody = structuredClone(body);
        return Response.json({ id: "resp_fast_default_child", status: "completed", output: [] });
      },
    }, {
      body: {
        model: "gpt-5.6-sol",
        service_tier: "default",
        previous_response_id: "resp_fast_same_root",
        input: "continue default",
      },
    });
    assert.equal(defaultTier.status, 200);
    assert.equal(JSON.stringify(defaultTierBody).includes("encrypted_content"), false);
    assert.equal(JSON.stringify(defaultTierBody).includes("visible fast history"), true);
    assert.equal(JSON.stringify(defaultTierBody).includes("continue default"), true);
  } finally {
    clearResponseHistoryForTests();
  }
});

test("HTTP responses route resolves saved Auto Review model on every request", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-adapter-auto-review-"));
  const env = {};
  writeAutoReviewModel("gpt-5.6-luna", { env, home });
  const upstreamModels = [];
  const options = {
    openAIModelEnv: env,
    autoReviewModelResolver: () => autoReviewModelPreference({ env, home }).model,
    responsesFn: async (body) => {
      upstreamModels.push(body.model);
      return new Response(JSON.stringify({ id: "resp_review_dynamic", status: "completed", output: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };

  await invokeAdapter(options, { body: { model: "codex-auto-review", input: "first" } });
  writeAutoReviewModel("gpt-5.6-terra", { env, home });
  await invokeAdapter(options, { body: { model: "codex-auto-review", input: "second" } });

  assert.deepEqual(upstreamModels, ["gpt-5.6-luna", "gpt-5.6-terra"]);
});

test("HTTP Responses routes custom tool protocol to native Responses when endpoint metadata allows it", async () => {
  resetModelEndpointCacheForTests();
  cacheModelEndpoints({
    data: [{ id: "gpt-dual-custom", supported_endpoints: ["/responses", "/chat/completions"] }],
  });
  let upstreamBody;
  let chatCalls = 0;
  let response;
  try {
    response = await invokeAdapter({
      responsesFn: async (body) => {
        upstreamBody = body;
        return new Response(JSON.stringify({ id: "resp_custom_native", status: "completed", output: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      chatCompletionsFn: async () => {
        chatCalls += 1;
        throw new Error("custom tools must not use Chat Completions");
      },
    }, {
      body: {
        model: "gpt-dual-custom",
        stream: false,
        tools: [{ type: "custom", name: "shell", description: "Run shell input" }],
        input: [
          { type: "custom_tool_call", call_id: "call_custom", name: "shell", input: "pwd" },
          ...Array.from({ length: 3 }, (_, index) => ({
            type: "custom_tool_call_output",
            call_id: `call_custom_${index}`,
            output: "x".repeat(2000),
          })),
          { type: "function_call_output", call_id: "call_function", output: "y".repeat(2000) },
        ],
      },
    });
  } finally {
    resetModelEndpointCacheForTests();
  }

  assert.equal(response.status, 200);
  assert.equal(chatCalls, 0);
  assert.deepEqual(upstreamBody.input.map((item) => item.type), [
    "custom_tool_call",
    "custom_tool_call_output",
    "custom_tool_call_output",
    "custom_tool_call_output",
    "function_call_output",
  ]);
  assert.equal(upstreamBody.tools[0].type, "custom");
});

test("HTTP Responses rejects custom tool protocol before upstream when Responses support is unconfirmed", async () => {
  resetModelEndpointCacheForTests();
  cacheModelEndpoints({
    data: [{ id: "gpt-chat-custom", supported_endpoints: ["/chat/completions"] }],
  });
  let upstreamCalls = 0;
  let response;
  try {
    response = await invokeAdapter({
      responsesFn: async () => {
        upstreamCalls += 1;
        return new Response("{}", { status: 200 });
      },
      chatCompletionsFn: async () => {
        upstreamCalls += 1;
        return new Response("{}", { status: 200 });
      },
    }, {
      body: {
        model: "gpt-chat-custom",
        input: [{ type: "custom_tool_call_output", call_id: "call_custom", output: "/tmp" }],
      },
    });
  } finally {
    resetModelEndpointCacheForTests();
  }

  const error = JSON.parse(response.text).error;
  assert.equal(response.status, 400);
  assert.equal(error.code, "ccdx_custom_tools_require_responses");
  assert.equal(error.model, "gpt-chat-custom");
  assert.equal(upstreamCalls, 0);
});

test("HTTP compact route honors the Codex auto-review model override", async () => {
  let upstreamBody;
  const response = await invokeAdapter({
    openAIModelEnv: { CCDX_AUTO_REVIEW_MODEL: "gpt-5.6-sol" },
    responsesCompactFn: async (body) => {
      upstreamBody = body;
      return new Response(JSON.stringify({
        id: "resp_compact",
        status: "completed",
        output: [{ type: "compaction", id: "cmp_review", encrypted_content: "review-state" }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  }, {
    url: "/v1/responses/compact",
    body: { model: "codex-auto-review", input: "compact review context" },
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamBody.model, "gpt-5.6-sol");
  assert.equal(upstreamBody.stream, false);
  assert.deepEqual(upstreamBody.input.at(-1), { type: "compaction_trigger" });
});

test("HTTP non-stream Responses conversion preserves upstream error status", async () => {
  const response = await invokeAdapter({
    chatCompletionsFn: async () => new Response(JSON.stringify({ error: { message: "denied" } }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }),
  }, {
    body: { model: "gpt-4o", input: "hello", stream: false },
  });

  assert.equal(response.status, 403);
  assert.deepEqual(JSON.parse(response.text), { error: { message: "denied" } });
});

test("HTTP non-stream Responses conversion returns text, tools, and usage", async () => {
  let upstreamBody;
  const previousDisableUsage = process.env.CCDX_DISABLE_USAGE;
  process.env.CCDX_DISABLE_USAGE = "1";
  let response;
  try {
    response = await invokeAdapter({
      chatCompletionsFn: async (body) => {
        upstreamBody = body;
        return new Response(JSON.stringify({
          id: "chatcmpl_ok",
          model: "gpt-4o",
          choices: [{
            message: {
              role: "assistant",
              content: "done",
              tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }],
            },
          }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    }, {
      body: { model: "gpt-4o", input: "hello", stream: false },
    });
  } finally {
    if (previousDisableUsage === undefined) delete process.env.CCDX_DISABLE_USAGE;
    else process.env.CCDX_DISABLE_USAGE = previousDisableUsage;
  }

  const data = JSON.parse(response.text);
  assert.equal(response.status, 200);
  assert.equal(upstreamBody.stream, false);
  assert.deepEqual(data.output.map((item) => item.type), ["message", "function_call"]);
  assert.deepEqual(data.usage, { input_tokens: 11, output_tokens: 7, total_tokens: 18 });
});

test("HTTP Responses chat bridge applies q82, q75, and q65 before forwarding", async () => {
  const original = `data:image/png;base64,${Buffer.alloc(3000, 7).toString("base64")}`;
  const qualities = [];
  let upstreamBody;
  const response = await invokeAdapter({
    responsesPayloadOptions: {
      maxBytes: 1000,
      profiles: [
        { maxDim: 1600, quality: 75 },
        { maxDim: 1280, quality: 65 },
      ],
      optimizeImage: async (dataUrl, options) => {
        qualities.push(options.quality);
        const raw = Buffer.from(dataUrl.split(",", 2)[1], "base64");
        const ratio = options.quality === 82 ? 0.8 : options.quality === 75 ? 0.6 : 0.1;
        return `data:image/webp;base64,${Buffer.alloc(Math.floor(raw.length * ratio), 8).toString("base64")}`;
      },
    },
    chatCompletionsFn: async (body, { bodyText }) => {
      upstreamBody = body;
      assert.equal(bodyText, JSON.stringify(body));
      return new Response(JSON.stringify({
        id: "chatcmpl_budget_ok",
        model: "gpt-4o",
        choices: [{ message: { role: "assistant", content: "done" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  }, {
    body: {
      model: "gpt-4o",
      stream: false,
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: original }],
      }],
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(qualities, [82, 75, 65]);
  assert.ok(Buffer.byteLength(JSON.stringify(upstreamBody)) <= 1000);
  assert.match(upstreamBody.messages[0].content[0].image_url.url, /^data:image\/webp;base64,/);
});

test("HTTP streaming Responses chat bridge reuses the exact prepared body text", async () => {
  let upstreamCalls = 0;
  const response = await invokeAdapter({
    chatCompletionsFn: async (body, { bodyText }) => {
      upstreamCalls += 1;
      assert.equal(body.stream, true);
      assert.equal(body.stream_options.include_usage, true);
      assert.equal(bodyText, JSON.stringify(body));
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  }, {
    body: { model: "gpt-4o", stream: true, input: "hello stream" },
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamCalls, 1);
  assert.match(response.text, /response\.completed/);
});

test("HTTP Responses chat bridge trims historical tool output before forwarding", async () => {
  clearResponseHistoryForTests();
  const history = prepareResponsesRequest({
    model: "gpt-4o",
    input: [
      { type: "function_call", call_id: "call_large", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_large", output: "x".repeat(4000) },
    ],
  });
  rememberResponseHistory(history, { id: "resp_chat_budget_history", status: "completed", output: [] });

  let upstreamBody;
  const response = await invokeAdapter({
    responsesPayloadOptions: { maxBytes: 700, profiles: [] },
    chatCompletionsFn: async (body) => {
      upstreamBody = body;
      return new Response(JSON.stringify({
        id: "chatcmpl_trimmed_history",
        model: "gpt-4o",
        choices: [{ message: { role: "assistant", content: "done" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  }, {
    body: {
      model: "gpt-4o",
      stream: false,
      previous_response_id: "resp_chat_budget_history",
      input: "continue",
    },
  });

  assert.equal(response.status, 200);
  assert.ok(Buffer.byteLength(JSON.stringify(upstreamBody)) <= 700);
  assert.match(upstreamBody.messages.find((message) => message.role === "tool").content, /earlier tool output omitted/);
  clearResponseHistoryForTests();
});

test("HTTP Responses strips target-bound encrypted history before a streaming Chat route change", async () => {
  clearResponseHistoryForTests();
  try {
    const root = await invokeAdapter({
      responsesFn: async () => Response.json({
        id: "resp_http_affinity_root",
        status: "completed",
        output: [
          { type: "reasoning", id: "rs_http", encrypted_content: "http-cipher", summary: [] },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "visible history" }],
          },
        ],
      }),
    }, {
      body: { model: "gpt-5.6-sol", input: "start" },
    });
    assert.equal(root.status, 200);

    let chatRequest;
    const continuation = await invokeAdapter({
      chatCompletionsFn: async (body) => {
        chatRequest = structuredClone(body);
        return new Response([
          'data: {"model":"gpt-4o","choices":[{"delta":{"content":"continued"}}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"), { headers: { "Content-Type": "text/event-stream" } });
      },
    }, {
      body: {
        model: "gpt-4o",
        stream: true,
        previous_response_id: "resp_http_affinity_root",
        input: "continue",
      },
    });

    assert.equal(continuation.status, 200);
    assert.match(continuation.text, /response\.completed/);
    assert.equal(JSON.stringify(chatRequest).includes("encrypted_content"), false);
    assert.equal(JSON.stringify(chatRequest).includes("visible history"), true);
    assert.equal(JSON.stringify(chatRequest).includes("continue"), true);
  } finally {
    clearResponseHistoryForTests();
  }
});

async function assertChatBridgeRejectsOversizedCurrentInput(stream) {
  let upstreamCalls = 0;
  const response = await invokeAdapter({
    responsesPayloadOptions: { maxBytes: 128, profiles: [] },
    chatCompletionsFn: async () => {
      upstreamCalls += 1;
      return new Response("{}", { status: 200 });
    },
  }, {
    body: {
      model: "gpt-4o",
      stream,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(1000) }] }],
    },
  });

  const error = JSON.parse(response.text).error;
  assert.equal(response.status, 413);
  assert.match(response.headers["Content-Type"], /^application\/json/);
  assert.equal(error.code, "ccdx_request_body_too_large");
  assert.equal(error.limit_bytes, 128);
  assert.ok(error.actual_bytes > error.limit_bytes);
  assert.equal(upstreamCalls, 0);
}

test("HTTP non-stream Responses chat bridge rejects an irreducible oversized body locally", async () => {
  await assertChatBridgeRejectsOversizedCurrentInput(false);
});

test("HTTP streaming Responses chat bridge rejects an irreducible oversized body locally", async () => {
  await assertChatBridgeRejectsOversizedCurrentInput(true);
});

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

test("HTTP Codex routes preserve Responses fallback, compact, and model discovery", async () => {
  const calls = [];
  const codexClient = {
    getCachedModelEndpoints(model) {
      return model === "gpt-native" ? ["/responses"] : ["/chat/completions"];
    },
    async responses(body) {
      calls.push(["codex.responses", body.model]);
      return Response.json({ id: "resp_native", status: "completed", output: [] });
    },
    async responsesCompact(body) {
      calls.push(["codex.compact", body.model]);
      return Response.json({
        id: "resp_compact",
        status: "completed",
        output: [{ type: "compaction", encrypted_content: "snapshot" }],
      });
    },
    async chatCompletions(body) {
      calls.push(["codex.chat", body.model]);
      return Response.json({
        id: "chat_codex",
        model: body.model,
        choices: [{ message: { role: "assistant", content: "codex" } }],
      });
    },
    async listModels() {
      calls.push(["codex.models"]);
      return { status: 200, body: JSON.stringify({ data: [{ id: "gpt-native" }] }) };
    },
  };
  const options = {
    codexClient,
    codexModelRegistry: { models: { data: [{ id: "gpt-cached" }] } },
  };

  assert.equal((await invokeAdapter(options, {
    body: { model: "gpt-native", input: "native" },
  })).status, 200);
  assert.equal((await invokeAdapter(options, {
    body: { model: "gpt-chat", input: "fallback" },
  })).status, 200);
  assert.equal((await invokeAdapter(options, {
    url: "/v1/responses/compact",
    body: { model: "gpt-native", input: "compact" },
  })).status, 200);

  const codexModels = await invokeAdapter(options, { method: "GET", url: "/v1/models" });
  assert.deepEqual(JSON.parse(codexModels.text).data.map(({ id }) => id), ["gpt-native"]);

  assert.deepEqual(calls, [
    ["codex.responses", "gpt-native"],
    ["codex.chat", "gpt-chat"],
    ["codex.compact", "gpt-native"],
    ["codex.models"],
  ]);
});

test("stripInternalResponsesInputFields: drops only top-level internal input fields", () => {
  const input = [
    {
      type: "message",
      role: "user",
      internal_chat_message_metadata_passthrough: { hidden: true },
      content: [{ type: "input_text", text: "hello" }],
    },
  ];

  assert.equal(stripInternalResponsesInputFields(input), input);
  assert.deepEqual(input, [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    },
  ]);
});

test("prepareResponsesRequest: strips Codex private input fields without mutating request", () => {
  const req = {
    model: "gpt-5.5",
    input: [{
      type: "message",
      role: "user",
      internal_chat_message_metadata_passthrough: { hidden: true },
      content: [{ type: "input_text", text: "hello" }],
    }],
  };

  const prepared = prepareResponsesRequest(req);

  assert.equal(req.input[0].internal_chat_message_metadata_passthrough.hidden, true);
  assert.deepEqual(prepared.body.input, [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "hello" }],
  }]);
  assert.deepEqual(prepared.inputItems, prepared.body.input);
});

test("prepareResponsesRequest: can take ownership of a freshly parsed request", () => {
  const request = {
    model: "gpt-5.5",
    store: true,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
  };
  const input = request.input;
  const prepared = prepareResponsesRequest(request, { mutate: true });

  assert.equal(prepared.body, request);
  assert.equal(prepared.body.input, input);
  assert.equal(prepared.historyInputItems, input);
  assert.equal(prepared.takeHistoryOwnership, true);
  assert.equal(request.store, undefined);
});

test("prepareResponsesRequest: strips private fields from expanded previous response history", () => {
  clearResponseHistoryForTests();

  const first = prepareResponsesRequest({
    model: "gpt-5.5",
    input: [{
      type: "message",
      role: "user",
      internal_chat_message_metadata_passthrough: { hidden: true },
      content: [{ type: "input_text", text: "remember alpha" }],
    }],
  });
  rememberResponseHistory(first, {
    id: "resp_internal",
    output: [{ type: "message", id: "msg_internal", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
  });

  const second = prepareResponsesRequest({
    model: "gpt-5.5",
    previous_response_id: "resp_internal",
    input: "what did I say?",
  });

  assert.deepEqual(second.body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "remember alpha" }] },
    { type: "message", id: "msg_internal", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "what did I say?" }] },
  ]);
});

test("isEncryptedContentVerificationError: detects upstream encrypted reasoning failures", () => {
  const text = JSON.stringify({
    error: {
      message: "The encrypted content gAAA... could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
      code: "invalid_request_body",
    },
  });
  const functionOutputText = JSON.stringify({
    error: {
      message: "Encrypted function output content could not be decrypted or decoded.",
      code: "invalid_request_body",
    },
  });
  const missingEncryptedContentText = JSON.stringify({
    error: {
      message: "Missing required parameter: 'input[3].content[1].encrypted_content'.",
      code: "missing_required_parameter",
    },
  });

  assert.equal(isEncryptedContentVerificationError(400, text), true);
  assert.equal(isEncryptedContentVerificationError(400, functionOutputText), true);
  assert.equal(isEncryptedContentVerificationError(400, missingEncryptedContentText), true);
  assert.equal(isEncryptedContentVerificationError(422, missingEncryptedContentText), true);
  assert.equal(isEncryptedContentVerificationError(200, text), false);
  assert.equal(isEncryptedContentVerificationError(200, functionOutputText), false);
  assert.equal(isEncryptedContentVerificationError(500, missingEncryptedContentText), false);
  assert.equal(isEncryptedContentVerificationError(400, "Missing required parameter: 'input[3].content[1].text'."), false);
  assert.equal(isEncryptedContentVerificationError(400, "Missing required parameter: 'input[3].content[1].encrypted_content_backup'."), false);
  assert.equal(isEncryptedContentVerificationError(400, "Missing required parameter: 'input[3].content[1].encrypted_content.extra'."), false);
  assert.equal(isEncryptedContentVerificationError(400, "Raw request body exceeds 1 bytes"), false);
});

test("sanitizeEncryptedReasoningRequest: removes reasoning items and encrypted content fields", () => {
  const ctx = {
    body: {
      model: "gpt-5.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "reasoning", id: "rs_1", encrypted_content: "gAAA", summary: [] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible", encrypted_content: "gAAA" }] },
      ],
    },
    inputItems: [],
  };

  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  assert.deepEqual(sanitized.body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible" }] },
  ]);
  assert.deepEqual(sanitized.inputItems, sanitized.body.input);
  assert.equal(ctx.body.input.length, 3);
});

test("sanitizeEncryptedReasoningRequest: drops nested encrypted_content parts without schema shells", () => {
  const ctx = {
    body: {
      model: "gpt-5.5",
      store: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
        { type: "reasoning", id: "rs_nested", encrypted_content: "gAAA-reasoning", summary: [] },
        { type: "function_call", id: "call_1", name: "lookup", arguments: "{}", status: "completed" },
        {
          type: "message",
          role: "assistant",
          id: "msg_nested",
          status: "completed",
          content: [
            { type: "output_text", text: "before", annotations: [] },
            { type: "encrypted_content", encrypted_content: "gAAA-nested", id: "enc_1" },
            { type: "output_text", text: "after", annotations: [], metadata: { keep: true } },
          ],
        },
      ],
    },
    inputItems: [],
  };

  assert.equal(ctx.body.input[3].content[1].type, "encrypted_content");
  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  assert.deepEqual(sanitized.body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
    { type: "function_call", id: "call_1", name: "lookup", arguments: "{}", status: "completed" },
    {
      type: "message",
      role: "assistant",
      id: "msg_nested",
      status: "completed",
      content: [
        { type: "output_text", text: "before", annotations: [] },
        { type: "output_text", text: "after", annotations: [], metadata: { keep: true } },
      ],
    },
  ]);
  assert.equal(JSON.stringify(sanitized.body).includes('"type":"encrypted_content"'), false);
  assert.deepEqual(ctx.body.input[3].content[1], {
    type: "encrypted_content",
    encrypted_content: "gAAA-nested",
    id: "enc_1",
  });
});

test("sanitizeEncryptedReasoningRequest: omits encrypted-only messages while preserving empty and visible messages", () => {
  const preexistingEmpty = { type: "message", role: "assistant", content: [] };
  const encryptedOnly = {
    type: "message",
    role: "assistant",
    content: [{ type: "encrypted_content", encrypted_content: "history-only-cipher" }],
  };
  const untypedEncryptedOnly = {
    type: "message",
    role: "assistant",
    content: [{ encrypted_content: "history-untyped-cipher" }],
  };
  const mixed = {
    type: "message",
    role: "assistant",
    content: [
      { type: "output_text", text: "visible", encrypted_content: "visible-field-cipher" },
      { type: "encrypted_content", encrypted_content: "current-cipher" },
    ],
  };
  const historyInputItems = [preexistingEmpty, encryptedOnly, untypedEncryptedOnly, mixed];
  const ctx = {
    body: { model: "gpt-5.5", input: historyInputItems },
    inputItems: [],
    currentInputStart: 3,
    historyParentId: "resp_parent",
    historyRootId: "resp_root",
    historyInputItems,
  };
  const original = structuredClone(ctx);

  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  const expected = [
    preexistingEmpty,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible" }] },
  ];
  assert.deepEqual(sanitized.body.input, expected);
  assert.deepEqual(sanitized.historyInputItems, expected);
  assert.equal(sanitized.currentInputStart, 1);
  assert.equal(sanitized.body.input.some((item) => typeof item === "symbol"), false);
  assert.equal(sanitized.historyInputItems.some((item) => typeof item === "symbol"), false);
  assert.equal(JSON.stringify(sanitized).includes("encrypted_content"), false);
  assert.deepEqual(ctx, original);

  const emptyOnly = {
    body: { model: "gpt-5.5", input: [preexistingEmpty] },
    inputItems: [],
  };
  assert.equal(sanitizeEncryptedReasoningRequest(emptyOnly), null);
});

const ENCRYPTED_TOOL_OUTPUT_MARKER = "[CCDX: encrypted tool output omitted because upstream could not decrypt it.]";

test("sanitizeEncryptedReasoningRequest: cleans array and stringified function outputs without breaking pairs", () => {
  const cases = [
    { callType: "function_call", outputType: "function_call_output", callId: "function_array", stringified: false },
    { callType: "function_call", outputType: "function_call_output", callId: "function_string", stringified: true },
    { callType: "custom_tool_call", outputType: "custom_tool_call_output", callId: "custom_array", stringified: false },
    { callType: "custom_tool_call", outputType: "custom_tool_call_output", callId: "custom_string", stringified: true },
  ];
  const input = cases.flatMap(({ callType, outputType, callId, stringified }) => {
    const call = callType === "function_call"
      ? { type: callType, id: `id_${callId}`, call_id: callId, name: "lookup", arguments: "{}" }
      : { type: callType, id: `id_${callId}`, call_id: callId, name: "shell", input: "pwd" };
    const parts = [
      { type: "input_text", text: `${callId} visible`, metadata: { keep: true }, encrypted_content: `${callId}-field` },
      { type: "encrypted_content", encrypted_content: `${callId}-part` },
    ];
    return [call, {
      type: outputType,
      call_id: callId,
      output: stringified ? JSON.stringify(parts) : parts,
    }];
  });
  const ctx = {
    body: {
      model: "gpt-5.5",
      store: false,
      input,
    },
    inputItems: [],
  };
  const original = structuredClone(ctx.body);

  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  const expected = cases.flatMap(({ callType, outputType, callId, stringified }) => {
    const call = callType === "function_call"
      ? { type: callType, id: `id_${callId}`, call_id: callId, name: "lookup", arguments: "{}" }
      : { type: callType, id: `id_${callId}`, call_id: callId, name: "shell", input: "pwd" };
    const visible = [{ type: "input_text", text: `${callId} visible`, metadata: { keep: true } }];
    return [call, {
      type: outputType,
      call_id: callId,
      output: stringified ? JSON.stringify(visible) : visible,
    }];
  });
  assert.deepEqual(sanitized.body.input, expected);
  assert.deepEqual(ctx.body, original);
  assert.equal(JSON.stringify(sanitized.body).includes("encrypted_content"), false);
  assert.deepEqual(sanitized.body.input.map((item) => item.type), expected.map((item) => item.type));
  assert.deepEqual(sanitized.body.input.map((item) => item.call_id), expected.map((item) => item.call_id));
});

test("sanitizeEncryptedReasoningRequest: replaces direct encrypted function and custom outputs with omission markers", () => {
  const cases = [
    { callType: "function_call", outputType: "function_call_output", callId: "function_direct" },
    { callType: "custom_tool_call", outputType: "custom_tool_call_output", callId: "custom_direct" },
  ];
  const input = cases.flatMap(({ callType, outputType, callId }) => [
    callType === "function_call"
      ? { type: callType, call_id: callId, name: "lookup", arguments: "{}" }
      : { type: callType, call_id: callId, name: "shell", input: "pwd" },
    {
      type: outputType,
      call_id: callId,
      output: { type: "encrypted_content", encrypted_content: `${callId}-part` },
      metadata: { keep: true },
    },
  ]);
  const ctx = { body: { model: "gpt-5.5", input }, inputItems: [] };
  const original = structuredClone(ctx.body);

  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  assert.deepEqual(sanitized.body.input.map((item) => item.type), input.map((item) => item.type));
  assert.deepEqual(sanitized.body.input.map((item) => item.call_id), input.map((item) => item.call_id));
  assert.deepEqual(sanitized.body.input.filter(isResponsesToolOutputItem).map((item) => item.output), [
    ENCRYPTED_TOOL_OUTPUT_MARKER,
    ENCRYPTED_TOOL_OUTPUT_MARKER,
  ]);
  assert.deepEqual(sanitized.body.input.filter(isResponsesToolOutputItem).map((item) => item.metadata), [
    { keep: true },
    { keep: true },
  ]);
  assert.equal(JSON.stringify(sanitized.body).includes("encrypted_content"), false);
  assert.deepEqual(ctx.body, original);
});

test("sanitizeEncryptedReasoningRequest: replaces encrypted-only array and stringified tool outputs with omission markers", () => {
  const cases = [
    { callType: "function_call", outputType: "function_call_output", callId: "function_array", stringified: false },
    { callType: "function_call", outputType: "function_call_output", callId: "function_string", stringified: true },
    { callType: "custom_tool_call", outputType: "custom_tool_call_output", callId: "custom_array", stringified: false },
    { callType: "custom_tool_call", outputType: "custom_tool_call_output", callId: "custom_string", stringified: true },
  ];
  const input = cases.flatMap(({ callType, outputType, callId, stringified }) => {
    const parts = [{ type: "encrypted_content", encrypted_content: `${callId}-part` }];
    return [
      callType === "function_call"
        ? { type: callType, call_id: callId, name: "lookup", arguments: "{}" }
        : { type: callType, call_id: callId, name: "shell", input: "pwd" },
      { type: outputType, call_id: callId, output: stringified ? JSON.stringify(parts) : parts },
    ];
  });
  const ctx = { body: { model: "gpt-5.5", input }, inputItems: [] };
  const original = structuredClone(ctx.body);

  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  assert.deepEqual(sanitized.body.input.map((item) => item.type), input.map((item) => item.type));
  assert.deepEqual(sanitized.body.input.map((item) => item.call_id), input.map((item) => item.call_id));
  assert.deepEqual(sanitized.body.input.filter(isResponsesToolOutputItem).map((item) => item.output), [
    ENCRYPTED_TOOL_OUTPUT_MARKER,
    ENCRYPTED_TOOL_OUTPUT_MARKER,
    ENCRYPTED_TOOL_OUTPUT_MARKER,
    ENCRYPTED_TOOL_OUTPUT_MARKER,
  ]);
  assert.equal(JSON.stringify(sanitized.body).includes("encrypted_content"), false);
  assert.deepEqual(ctx.body, original);
});

test("sanitizeEncryptedReasoningRequest: cleans history tool outputs without mutating source history", () => {
  const historyInputItems = [
    {
      type: "function_call_output",
      call_id: "history_function",
      output: [
        { type: "input_text", text: "visible history" },
        { type: "encrypted_content", encrypted_content: "history-function-part" },
      ],
    },
    {
      type: "custom_tool_call_output",
      call_id: "history_custom",
      output: [{ type: "encrypted_content", encrypted_content: "history-custom-part" }],
    },
  ];
  const ctx = {
    body: {
      model: "gpt-5.5",
      input: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "visible", encrypted_content: "body-part" }],
      }],
    },
    inputItems: [],
    historyInputItems,
  };
  const originalHistory = structuredClone(historyInputItems);

  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  assert.deepEqual(historyInputItems, originalHistory);
  assert.deepEqual(sanitized.historyInputItems, [
    {
      type: "function_call_output",
      call_id: "history_function",
      output: [{ type: "input_text", text: "visible history" }],
    },
    { type: "custom_tool_call_output", call_id: "history_custom", output: ENCRYPTED_TOOL_OUTPUT_MARKER },
  ]);
  assert.equal(JSON.stringify(sanitized.historyInputItems).includes("encrypted_content"), false);
});

test("sanitizeEncryptedReasoningRequest: preserves function call pairing when removing an encrypted field", () => {
  const ctx = {
    body: {
      model: "gpt-5.5",
      input: [
        {
          type: "function_call",
          id: "fc_pair",
          call_id: "call_pair",
          name: "lookup",
          arguments: "{}",
          encrypted_content: "call-part",
          metadata: { keep: true },
        },
        { type: "function_call_output", call_id: "call_pair", output: "visible output" },
      ],
    },
    inputItems: [],
  };

  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  assert.deepEqual(sanitized.body.input, [
    {
      type: "function_call",
      id: "fc_pair",
      call_id: "call_pair",
      name: "lookup",
      arguments: "{}",
      metadata: { keep: true },
    },
    { type: "function_call_output", call_id: "call_pair", output: "visible output" },
  ]);
});

test("sanitizeEncryptedReasoningRequest: removes compaction items as complete encrypted state", () => {
  const ctx = {
    body: {
      model: "gpt-5.5",
      input: [
        { type: "message", role: "user", content: "continue" },
        { type: "compaction", id: "cmp_encrypted", encrypted_content: "compaction-part" },
      ],
    },
    inputItems: [],
  };

  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  assert.deepEqual(sanitized.body.input, [{ type: "message", role: "user", content: "continue" }]);
});

test("sanitizeEncryptedReasoningRequest: keeps history parent when current input is sanitized", () => {
  const currentInput = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "visible", encrypted_content: "current-part" }],
  };
  const ctx = {
    body: {
      model: "gpt-5.5",
      input: [
        { type: "message", role: "user", content: "historical" },
        currentInput,
      ],
    },
    inputItems: [],
    currentInputStart: 1,
    historyParentId: "resp_parent",
    historyRootId: "resp_root",
    historyInputItems: [currentInput],
  };

  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  assert.equal(sanitized.historyParentId, "resp_parent");
  assert.equal(sanitized.historyRootId, "resp_root");
  assert.deepEqual(sanitized.historyInputItems, [{
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "visible" }],
  }]);
  assert.notStrictEqual(sanitized.historyInputItems, sanitized.body.input);
});

test("sanitizeEncryptedReasoningRequest: returns null when no encrypted reasoning is present", () => {
  const ctx = {
    body: { model: "gpt-5.5", input: [{ type: "message", role: "user", content: "hello" }] },
    inputItems: [],
  };

  assert.equal(sanitizeEncryptedReasoningRequest(ctx), null);
});

test("openCopilotResponse: retries encrypted reasoning failures with sanitized input", async () => {
  const encryptedError = JSON.stringify({
    error: {
      message: "The encrypted content gAAA... could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
      code: "invalid_request_body",
    },
  });
  const calls = [];
  const payloadPrepared = [];
  const ctx = {
    body: {
      model: "gpt-5.5",
      store: false,
      stream: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "reasoning", encrypted_content: "gAAA", summary: [] },
        { type: "function_call", id: "call_retry", name: "lookup", arguments: "{}" },
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "visible", annotations: [] },
            { type: "encrypted_content", encrypted_content: "gAAA-nested" },
          ],
        },
      ],
    },
    inputItems: [],
  };
  const upstream = async (body, requestOptions) => {
    calls.push(body);
    payloadPrepared.push(requestOptions.payloadPrepared);
    if (calls.length === 1) {
      return new Response(encryptedError, { status: 400, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ id: "resp_1", output: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const opened = await openCopilotResponse(ctx, upstream);

  assert.equal(calls.length, 2);
  assert.deepEqual(payloadPrepared, [false, true]);
  assert.equal(opened.resp.ok, true);
  assert.equal(calls[0].input[3].content[1].encrypted_content, "gAAA-nested");
  assert.deepEqual(calls[1].input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    { type: "function_call", id: "call_retry", name: "lookup", arguments: "{}" },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "visible", annotations: [] }],
    },
  ]);
  assert.deepEqual(opened.reqContext.inputItems, calls[1].input);
  assert.deepEqual(await opened.resp.json(), { id: "resp_1", output: [] });
});

test("openCopilotResponse: retries exact encrypted function output failures with intact first payload", async () => {
  const encryptedError = JSON.stringify({
    error: {
      message: "Encrypted function output content could not be decrypted or decoded.",
      code: "invalid_request_body",
    },
  });
  const ctx = {
    body: {
      model: "gpt-5.5",
      store: false,
      input: [
        { type: "function_call", call_id: "call_function", name: "lookup", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "call_function",
          output: [
            { type: "input_text", text: "function visible" },
            { type: "encrypted_content", encrypted_content: "function-part" },
          ],
        },
        { type: "custom_tool_call", call_id: "call_custom", name: "shell", input: "pwd" },
        {
          type: "custom_tool_call_output",
          call_id: "call_custom",
          output: JSON.stringify([
            { type: "input_text", text: "custom visible" },
            { type: "encrypted_content", encrypted_content: "custom-part" },
          ]),
        },
      ],
    },
    inputItems: [],
  };
  const original = structuredClone(ctx.body);
  const calls = [];
  const upstream = async (body) => {
    calls.push(structuredClone(body));
    return calls.length === 1
      ? new Response(encryptedError, { status: 400, headers: { "Content-Type": "application/json" } })
      : Response.json({ id: "resp_function_output", output: [] });
  };

  const opened = await openCopilotResponse(ctx, upstream);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], original);
  assert.deepEqual(calls[1].input.map((item) => item.type), [
    "function_call",
    "function_call_output",
    "custom_tool_call",
    "custom_tool_call_output",
  ]);
  assert.deepEqual(calls[1].input[1].output, [{ type: "input_text", text: "function visible" }]);
  assert.deepEqual(JSON.parse(calls[1].input[3].output), [{ type: "input_text", text: "custom visible" }]);
  assert.equal(JSON.stringify(calls[1]).includes("encrypted_content"), false);
  assert.equal(opened.resp.ok, true);
});

test("openCopilotResponse: exact function output fallback retries once and unrelated errors do not retry", async () => {
  const encryptedError = JSON.stringify({
    error: { message: "Encrypted function output content could not be decrypted or decoded." },
  });
  const ctx = {
    body: {
      model: "gpt-5.5",
      input: [{
        type: "custom_tool_call_output",
        call_id: "call_once",
        output: JSON.stringify([
          { type: "encrypted_content", encrypted_content: "custom-part" },
          { type: "input_text", text: "visible" },
        ]),
      }],
    },
    inputItems: [],
  };
  let encryptedCalls = 0;
  const failed = await openCopilotResponse(ctx, async () => {
    encryptedCalls += 1;
    return new Response(encryptedError, { status: 400 });
  });
  assert.equal(encryptedCalls, 2);
  assert.equal(failed.errorText, encryptedError);

  const unrelatedError = JSON.stringify({ error: { message: "Function output is invalid." } });
  let unrelatedCalls = 0;
  const unrelated = await openCopilotResponse(ctx, async () => {
    unrelatedCalls += 1;
    return new Response(unrelatedError, { status: 400 });
  });
  assert.equal(unrelatedCalls, 1);
  assert.equal(unrelated.errorText, unrelatedError);
});

test("openCopilotResponse: missing encrypted_content retries once only when sanitization changes input", async () => {
  const missingEncryptedContentError = JSON.stringify({
    error: {
      message: "Missing required parameter: 'input[3].content[1].encrypted_content'.",
      code: "missing_required_parameter",
    },
  });
  const encryptedCtx = {
    body: {
      model: "gpt-5.5",
      input: [{
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "visible" },
          { type: "encrypted_content", encrypted_content: "nested-part" },
        ],
      }],
    },
    inputItems: [],
  };
  const encryptedCalls = [];
  const failed = await openCopilotResponse(encryptedCtx, async (body) => {
    encryptedCalls.push(structuredClone(body));
    return new Response(missingEncryptedContentError, { status: 400 });
  });

  assert.equal(encryptedCalls.length, 2);
  assert.equal(encryptedCalls[0].input[0].content[1].encrypted_content, "nested-part");
  assert.deepEqual(encryptedCalls[1].input[0].content, [{ type: "output_text", text: "visible" }]);
  assert.equal(failed.errorText, missingEncryptedContentError);

  const cleanCtx = {
    body: { model: "gpt-5.5", input: [{ type: "message", role: "user", content: "hello" }] },
    inputItems: [],
  };
  let cleanCalls = 0;
  const cleanFailed = await openCopilotResponse(cleanCtx, async () => {
    cleanCalls += 1;
    return new Response(missingEncryptedContentError, { status: 400 });
  });

  assert.equal(cleanCalls, 1);
  assert.equal(cleanFailed.errorText, missingEncryptedContentError);
});

test("openCopilotResponse: exact missing encrypted message retry omits the message and rebases history", async () => {
  const missingEncryptedContentError = JSON.stringify({
    error: {
      message: "Missing required parameter: 'input[0].content[0].encrypted_content'.",
      code: "missing_required_parameter",
    },
  });
  const encryptedOnly = {
    type: "message",
    role: "assistant",
    content: [{ type: "encrypted_content", encrypted_content: "history-message-cipher" }],
  };
  const current = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "continue" }],
  };
  const ctx = {
    body: { model: "gpt-5.5", input: [encryptedOnly, current] },
    inputItems: [current],
    currentInputStart: 1,
    historyParentId: "resp_encrypted_message_parent",
    historyRootId: "resp_encrypted_message_root",
    historyInputItems: [current],
  };
  const originalBody = structuredClone(ctx.body);
  const calls = [];
  const currentInputStarts = [];

  const opened = await openCopilotResponse(ctx, async (body, options) => {
    calls.push(structuredClone(body));
    currentInputStarts.push(options.currentInputStart);
    return calls.length === 1
      ? new Response(missingEncryptedContentError, { status: 400 })
      : Response.json({ id: "resp_clean_message", status: "completed", output: [] });
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], originalBody);
  assert.deepEqual(calls[1].input, [current]);
  assert.deepEqual(currentInputStarts, [1, 0]);
  assert.equal(calls[1].input.some((item) => typeof item === "symbol"), false);
  assert.equal(calls[1].input.some((item) => Array.isArray(item?.content) && item.content.length === 0), false);
  assert.equal(opened.reqContext.historyParentId, null);
  assert.equal(opened.reqContext.historyRootId, null);
  assert.equal(opened.reqContext.currentInputStart, 0);
  assert.strictEqual(opened.reqContext.historyInputItems, opened.reqContext.body.input);
  assert.deepEqual(opened.reqContext.historyInputItems, [current]);
});

test("encrypted history retry rebases the successful branch without rewriting the old response branch", async () => {
  clearResponseHistoryForTests();
  try {
    const root = prepareResponsesRequest({
      model: "gpt-5.5",
      input: [{ type: "message", role: "user", content: "start" }],
    });
    rememberResponseHistory(root, {
      id: "resp_cipher_root",
      status: "completed",
      output: [
        {
          type: "reasoning",
          id: "rs_history",
          encrypted_content: "root-reasoning-cipher",
          summary: [],
        },
        {
          type: "function_call",
          id: "fc_history",
          call_id: "call_function",
          name: "lookup",
          arguments: "{}",
          encrypted_content: "root-function-cipher",
        },
        {
          type: "custom_tool_call",
          id: "ct_history",
          call_id: "call_custom",
          name: "shell",
          input: "pwd",
          encrypted_content: "root-custom-cipher",
        },
      ],
    });

    const second = prepareResponsesRequest({
      model: "gpt-5.5",
      previous_response_id: "resp_cipher_root",
      input: [
        { type: "function_call_output", call_id: "call_function", output: "function visible" },
        { type: "custom_tool_call_output", call_id: "call_custom", output: "custom visible" },
      ],
    });
    const originalSecondBody = structuredClone(second.body);
    const exactError = JSON.stringify({
      error: { message: "Encrypted function output content could not be decrypted or decoded." },
    });
    const secondCalls = [];
    const opened = await openCopilotResponse(second, async (body) => {
      secondCalls.push(structuredClone(body));
      return secondCalls.length === 1
        ? new Response(exactError, { status: 400 })
        : Response.json({
          id: "resp_clean_child",
          status: "completed",
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          }],
        });
    });

    assert.equal(secondCalls.length, 2);
    assert.deepEqual(secondCalls[0], originalSecondBody);
    assert.equal(JSON.stringify(secondCalls[0]).includes("root-reasoning-cipher"), true);
    assert.deepEqual(secondCalls[1].input.map((item) => item.type), [
      "message",
      "function_call",
      "custom_tool_call",
      "function_call_output",
      "custom_tool_call_output",
    ]);
    assert.deepEqual(secondCalls[1].input.map((item) => item.call_id), [
      undefined,
      "call_function",
      "call_custom",
      "call_function",
      "call_custom",
    ]);
    assert.equal(JSON.stringify(secondCalls[1]).includes("encrypted_content"), false);
    assert.equal(opened.reqContext.historyParentId, null);
    assert.equal(opened.reqContext.historyRootId, null);
    assert.strictEqual(opened.reqContext.historyInputItems, opened.reqContext.body.input);

    rememberResponseHistory(opened.reqContext, await opened.resp.json());
    const third = prepareResponsesRequest({
      model: "gpt-5.5",
      previous_response_id: "resp_clean_child",
      input: "next",
    });
    const thirdCalls = [];
    await openCopilotResponse(third, async (body) => {
      thirdCalls.push(structuredClone(body));
      return Response.json({ id: "resp_third", status: "completed", output: [] });
    });

    assert.equal(thirdCalls.length, 1);
    assert.equal(JSON.stringify(thirdCalls[0]).includes("root-reasoning-cipher"), false);
    assert.equal(JSON.stringify(thirdCalls[0]).includes("root-function-cipher"), false);
    assert.equal(JSON.stringify(thirdCalls[0]).includes("root-custom-cipher"), false);
    assert.deepEqual(
      thirdCalls[0].input
        .filter((item) => ["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(item.type))
        .map((item) => [item.type, item.call_id]),
      [
        ["function_call", "call_function"],
        ["custom_tool_call", "call_custom"],
        ["function_call_output", "call_function"],
        ["custom_tool_call_output", "call_custom"],
      ],
    );

    const oldBranch = prepareResponsesRequest({
      model: "gpt-5.5",
      previous_response_id: "resp_cipher_root",
      input: "old branch",
    });
    assert.equal(JSON.stringify(oldBranch.body).includes("root-function-cipher"), true);
    assert.equal(JSON.stringify(oldBranch.body).includes("root-custom-cipher"), true);
  } finally {
    clearResponseHistoryForTests();
  }
});

test("openCopilotResponse: history rebase waits for the final payload after an image retry", async () => {
  const currentOutput = { type: "function_call_output", call_id: "call_history", output: "visible" };
  const ctx = {
    body: {
      model: "gpt-5.5",
      tools: [{ type: "image_gen" }],
      input: [
        { type: "reasoning", encrypted_content: "history-reasoning-cipher", summary: [] },
        {
          type: "function_call",
          call_id: "call_history",
          name: "lookup",
          arguments: "{}",
          encrypted_content: "history-cipher",
        },
        currentOutput,
      ],
    },
    inputItems: [],
    currentInputStart: 2,
    historyParentId: "resp_history_parent",
    historyRootId: "resp_history_root",
    historyInputItems: [currentOutput],
  };
  const encryptedError = JSON.stringify({
    error: { message: "Encrypted function output content could not be decrypted or decoded." },
  });
  const imageError = JSON.stringify({
    error: { message: "Namespace image_gen collided with an upstream tool namespace." },
  });
  const calls = [];
  const currentInputStarts = [];

  const opened = await openCopilotResponse(ctx, async (body, options) => {
    calls.push(structuredClone(body));
    currentInputStarts.push(options.currentInputStart);
    if (calls.length === 1) return new Response(encryptedError, { status: 400 });
    if (calls.length === 2) return new Response(imageError, { status: 400 });
    return Response.json({ id: "resp_final_payload", status: "completed", output: [] });
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(currentInputStarts, [2, 1, 1]);
  assert.equal(JSON.stringify(calls[0]).includes("history-cipher"), true);
  assert.equal(JSON.stringify(calls[1]).includes("history-cipher"), false);
  assert.deepEqual(calls[1].tools, [{ type: "image_gen" }]);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[2], "tools"), false);
  assert.deepEqual(opened.reqContext.body, calls[2]);
  assert.equal(opened.reqContext.historyParentId, null);
  assert.equal(opened.reqContext.historyRootId, null);
  assert.equal(opened.reqContext.currentInputStart, 1);
  assert.strictEqual(opened.reqContext.historyInputItems, opened.reqContext.body.input);
  assert.strictEqual(opened.reqContext.inputItems, opened.reqContext.body.input);
});

test("openCopilotResponse: mixed historical and current encrypted content still rebases history", async () => {
  const ctx = {
    body: {
      model: "gpt-5.5",
      input: [
        {
          type: "function_call",
          call_id: "call_mixed",
          name: "lookup",
          arguments: "{}",
          encrypted_content: "historical-cipher",
        },
        {
          type: "function_call_output",
          call_id: "call_mixed",
          output: { type: "encrypted_content", encrypted_content: "current-cipher" },
        },
      ],
    },
    inputItems: [],
    currentInputStart: 1,
    historyParentId: "resp_mixed_parent",
    historyRootId: "resp_mixed_root",
    historyInputItems: [{
      type: "function_call_output",
      call_id: "call_mixed",
      output: { type: "encrypted_content", encrypted_content: "current-cipher" },
    }],
  };
  const exactError = JSON.stringify({
    error: { message: "Encrypted function output content could not be decrypted or decoded." },
  });
  const calls = [];

  const opened = await openCopilotResponse(ctx, async (body) => {
    calls.push(structuredClone(body));
    return calls.length === 1
      ? new Response(exactError, { status: 400 })
      : Response.json({ id: "resp_mixed_clean", status: "completed", output: [] });
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].input.map((item) => [item.type, item.call_id]), [
    ["function_call", "call_mixed"],
    ["function_call_output", "call_mixed"],
  ]);
  assert.equal(calls[1].input[1].output, ENCRYPTED_TOOL_OUTPUT_MARKER);
  assert.equal(JSON.stringify(calls[1]).includes("encrypted_content"), false);
  assert.equal(opened.reqContext.historyParentId, null);
  assert.equal(opened.reqContext.historyRootId, null);
  assert.strictEqual(opened.reqContext.historyInputItems, opened.reqContext.body.input);
});

test("openCopilotResponse: a failed encrypted retry does not rebase history", async () => {
  const currentOutput = { type: "custom_tool_call_output", call_id: "call_history", output: "visible" };
  const ctx = {
    body: {
      model: "gpt-5.5",
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_history",
          name: "shell",
          input: "pwd",
          encrypted_content: "history-cipher",
        },
        currentOutput,
      ],
    },
    inputItems: [],
    currentInputStart: 1,
    historyParentId: "resp_history_parent",
    historyRootId: "resp_history_root",
    historyInputItems: [currentOutput],
  };
  const encryptedError = JSON.stringify({
    error: { message: "Encrypted function output content could not be decrypted or decoded." },
  });
  let calls = 0;

  const opened = await openCopilotResponse(ctx, async () => {
    calls += 1;
    return new Response(encryptedError, { status: 400 });
  });

  assert.equal(calls, 2);
  assert.equal(opened.reqContext.historyParentId, "resp_history_parent");
  assert.equal(opened.reqContext.historyRootId, "resp_history_root");
  assert.notStrictEqual(opened.reqContext.historyInputItems, opened.reqContext.body.input);
});

test("openCopilotResponse: returns the second upstream error after one encrypted fallback retry", async () => {
  const encryptedError = JSON.stringify({
    error: {
      message: "The encrypted content gAAA... could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
      code: "invalid_request_body",
    },
  });
  const secondError = JSON.stringify({
    error: {
      message: "Missing required parameter: 'input[3].content[1].encrypted_content'.",
      code: "missing_required_parameter",
    },
  });
  const calls = [];
  const ctx = {
    body: {
      model: "gpt-5.5",
      store: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
        { type: "reasoning", encrypted_content: "gAAA-reasoning", summary: [] },
        { type: "function_call", id: "call_error", name: "lookup", arguments: "{}" },
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "visible", annotations: [] },
            { type: "encrypted_content", encrypted_content: "gAAA-nested" },
          ],
        },
      ],
    },
    inputItems: [],
  };
  const upstream = async (body) => {
    calls.push(body);
    return new Response(calls.length === 1 ? encryptedError : secondError, {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  };

  const opened = await openCopilotResponse(ctx, upstream);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].input[3].content[1].encrypted_content, "gAAA-nested");
  assert.deepEqual(calls[1].input.at(-1).content, [
    { type: "output_text", text: "visible", annotations: [] },
  ]);
  assert.equal(opened.resp.status, 400);
  assert.equal(opened.errorText, secondError);
});

test("openCopilotResponse: does not retry encrypted errors when nothing can be sanitized", async () => {
  const encryptedError = JSON.stringify({
    error: {
      message: "The encrypted content gAAA... could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
      code: "invalid_request_body",
    },
  });
  const calls = [];
  const ctx = {
    body: { model: "gpt-5.5", stream: false, input: [{ type: "message", role: "user", content: "hello" }] },
    inputItems: [],
  };
  const upstream = async (body) => {
    calls.push(body);
    return new Response(encryptedError, { status: 400, headers: { "Content-Type": "application/json" } });
  };

  const opened = await openCopilotResponse(ctx, upstream);

  assert.equal(calls.length, 1);
  assert.equal(opened.resp.status, 400);
  assert.equal(opened.errorText, encryptedError);
});

test("openCopilotResponse: retries an explicit image_gen namespace collision once", async () => {
  const collision = JSON.stringify({
    error: { message: "User-defined namespace 'image_gen' collides with an existing tool namespace." },
  });
  const calls = [];
  const payloadPrepared = [];
  const ctx = {
    body: {
      model: "gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: "hello" }],
      tools: [
        { type: "function", namespace: "image_gen.v2", name: "render" },
        { type: "image_gen_future", name: "future_render" },
        { type: "function", name: "lookup" },
      ],
      tool_choice: { type: "function", namespace: "image_gen.v2", name: "render" },
    },
    inputItems: [],
  };
  const upstream = async (body, requestOptions) => {
    calls.push(body);
    payloadPrepared.push(requestOptions.payloadPrepared);
    if (calls.length === 1) return new Response(collision, { status: 400 });
    return new Response(JSON.stringify({ id: "resp_ok", output: [] }), { status: 200 });
  };

  const opened = await openCopilotResponse(ctx, upstream);

  assert.equal(isImageNamespaceCollisionError(400, collision), true);
  assert.equal(opened.resp.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(payloadPrepared, [false, true]);
  assert.deepEqual(calls[1].tools, [{ type: "function", name: "lookup" }]);
  assert.equal(calls[1].tool_choice, undefined);
  const sanitized = sanitizeImageNamespaceCollisionRequest(ctx);
  assert.deepEqual(sanitized.body.tools, [{ type: "function", name: "lookup" }]);
  assert.equal(sanitized.body.tool_choice, undefined);
});

test("readJsonBody: parses gzip-compressed JSON request bodies", async () => {
  const compressed = await gzipAsync(JSON.stringify({ model: "gpt-5.5", input: "hello" }));
  const parsed = await readJsonBody(jsonRequest(compressed, "gzip"));

  assert.deepEqual(parsed, { model: "gpt-5.5", input: "hello" });
});

test("readJsonBody: marks invalid JSON and unsupported encodings as client errors", async () => {
  await assert.rejects(
    readJsonBody(jsonRequest(Buffer.from("{"))),
    (error) => error.statusCode === 400 && /Invalid JSON request body/.test(error.message),
  );
  await assert.rejects(
    readJsonBody(jsonRequest(Buffer.from("{}"), "compress")),
    (error) => error.statusCode === 415 && /Unsupported Content-Encoding/.test(error.message),
  );
});

test("readJsonBody: streams identity JSON across a split UTF-8 character", async () => {
  const encoded = Buffer.from(JSON.stringify({ input: "你好" }));
  const splitAt = encoded.indexOf(Buffer.from("你")) + 1;
  const req = Readable.from([encoded.subarray(0, splitAt), encoded.subarray(splitAt)]);
  req.headers = {};

  const parsed = await readJsonBody(req);

  assert.deepEqual(parsed, { input: "你好" });
});

test("readJsonBody: rejects raw request bodies above the configured limit", async () => {
  await assert.rejects(
    readJsonBody(jsonRequest(Buffer.from("{}"), undefined, { "content-length": "2" }), { maxBodyBytes: 1 }),
    (err) => err.statusCode === 413 && /Raw request body/.test(err.message),
  );
});

test("readJsonBody: rejects decoded request bodies above the configured limit", async () => {
  const compressed = await gzipAsync(JSON.stringify({ input: "hello" }));

  await assert.rejects(
    readJsonBody(jsonRequest(compressed, "gzip"), { maxDecodedBodyBytes: 8 }),
    (err) => err.statusCode === 413 && /Decoded request body/.test(err.message),
  );
});

test("readJsonBody: parses zstd-compressed JSON request bodies", async () => {
  assert.ok(zstdCompressAsync, "Node 22.15+ must provide built-in zstd support");
  const compressed = await zstdCompressAsync(JSON.stringify({ model: "gpt-5.5", input: "hello" }));
  const parsed = await readJsonBody(jsonRequest(compressed, "zstd"));

  assert.deepEqual(parsed, { model: "gpt-5.5", input: "hello" });
});

test("writeOrDrain: waits for drain when response backpressure is active", async () => {
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  let writes = 0;
  res.write = () => {
    writes += 1;
    return false;
  };

  const waiting = writeOrDrain(res, "chunk");
  res.emit("drain");

  assert.equal(await waiting, true);
  assert.equal(writes, 1);
});

test("forwardToChat: emits stable mixed text and tool output indexes with usage", async () => {
  const chunks = [
    { model: "gpt-4o", choices: [{ delta: { content: "hello" } }] },
    { model: "gpt-4o", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "look", arguments: "{\"q\":" } }] } }] },
    { model: "gpt-4o", choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "up", arguments: "\"x\"}" } }] } }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 7 } } },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  const events = [];
  let done = false;
  let failure = null;
  let releaseCalls = 0;

  await forwardToChat(
    { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream_options: { opaque: "keep" } },
    async (event, data) => events.push({ event, data }),
    () => { done = true; },
    (statusCode, message) => { failure = { statusCode, message }; },
    {
      chatCompletionsFn: async (request) => {
        assert.deepEqual(request.stream_options, { opaque: "keep", include_usage: true });
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      },
      releaseRequest: () => { releaseCalls += 1; },
    },
  );

  assert.equal(done, true);
  assert.equal(failure, null);
  assert.equal(releaseCalls, 1);
  const added = events.filter(({ event }) => event === "response.output_item.added");
  assert.deepEqual(added.map(({ data }) => data.output_index), [0, 1]);
  assert.deepEqual(added.map(({ data }) => data.item.type), ["message", "function_call"]);
  const completed = events.find(({ event }) => event === "response.completed").data.response;
  assert.deepEqual(completed.output.map((item) => item.type), ["message", "function_call"]);
  assert.equal(completed.output[1].name, "lookup");
  assert.equal(completed.output[1].arguments, "{\"q\":\"x\"}");
  assert.deepEqual(completed.usage, {
    input_tokens: 10,
    output_tokens: 4,
    total_tokens: 14,
    input_tokens_details: { cached_tokens: 7 },
  });
});

test("forwardToChat: preserves streaming upstream errors", async () => {
  let failure;
  await forwardToChat(
    { model: "gpt-4o", messages: [] },
    async () => {},
    () => {},
    (statusCode, message) => { failure = { statusCode, message }; },
    { chatCompletionsFn: async () => new Response("rate limited", { status: 429 }) },
  );
  assert.deepEqual(failure, { statusCode: 429, message: "rate limited" });
});

test("forwardToChat cancels upstream without an error event when downstream closes", async () => {
  let cancelled = false;
  let done = false;
  let failure = null;
  const upstream = new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"unused"}}]}\n\n'));
    },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } });

  const result = await forwardToChat(
    { model: "gpt-4o", messages: [] },
    async () => false,
    () => { done = true; },
    (statusCode, message) => { failure = { statusCode, message }; },
    { chatCompletionsFn: async () => upstream },
  );

  assert.equal(result, false);
  assert.equal(cancelled, true);
  assert.equal(done, false);
  assert.equal(failure, null);
});

test("forwardToChat: emits a completed empty message for an empty successful stream", async () => {
  const events = [];
  await forwardToChat(
    { model: "gpt-4o", messages: [] },
    async (event, data) => events.push({ event, data }),
    () => {},
    () => assert.fail("empty stream should not fail"),
    { chatCompletionsFn: async () => new Response("data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } }) },
  );

  const response = events.find(({ event }) => event === "response.completed").data.response;
  assert.equal(response.output.length, 1);
  assert.equal(response.output[0].type, "message");
  assert.equal(response.output[0].content[0].text, "");
});
