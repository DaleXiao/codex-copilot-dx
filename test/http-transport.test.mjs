import { test } from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { PassThrough, Readable } from "node:stream";
import { EventEmitter } from "node:events";
import * as zlib from "node:zlib";
import {
  abortErrorStatusCode,
  createRequestAbort,
  isAbortLikeError,
  logRequestFailure,
  readJsonBody,
  writeOrDrain,
} from "../src/http-transport.mjs";
import { runWithRequestContext } from "../src/request-context.mjs";
import { createRequestAdmission } from "../src/request-admission.mjs";

const gzipAsync = promisify(zlib.gzip);
const zstdCompressAsync = zlib.zstdCompress ? promisify(zlib.zstdCompress) : null;

test("client cancellations are informational while timeouts and transport failures remain notices", t => {
  const info = t.mock.method(console, "log", () => {}), warn = t.mock.method(console, "warn", () => {}), error = t.mock.method(console, "error", () => {});
  for (const reason of ["client_aborted", "client_closed"]) {
    const err = Object.assign(new Error("cancelled"), { name: "AbortError" });
    logRequestFailure("Models", err, { reason });assert.equal(err.statusCode, 499);
  }
  assert.equal(info.mock.calls.length, 2);assert.equal(warn.mock.calls.length, 0);
  const timeout = Object.assign(new Error("timeout"), { name: "AbortError" });
  logRequestFailure("Models", timeout, { reason: "upstream_timeout" });
  assert.equal(warn.mock.calls.length, 1);assert.equal(timeout.statusCode, 504);
  logRequestFailure("Models", new Error("connection failed"));assert.equal(error.mock.calls.length, 1);
});

function jsonRequest(body, contentEncoding, headers = {}) {
  const req = Readable.from([body]);
  req.headers = { ...headers };
  if (contentEncoding) req.headers["content-encoding"] = contentEncoding;
  return req;
}

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

