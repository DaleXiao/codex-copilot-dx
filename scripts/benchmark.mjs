#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { optimizeImagesInBody, prepareResponsesPayload } from "../src/image-optimization.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function runProbe(source) {
  const result = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", source], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `benchmark probe exited with ${result.status}`);
  }
  return JSON.parse(result.stdout.trim());
}

function deterministicPixels(byteLength, initialSeed) {
  const pixels = Buffer.alloc(byteLength);
  let seed = initialSeed;
  for (let index = 0; index < pixels.length; index += 1) {
    seed = ((seed * 1664525) + 1013904223) >>> 0;
    pixels[index] = seed >>> 24;
  }
  return pixels;
}

const adapterImport = runProbe(`
  const started = performance.now();
  await import("./src/adapter.mjs");
  globalThis.gc?.();
  const memory = process.memoryUsage();
  console.log(JSON.stringify({
    elapsed_ms: +(performance.now() - started).toFixed(1),
    rss_mib: +(memory.rss / 1048576).toFixed(1),
    heap_used_mib: +(memory.heapUsed / 1048576).toFixed(1),
  }));
`);

const tokenCount = runProbe(`
  const importStarted = performance.now();
  const { countTokens } = await import("./src/anthropic.mjs");
  const importMs = performance.now() - importStarted;
  const body = { messages: [{ role: "user", content: "a ".repeat(50000) }] };
  const firstStarted = performance.now();
  const first = await countTokens(body);
  const firstMs = performance.now() - firstStarted;
  const warmStarted = performance.now();
  const warm = await countTokens(body);
  const warmMs = performance.now() - warmStarted;
  globalThis.gc?.();
  const memory = process.memoryUsage();
  console.log(JSON.stringify({
    module_import_ms: +importMs.toFixed(1),
    first_call_ms: +firstMs.toFixed(1),
    warm_call_ms: +warmMs.toFixed(1),
    input_tokens: first.input_tokens,
    deterministic: first.input_tokens === warm.input_tokens,
    rss_mib: +(memory.rss / 1048576).toFixed(1),
  }));
`);

const repeatedImage = "data:image/png;base64,QUJDRA==";
const duplicateBody = {
  input: [{
    type: "message",
    role: "user",
    content: Array.from({ length: 8 }, () => ({ type: "input_image", image_url: repeatedImage })),
  }],
};
let duplicateCalls = 0;
const duplicateStarted = performance.now();
await optimizeImagesInBody(duplicateBody, {
  concurrency: 2,
  optimizeImage: async (value) => {
    duplicateCalls += 1;
    await delay(5);
    return value;
  },
});
const duplicateImages = {
  elapsed_ms: +(performance.now() - duplicateStarted).toFixed(1),
  image_occurrences: 8,
  optimizer_calls: duplicateCalls,
};

const pixels = deterministicPixels(1024 * 1024 * 3, 0x87654321);
const webp = await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 3 } })
  .webp({ quality: 100 })
  .toBuffer();
const payloadBody = {
  input: [{
    type: "message",
    role: "user",
    content: [{ type: "input_image", image_url: `data:image/webp;base64,${webp.toString("base64")}` }],
  }],
};
const originalLog = console.log;
const originalWarn = console.warn;
let oversizedPayload;
let profilePasses = 0;
try {
  console.log = () => {};
  console.warn = () => { profilePasses += 1; };
  const started = performance.now();
  const result = await prepareResponsesPayload(payloadBody, {
    maxBytes: 300000,
    profiles: [
      { maxDim: 800, quality: 75 },
      { maxDim: 640, quality: 65 },
    ],
  });
  oversizedPayload = {
    elapsed_ms: +(performance.now() - started).toFixed(1),
    original_image_bytes: webp.length,
    output_body_bytes: result.bodyBytes,
    profile_passes: profilePasses,
    adapted: result.adapted,
  };
} finally {
  console.log = originalLog;
  console.warn = originalWarn;
}

console.log(JSON.stringify({
  note: "Report-only benchmark; timings vary by machine and are not pass/fail thresholds.",
  adapter_import: adapterImport,
  token_count_100kb: tokenCount,
  duplicate_images: duplicateImages,
  oversized_payload: oversizedPayload,
}, null, 2));
