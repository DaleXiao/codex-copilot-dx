import { test } from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import * as zlib from "node:zlib";
import {
  abortErrorStatusCode,
  createRequestAbort,
  isAbortLikeError,
  readJsonBody,
  writeOrDrain,
} from "../src/http-transport.mjs";
import { createRequestAdmission } from "../src/request-admission.mjs";

const gzipAsync = promisify(zlib.gzip);
const zstdCompressAsync = zlib.zstdCompress ? promisify(zlib.zstdCompress) : null;

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