test("a larger shared upload budget leaves the supplemental pools unchanged", async () => {
  const gate = createRequestAdmission({ maxBytes: 64, maxSupplementalBytes: 32 });
  const slot = await gate({ headers: { "content-length": "55" } });
  const decoded = await slot.reserveDecodedBody(55), history = await slot.reserveResponseHistory(55);
  assert.equal(gate.diagnostics().activeBytes, 55);
  assert.equal(decoded.maxWeight, 32);assert.equal(decoded.weight, 32);
  assert.equal(history.maxWeight, 32);assert.equal(history.weight, 32);
  slot();assert.equal(gate.diagnostics().activeBytes, 0);assert.equal(gate.diagnostics().decodedBodyAdmissionBytes, 0);assert.equal(gate.diagnostics().responseHistoryBytes, 0);
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

test("readJsonBody: large identity bodies preserve UTF-8 and mismatched content lengths", async () => {
  const source = { input: `${"x".repeat(1024 * 1024)}你好` };
  const encoded = Buffer.from(JSON.stringify(source));
  const splitAt = encoded.indexOf(Buffer.from("你")) + 1;
  for (const declaredBytes of [encoded.length, encoded.length - 1, encoded.length + 1]) {
    const req = Readable.from([encoded.subarray(0, splitAt), encoded.subarray(splitAt)]);
    req.headers = { "content-length": String(declaredBytes) };
    assert.deepEqual(await readJsonBody(req), source);
  }
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


test("body queue retains the request and its reason when an exclusive waiter delays a small upload", async () => {
  const acquire = createRequestAdmission({ maxBytes: 16 });
  const request = bytes => ({ headers: bytes === undefined ? { authorization: "private fixture" } : { "content-length": String(bytes) } });
  const active = await acquire(request(4));
  const exclusive = acquire(request());
  const requestId = "50000000-0000-4000-8000-000000000022";
  let contextEvidence;
  const next = runWithRequestContext({ requestId, route: "antigravity", streamPerformance: { observeContext(value) { contextEvidence = value.body_queue; } } }, () => acquire(request(2)));
  assert.equal(acquire.diagnostics().recentWaits.length, 0, "immediate admissions leave no queued sample");
  active();const releaseExclusive = await exclusive;
  assert.equal(acquire.stats().queued, 1, "the older exclusive request keeps its turn");
  releaseExclusive();const releaseNext = await next;releaseNext();
  const { recentWaits, longestWait, waitMsMax } = acquire.diagnostics();
  assert.equal(recentWaits[0].reason, "body_budget");assert.equal(recentWaits[0].length_known, false);
  const queued = recentWaits[1];assert.equal(queued.request_id, requestId);assert.equal(queued.route, "antigravity");
  assert.equal(queued.reason, "exclusive_waiter");assert.equal(queued.requested_bytes, 2);assert.equal(queued.active_bytes, 4);
  assert.equal(queued.outcome, "admitted");assert.deepEqual(contextEvidence, queued);
  assert.equal(longestWait.wait_ms, waitMsMax);assert.doesNotMatch(JSON.stringify(recentWaits), /private fixture/);
});

test("a chunked upload can start and finish while a small previous request still holds memory", async () => {
  const gate = createRequestAdmission({ maxBytes: 32 });
  const hold = await gate({ headers: { "content-length": "4" } });
  const req = jsonRequest(Buffer.from('{"ok":true}'), undefined, { "transfer-encoding": "chunked" });
  const pending = gate(req, { streamingBody: true });
  try {
    assert.equal(gate.stats().queued, 0, "unknown length must not wait for an empty pool");
    const lease = await pending;
    try {
      assert.equal(gate.stats().activeBytes, 5);
      assert.deepEqual(await readJsonBody(req, { admission: lease }), { ok: true });
      assert.equal(gate.stats().activeBytes, 15, "keep only the actual body reservation after upload");
    } finally { lease(); }
  } finally { hold();(await pending)(); }
  assert.equal(gate.stats().activeBytes, 0);
});

test("an incomplete upload grows first when memory returns and the next unknown upload waits to start", async () => {
  const gate = createRequestAdmission({ maxBytes: 16 });
  const previous = await gate({ headers: { "content-length": "12" } });
  const req = new PassThrough();req.headers = { "transfer-encoding": "chunked" };
  const lease = await gate(req, { streamingBody: true });
  const read = readJsonBody(req, { admission: lease });
  const next = gate({ headers: {} }, { streamingBody: true });
  req.write('{"a"');
  await new Promise(setImmediate);
  assert.equal(gate.stats().activeBytes, 16, "charge bytes already read rather than the whole request cap");
  req.end(':true}');
  await new Promise(setImmediate);
  assert.equal(gate.diagnostics().uploadWaitingForMemory, true);
  assert.equal(req.isPaused(), true);
  const small = gate({ headers: { "content-length": "7" } });
  assert.equal(gate.stats().queued, 2);
  previous();
  assert.deepEqual(await read, { a: true });
  const nextLease = await next;
  assert.equal(gate.stats().activeBytes, 11);
  assert.equal(gate.stats().queued, 1, "the large admission cannot take a growing upload's next allocation");
  nextLease();lease();
  const smallLease = await small;
  smallLease();
  assert.equal(gate.stats().activeBytes, 0);
  assert.equal(gate.diagnostics().uploadWaitingForMemory, false);
});

test("cancelling an upload blocked on growth releases the partial reservation and admits the next request", async () => {
  const gate = createRequestAdmission({ maxBytes: 16 });
  const previous = await gate({ headers: { "content-length": "8" } });
  const req = new PassThrough();req.headers = { "transfer-encoding": "chunked" };
  const controller = new AbortController();
  const lease = await gate(req, { streamingBody: true, signal: controller.signal });
  const reading = readJsonBody(req, { admission: lease, signal: controller.signal }).finally(() => lease());
  req.write('{"a":"');req.write('longer text');
  await new Promise(setImmediate);
  assert.equal(gate.diagnostics().uploadWaitingForMemory, true);
  const next = gate({ headers: {} }, { streamingBody: true });
  controller.abort(new Error("cancel upload"));
  await assert.rejects(reading, /cancel upload/);
  const nextLease = await next;
  assert.equal(gate.stats().activeBytes, 9);assert.equal(gate.diagnostics().uploadWaitingForMemory, false);
  nextLease();previous();req.destroy();assert.equal(gate.stats().activeBytes, 0);
});

test("unknown-length JSON and gzip keep the per-request caps and the independent decoded pool", async () => {
  const gate = createRequestAdmission({ maxBytes: 32, maxSupplementalBytes: 16 });
  const raw = Buffer.from(JSON.stringify({ value: "x".repeat(130) }));
  const gzip = zlib.gzipSync(raw);
  for (const [body, encoding, maxBodyBytes, maxDecodedBodyBytes, message] of [
    [raw, undefined, 64, 256, /Raw request body/],
    [gzip, "gzip", 128, 64, /Decoded request body/],
  ]) {
    const req = jsonRequest(body, encoding, { "transfer-encoding": "chunked" });
    const lease = await gate(req, { streamingBody: true });
    try { await assert.rejects(readJsonBody(req, { admission: lease, maxBodyBytes, maxDecodedBodyBytes }), { statusCode: 413, message }); }
    finally { lease(); }
    assert.equal(gate.stats().activeBytes, 0);assert.equal(gate.diagnostics().decodedBodiesActive, 0);
  }
  const req = jsonRequest(gzip, "gzip", { "transfer-encoding": "chunked" });
  const lease = await gate(req, { streamingBody: true });
  try {
    assert.deepEqual(await readJsonBody(req, { admission: lease, maxBodyBytes: 128, maxDecodedBodyBytes: 256 }), JSON.parse(raw));
    const diag = gate.diagnostics();assert.equal(diag.activeBytes, Math.min(gzip.length, 32));assert.equal(diag.decodedBodyAdmissionBytes, 16);
    assert.equal(diag.decodedBodyBytes, raw.length);
  } finally { lease(); }
  assert.equal(gate.stats().activeBytes, 0);assert.equal(gate.diagnostics().decodedBodiesActive, 0);
});
