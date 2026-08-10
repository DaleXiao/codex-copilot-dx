import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { createRequestAdmission, readJsonBody } from "../src/http-transport.mjs";

const gzipAsync = promisify(zlib.gzip);
const zstdCompressAsync = zlib.zstdCompress ? promisify(zlib.zstdCompress) : null;

function jsonRequest(body, encoding = "gzip") {
  const req = Readable.from([body]);
  req.headers = {
    "content-encoding": encoding,
    "content-length": String(body.length),
  };
  return req;
}

async function compressedRequest(value) {
  const raw = Buffer.from(JSON.stringify(value));
  return { raw, compressed: await gzipAsync(raw) };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("compressed body admission keeps fitting ordinary requests concurrent", async () => {
  const value = {
    input: Array.from(
      { length: 300 },
      (_, index) => `${index.toString(36)}-${(Math.imul(index, 2654435761) >>> 0).toString(36)}`,
    ),
  };
  const { raw, compressed } = await compressedRequest(value);
  assert.ok(compressed.length * 4 > raw.length);

  const acquire = createRequestAdmission({ maxBytes: 16 * 1024, maxQueued: 2, waitTimeoutMs: 1000 });
  const firstAdmission = await acquire(jsonRequest(compressed));
  const first = await readJsonBody(jsonRequest(compressed), { admission: firstAdmission });
  const secondAdmission = await acquire(jsonRequest(compressed));
  const second = await readJsonBody(jsonRequest(compressed), { admission: secondAdmission });

  assert.deepEqual(first, value);
  assert.deepEqual(second, value);
  assert.equal(acquire.diagnostics().decodedBodyBytes, raw.length * 2);
  assert.equal(acquire.diagnostics().decodedBodiesActive, 2);
  firstAdmission();
  secondAdmission();
  assert.equal(acquire.diagnostics().decodedBodyBytes, 0);
});

test("compressed bodies preserve the legacy decoded-admission release contract", async () => {
  const { raw, compressed } = await compressedRequest({ input: "legacy admission" });
  const reserved = [];
  let releases = 0;
  const admission = {
    acquireDecompression: async () => () => {},
    reserveDecodedBody: async (bytes) => {
      reserved.push(bytes);
      return () => { releases += 1; };
    },
  };

  const parsed = await readJsonBody(jsonRequest(compressed), { admission });

  assert.equal(parsed.input, "legacy admission");
  assert.deepEqual(reserved, [raw.length]);
  assert.equal(releases, 0);
});

test("high-compression retry waits for exclusive decoded budget and aborts cleanly", async () => {
  const { raw, compressed } = await compressedRequest({ input: "x".repeat(700) });
  assert.ok(raw.length > compressed.length * 4);

  const acquire = createRequestAdmission({ maxBytes: 1024, maxQueued: 2, waitTimeoutMs: 1000 });
  const firstAdmission = await acquire(jsonRequest(compressed));
  await readJsonBody(jsonRequest(compressed), { admission: firstAdmission, maxDecodedBodyBytes: 4096 });
  assert.equal(acquire.diagnostics().decodedBodyBytes, raw.length);

  const secondAdmission = await acquire(jsonRequest(compressed));
  const controller = new AbortController();
  const second = readJsonBody(jsonRequest(compressed), {
    admission: secondAdmission,
    maxDecodedBodyBytes: 4096,
    signal: controller.signal,
  });
  await waitFor(
    () => acquire.diagnostics().decodedBodiesQueued === 1,
    "high-compression request did not wait for exclusive decoded budget",
  );
  assert.equal(acquire.diagnostics().decodedBodyBytes, raw.length);
  assert.equal(acquire.diagnostics().decompressionsActive, 0);

  const releaseProbe = await secondAdmission.acquireDecompression({ signal: controller.signal });
  assert.equal(acquire.diagnostics().decompressionsActive, 1);
  releaseProbe();
  assert.equal(acquire.diagnostics().decompressionsActive, 0);

  controller.abort();
  await assert.rejects(second, (error) => error.name === "AbortError");
  assert.equal(acquire.diagnostics().decodedBodiesQueued, 0);
  assert.equal(acquire.diagnostics().decodedBodyBytes, raw.length);
  assert.equal(acquire.diagnostics().decompressionsActive, 0);
  secondAdmission();
  firstAdmission();
});

test("exclusive decoded waiters enforce the queue limit for later small reservations", async () => {
  const acquire = createRequestAdmission({ maxBytes: 1024, maxQueued: 2, waitTimeoutMs: 1000 });
  const admission = await acquire({ headers: { "content-length": "1" } });
  const held = await admission.reserveDecodedBody(1);
  const exclusiveController = new AbortController();
  const smallController = new AbortController();
  const exclusive = admission.reserveDecodedBody(2048, { signal: exclusiveController.signal });
  const small = admission.reserveDecodedBody(1, { signal: smallController.signal });

  await waitFor(
    () => acquire.diagnostics().decodedBodiesQueued === 2,
    "exclusive writer barrier did not queue both reservations",
  );
  await assert.rejects(
    admission.reserveDecodedBody(1),
    (error) => error.statusCode === 503 && /queue is full/.test(error.message),
  );
  assert.equal(acquire.diagnostics().decodedBodiesQueued, 2);

  smallController.abort();
  await assert.rejects(small, (error) => error.name === "AbortError");
  exclusiveController.abort();
  await assert.rejects(exclusive, (error) => error.name === "AbortError");
  held();
  admission();
  assert.equal(acquire.diagnostics().decodedBodiesQueued, 0);
  assert.equal(acquire.diagnostics().decodedBodyBytes, 0);
});

test("decoded bodies larger than the pool run exclusively without an unbudgeted waiter", async () => {
  const { raw, compressed } = await compressedRequest({ input: "x".repeat(2000) });
  assert.ok(raw.length > 1024);

  const acquire = createRequestAdmission({ maxBytes: 1024, maxQueued: 2, waitTimeoutMs: 1000 });
  const firstAdmission = await acquire(jsonRequest(compressed));
  await readJsonBody(jsonRequest(compressed), { admission: firstAdmission, maxDecodedBodyBytes: 4096 });
  assert.equal(acquire.diagnostics().decodedBodyBytes, raw.length);
  assert.equal(acquire.diagnostics().decodedBodyAdmissionBytes, 1024);

  const secondAdmission = await acquire(jsonRequest(compressed));
  let secondFinished = false;
  const second = readJsonBody(jsonRequest(compressed), {
    admission: secondAdmission,
    maxDecodedBodyBytes: 4096,
  }).then((result) => {
    secondFinished = true;
    return result;
  });
  await waitFor(
    () => acquire.diagnostics().decodedBodiesQueued === 1,
    "second large body did not wait for decoded budget",
  );
  assert.equal(secondFinished, false);
  assert.equal(acquire.diagnostics().decodedBodyBytes, raw.length);
  assert.equal(acquire.diagnostics().decodedBodyAdmissionBytes, 1024);

  firstAdmission();
  const parsed = await second;
  assert.equal(parsed.input.length, 2000);
  assert.equal(acquire.diagnostics().decodedBodyBytes, raw.length);
  assert.equal(acquire.diagnostics().decodedBodyAdmissionBytes, 1024);
  secondAdmission();
  assert.equal(acquire.diagnostics().decodedBodyBytes, 0);
});

test("an already-exclusive estimate records decoded bytes above its estimate", async () => {
  const incompressiblePrefix = Array.from(
    { length: 100 },
    (_, index) => `${index.toString(36)}-${(Math.imul(index, 2654435761) >>> 0).toString(36)}`,
  ).join("|");
  const { raw, compressed } = await compressedRequest({
    input: `${incompressiblePrefix}${"x".repeat(4000)}`,
  });
  assert.ok(compressed.length * 4 >= 1024);
  assert.ok(raw.length > compressed.length * 4);

  const acquire = createRequestAdmission({ maxBytes: 1024, maxQueued: 2, waitTimeoutMs: 1000 });
  const admission = await acquire(jsonRequest(compressed));
  const parsed = await readJsonBody(jsonRequest(compressed), {
    admission,
    maxDecodedBodyBytes: 8192,
  });

  assert.equal(parsed.input.length, incompressiblePrefix.length + 4000);
  assert.equal(acquire.diagnostics().decodedBodyBytes, raw.length);
  assert.equal(acquire.diagnostics().decodedBodyAdmissionBytes, 1024);
  admission();
});

test("zstd high-compression bodies retry under exclusive decoded admission", {
  skip: !zstdCompressAsync,
}, async () => {
  const raw = Buffer.from(JSON.stringify({ input: "x".repeat(2000) }));
  const compressed = await zstdCompressAsync(raw);
  assert.ok(raw.length > compressed.length * 4);

  const acquire = createRequestAdmission({ maxBytes: 1024, maxQueued: 2, waitTimeoutMs: 1000 });
  const admission = await acquire(jsonRequest(compressed, "zstd"));
  const parsed = await readJsonBody(jsonRequest(compressed, "zstd"), {
    admission,
    maxDecodedBodyBytes: 4096,
  });

  assert.equal(parsed.input.length, 2000);
  assert.equal(acquire.diagnostics().decodedBodyBytes, raw.length);
  assert.equal(acquire.diagnostics().decodedBodyAdmissionBytes, 1024);
  admission();
});

test("compressed decode and JSON errors release tentative decoded reservations", async () => {
  const acquire = createRequestAdmission({ maxBytes: 1024, maxQueued: 2, waitTimeoutMs: 1000 });
  const empty = await gzipAsync(Buffer.alloc(0));
  const emptyAdmission = await acquire(jsonRequest(empty));
  await assert.rejects(
    readJsonBody(jsonRequest(empty), { admission: emptyAdmission }),
    (error) => error.statusCode === 400 && /Invalid JSON/.test(error.message),
  );
  assert.equal(acquire.diagnostics().decodedBodyBytes, 0);
  assert.equal(acquire.diagnostics().decompressionsActive, 0);
  emptyAdmission();

  const invalidJson = await gzipAsync(Buffer.from("{"));
  const invalidAdmission = await acquire(jsonRequest(invalidJson));
  await assert.rejects(
    readJsonBody(jsonRequest(invalidJson), { admission: invalidAdmission }),
    (error) => error.statusCode === 400 && /Invalid JSON/.test(error.message),
  );
  assert.equal(acquire.diagnostics().decodedBodyBytes, 0);
  assert.equal(acquire.diagnostics().decompressionsActive, 0);
  invalidAdmission();

  const oversized = await compressedRequest({ input: "x".repeat(2000) });
  const oversizedAdmission = await acquire(jsonRequest(oversized.compressed));
  await assert.rejects(
    readJsonBody(jsonRequest(oversized.compressed), {
      admission: oversizedAdmission,
      maxDecodedBodyBytes: 512,
    }),
    (error) => error.statusCode === 413,
  );
  assert.equal(acquire.diagnostics().decodedBodyBytes, 0);
  assert.equal(acquire.diagnostics().decompressionsActive, 0);
  oversizedAdmission();
});
