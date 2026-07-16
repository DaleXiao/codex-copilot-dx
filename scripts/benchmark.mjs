#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

function largePayloadProbe(targetMiB, concurrency) {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-payload-bench-"));
  const fixtureStarted = performance.now();
  try {
    const generator = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from "node:fs";
      import path from "node:path";
      import sharp from "sharp";
      const targetBytes = ${targetMiB} * 1024 * 1024;
      const requestConcurrency = ${concurrency};
      const imageCount = 8;
      const fixtureDir = ${JSON.stringify(fixtureDir)};
      const basePng = await sharp({
        create: { width: 32, height: 32, channels: 3, background: { r: 40, g: 90, b: 140 } },
      }).png().toBuffer();
      for (let requestIndex = 0; requestIndex < requestConcurrency; requestIndex += 1) {
        const approximateDataUrlBytes = Math.floor(targetBytes / imageCount);
        const rawBytes = Math.max(basePng.length, Math.floor((approximateDataUrlBytes - 32) * 3 / 4));
        const content = [];
        for (let imageIndex = 0; imageIndex < imageCount; imageIndex += 1) {
          const raw = Buffer.alloc(rawBytes, (requestIndex * imageCount + imageIndex + 1) % 251);
          basePng.copy(raw, 0);
          content.push({ type: "input_image", image_url: \`data:image/png;base64,\${raw.toString("base64")}\` });
        }
        const source = {
          model: "gpt-benchmark",
          stream: false,
          input: [{ type: "message", role: "user", content }],
        };
        fs.writeFileSync(path.join(fixtureDir, \`request-\${requestIndex}.json\`), JSON.stringify(source));
      }
    `], { cwd: packageRoot, encoding: "utf8" });
    if (generator.status !== 0) {
      throw new Error(generator.stderr.trim() || `benchmark fixture generator exited with ${generator.status}`);
    }
    const fixturePrepareMs = performance.now() - fixtureStarted;
    const fixtureFiles = Array.from({ length: concurrency }, (_, index) => path.join(fixtureDir, `request-${index}.json`));
    const result = runProbe(`
      import fs from "node:fs";
      import { prepareResponsesRequest } from "./src/adapter.mjs";
      import { readJsonBody } from "./src/http-transport.mjs";
      import { prepareResponsesPayload } from "./src/image-optimization.mjs";

      const fixtureFiles = ${JSON.stringify(fixtureFiles)};
      const memoryFields = ["rss", "heapUsed", "external", "arrayBuffers"];
      const peak = {};
      const sample = () => {
        const memory = process.memoryUsage();
        for (const field of memoryFields) peak[field] = Math.max(peak[field] || 0, memory[field] || 0);
      };
      globalThis.gc?.();
      const idleMemory = process.memoryUsage();
      for (const field of memoryFields) peak[field] = idleMemory[field] || 0;
      const timer = setInterval(sample, 5);
      timer.unref?.();

      async function processRequest(filePath) {
        const inputBytes = fs.statSync(filePath).size;
        const req = fs.createReadStream(filePath);
        req.headers = { "content-length": String(inputBytes), "content-encoding": "identity" };
        const parsed = await readJsonBody(req);
        req.destroy();
        sample();
        const prepared = prepareResponsesRequest(parsed, { mutate: true });
        const result = await prepareResponsesPayload(prepared.body);
        sample();
        return { inputBytes, outputBytes: result.bodyBytes };
      }

      const originalLog = console.log;
      const originalWarn = console.warn;
      console.log = () => {};
      console.warn = () => {};
      const started = performance.now();
      let results;
      try {
        results = await Promise.all(fixtureFiles.map(processRequest));
      } finally {
        clearInterval(timer);
        console.log = originalLog;
        console.warn = originalWarn;
      }
      sample();
      const finalMemory = process.memoryUsage();
      const mib = (bytes) => +(bytes / 1048576).toFixed(1);
      const memory = Object.fromEntries(memoryFields.map((field) => [field.replace("Used", "_used").replace("Buffers", "_buffers").toLowerCase(), {
        idle_mib: mib(idleMemory[field] || 0),
        peak_mib: mib(peak[field] || 0),
        peak_delta_mib: mib((peak[field] || 0) - (idleMemory[field] || 0)),
        final_mib: mib(finalMemory[field] || 0),
      }]));
      process.stdout.write(JSON.stringify({
        target_request_mib: ${targetMiB},
        concurrency: fixtureFiles.length,
        elapsed_ms: +(performance.now() - started).toFixed(1),
        input_body_mib: results.map((entry) => mib(entry.inputBytes)),
        output_body_mib: results.map((entry) => mib(entry.outputBytes)),
        output_body_kib: results.map((entry) => +(entry.outputBytes / 1024).toFixed(1)),
        memory,
      }));
    `);
    result.fixture_prepare_ms = +fixturePrepareMs.toFixed(1);
    return result;
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
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

const report = {
  note: "Report-only benchmark; timings vary by machine and are not pass/fail thresholds.",
  adapter_import: adapterImport,
  token_count_100kb: tokenCount,
  duplicate_images: duplicateImages,
  oversized_payload: oversizedPayload,
};

if (process.argv.includes("--large-payload")) {
  report.large_payload_peak = [
    largePayloadProbe(5, 1),
    largePayloadProbe(5, 4),
    largePayloadProbe(30, 1),
    largePayloadProbe(30, 2),
    largePayloadProbe(60, 1),
  ];
}

console.log(JSON.stringify(report, null, 2));
