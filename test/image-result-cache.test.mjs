import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import {
  createAbortAwareSingleflight,
  createBoundedResultCache,
  createByteLruCache,
} from "../src/bounded-result-cache.mjs";
import {
  imageOptimizationStats,
  optimizeImageDataUrl,
  resetImageOptimizationCacheForTests,
} from "../src/image-optimization.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function randomPngDataUrl(seed = 0x12345678) {
  const pixels = Buffer.alloc(256 * 256 * 3);
  let state = seed;
  for (let index = 0; index < pixels.length; index += 1) {
    state = ((state * 1664525) + 1013904223) >>> 0;
    pixels[index] = state >>> 24;
  }
  const png = await sharp(pixels, { raw: { width: 256, height: 256, channels: 3 } })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

test("image result cache honors its process byte-limit configuration", () => {
  const moduleUrl = new URL("../src/image-optimization.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { imageOptimizationStats } from ${JSON.stringify(moduleUrl)}; process.stdout.write(String(imageOptimizationStats().cache_max_bytes));`,
  ], {
    encoding: "utf8",
    env: { ...process.env, CCDX_IMG_CACHE_MAX_BYTES: "1234" },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "1234");
});

test("byte LRU has an exact byte ceiling and evicts the least-recently-used result", () => {
  const cache = createByteLruCache({ maxBytes: 12 });
  assert.equal(cache.set("a", "1111"), true);
  assert.equal(cache.set("b", "2222"), true);
  assert.equal(cache.get("a"), "1111");
  assert.equal(cache.set("c", "33"), true);

  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), "1111");
  assert.equal(cache.get("c"), "33");
  assert.deepEqual(cache.stats(), {
    entries: 2,
    bytes: 8,
    max_bytes: 12,
    hits: 3,
    misses: 1,
    evictions: 1,
  });
  assert.equal(cache.set("oversized", "x".repeat(20)), false);
  assert.ok(cache.stats().bytes <= cache.stats().max_bytes);
});

test("byte LRU keeps an existing value when an oversized replacement is rejected", () => {
  const cache = createByteLruCache({ maxBytes: 12 });
  assert.equal(cache.set("key", "value"), true);
  assert.equal(cache.set("key", "x".repeat(20)), false);
  assert.equal(cache.get("key"), "value");
});

test("bounded result cache makes a completed hit bypass producer work", async () => {
  const results = createBoundedResultCache({ maxBytes: 1024 });
  let producerCalls = 0;
  const first = await results.getOrCreate("same-transform", async () => {
    producerCalls += 1;
    return "data:image/webp;base64,Zmlyc3Q=";
  });
  const second = await results.getOrCreate("same-transform", async () => {
    producerCalls += 1;
    throw new Error("cache hit must bypass this producer");
  });

  assert.equal(second, first);
  assert.equal(producerCalls, 1);
  assert.equal(results.stats().hits, 1);
  assert.equal(results.stats().inflight, 0);
});

test("bounded result cache never retains a failed producer result", async () => {
  const results = createBoundedResultCache({ maxBytes: 1024 });
  let producerCalls = 0;
  await assert.rejects(results.getOrCreate("failed-transform", async () => {
    producerCalls += 1;
    throw new Error("encode failed");
  }), /encode failed/);
  assert.equal(results.stats().entries, 0);

  assert.equal(await results.getOrCreate("failed-transform", async () => {
    producerCalls += 1;
    return "recovered";
  }), "recovered");
  assert.equal(producerCalls, 2);
});

test("bounded result cache singleflights concurrent work for the same transform", async () => {
  const results = createBoundedResultCache({ maxBytes: 1024 });
  const gate = deferred();
  let producerCalls = 0;
  const createValue = async () => {
    producerCalls += 1;
    return gate.promise;
  };
  const first = results.getOrCreate("same-transform", createValue);
  const second = results.getOrCreate("same-transform", createValue);
  await Promise.resolve();

  assert.equal(results.stats().inflight, 1);
  assert.equal(producerCalls, 1);
  gate.resolve("data:image/webp;base64,c2hhcmVk");
  assert.deepEqual(await Promise.all([first, second]), [
    "data:image/webp;base64,c2hhcmVk",
    "data:image/webp;base64,c2hhcmVk",
  ]);
  assert.equal(results.stats().entries, 1);
  assert.equal(results.stats().inflight, 0);
});

test("singleflight rejects one aborted waiter without cancelling another", async () => {
  const results = createBoundedResultCache({ maxBytes: 1024 });
  const gate = deferred();
  const cancelled = new AbortController();
  let sharedSignal;
  let producerCalls = 0;
  const createValue = async (signal) => {
    producerCalls += 1;
    sharedSignal = signal;
    return gate.promise;
  };
  const first = results.getOrCreate("same-transform", createValue, { signal: cancelled.signal });
  const second = results.getOrCreate("same-transform", createValue);
  await Promise.resolve();
  cancelled.abort();

  await assert.rejects(first, { name: "AbortError" });
  assert.equal(sharedSignal.aborted, false);
  assert.equal(results.stats().inflight, 1);
  gate.resolve("data:image/webp;base64,c3Vydml2b3I=");
  assert.equal(await second, "data:image/webp;base64,c3Vydml2b3I=");
  assert.equal(producerCalls, 1);
  assert.equal(results.stats().entries, 1);
});

test("singleflight aborts an orphaned task and permits a fresh flight", async () => {
  const singleflight = createAbortAwareSingleflight();
  const cancelled = new AbortController();
  let sharedSignal;
  const orphaned = singleflight.run("image", async (signal) => {
    sharedSignal = signal;
    await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }, { signal: cancelled.signal });
  await Promise.resolve();
  cancelled.abort();

  await assert.rejects(orphaned, { name: "AbortError" });
  assert.equal(sharedSignal.aborted, true);
  assert.equal(await singleflight.run("image", async () => "fresh"), "fresh");
});

test("concurrent image callers share one real encode for the same source and transform", async () => {
  resetImageOptimizationCacheForTests();
  const input = await randomPngDataUrl(0x87654321);
  const originalLog = console.log;
  const logs = [];
  console.log = (message) => logs.push(message);
  try {
    const pending = Array.from({ length: 3 }, () => (
      optimizeImageDataUrl(input, { quality: 82, model: "gpt-5.6-sol" })
    ));
    assert.equal(imageOptimizationStats().cache_inflight, 1);
    const outputs = await Promise.all(pending);
    assert.equal(new Set(outputs).size, 1);
    assert.equal(logs.filter((line) => String(line).includes("image/png ->")).length, 1);
  } finally {
    console.log = originalLog;
  }
  assert.equal(imageOptimizationStats().cache_inflight, 0);
});

test("image cache isolates q82, q75, and q65 and reuses each completed result", async () => {
  resetImageOptimizationCacheForTests();
  const input = await randomPngDataUrl();
  const profiles = [
    { quality: 82 },
    { quality: 75, force: true },
    { quality: 65, force: true },
  ];
  const originalLog = console.log;
  console.log = () => {};
  try {
    const outputs = await Promise.all(profiles.map((profile) => (
      optimizeImageDataUrl(input, { ...profile, model: "gpt-5.6-sol" })
    )));
    assert.equal(new Set(outputs).size, 3);
    assert.ok(outputs.every((output) => output.startsWith("data:image/webp;base64,")));
    const beforeHits = imageOptimizationStats().cache_hits;
    const repeated = await Promise.all(profiles.map((profile) => (
      optimizeImageDataUrl(input, { ...profile, model: "gpt-5.6-sol" })
    )));
    assert.deepEqual(repeated, outputs);
    assert.equal(imageOptimizationStats().cache_hits - beforeHits, 3);
  } finally {
    console.log = originalLog;
  }

  const stats = imageOptimizationStats();
  assert.ok(stats.cache_entries >= 6);
  assert.ok(stats.cache_bytes > 0);
  assert.ok(stats.cache_bytes <= stats.cache_max_bytes);
  assert.equal(stats.cache_inflight, 0);
  assert.equal(stats.limit, 2);
});

test("an image decode failure falls back without poisoning the result cache", async () => {
  resetImageOptimizationCacheForTests();
  const invalid = "data:image/png;base64,AAAA";
  assert.equal(await optimizeImageDataUrl(invalid), invalid);
  assert.equal(await optimizeImageDataUrl(invalid), invalid);
  const stats = imageOptimizationStats();
  assert.equal(stats.cache_entries, 0);
  assert.equal(stats.cache_misses, 2);
});

test("a cached no-op under one model constraint cannot skip a stricter resize", async () => {
  resetImageOptimizationCacheForTests();
  const png = await sharp({
    create: { width: 1800, height: 1800, channels: 3, background: "white" },
  }).png().toBuffer();
  assert.ok(png.length < 100000);
  const input = `data:image/png;base64,${png.toString("base64")}`;

  const originalLog = console.log;
  console.log = () => {};
  let output;
  try {
    assert.equal(await optimizeImageDataUrl(input, { model: "unknown-model" }), input);
    output = await optimizeImageDataUrl(input, { model: "gpt-4o" });
  } finally {
    console.log = originalLog;
  }
  assert.match(output, /^data:image\/webp;base64,/);
  const metadata = await sharp(Buffer.from(output.split(",", 2)[1], "base64")).metadata();
  assert.ok(Math.min(metadata.width, metadata.height) <= 768);
});
