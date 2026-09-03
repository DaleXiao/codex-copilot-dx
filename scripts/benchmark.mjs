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

function sseLinearityProbe() {
  return runProbe(`
    import { webStreamLines } from "./src/stream.mjs";

    const chunkBytes = 16 * 1024;
    const maxBufferBytes = 8 * 1024 * 1024;
    const chunk = new TextEncoder().encode("x".repeat(chunkBytes));
    const results = [];
    for (const inputMiB of [1, 2, 4, 8]) {
      const inputBytes = inputMiB * 1024 * 1024;
      let remaining = inputBytes;
      const response = {
        body: new ReadableStream({
          pull(controller) {
            if (remaining === 0) {
              controller.close();
              return;
            }
            const nextBytes = Math.min(chunk.byteLength, remaining);
            controller.enqueue(nextBytes === chunk.byteLength ? chunk : chunk.subarray(0, nextBytes));
            remaining -= nextBytes;
          },
        }, { highWaterMark: 0 }),
      };
      const originalByteLength = Buffer.byteLength;
      let byteLengthCalls = 0;
      let scannedBytes = 0;
      Buffer.byteLength = function trackedByteLength(value, ...args) {
        const bytes = originalByteLength(value, ...args);
        byteLengthCalls += 1;
        scannedBytes += bytes;
        return bytes;
      };
      let lines = 0;
      let outputBytes = 0;
      const started = performance.now();
      try {
        for await (const line of webStreamLines(response, { maxBufferBytes })) {
          lines += 1;
          outputBytes += originalByteLength(line);
        }
      } finally {
        Buffer.byteLength = originalByteLength;
      }
      results.push({
        input_mib: inputMiB,
        chunks: Math.ceil(inputBytes / chunkBytes),
        lines,
        output_bytes: outputBytes,
        byte_length_calls: byteLengthCalls,
        scanned_bytes: scannedBytes,
        scan_ratio: +(scannedBytes / inputBytes).toFixed(3),
        elapsed_ms: +(performance.now() - started).toFixed(1),
      });
    }
    process.stdout.write(JSON.stringify({ chunk_kib: chunkBytes / 1024, max_buffer_mib: 8, results }));
  `);
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
      import { createRequestAdmission, readJsonBody } from "./src/http-transport.mjs";
      import { prepareResponsesPayload } from "./src/image-optimization.mjs";

      const fixtureFiles = ${JSON.stringify(fixtureFiles)};
      const acquireRequest = createRequestAdmission();
      const memoryFields = ["rss", "heapUsed", "external", "arrayBuffers"];
      const peak = {};
      let admissionMaxActiveBytes = 0;
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
        const headers = { "content-length": String(inputBytes), "content-encoding": "identity" };
        const releaseRequest = await acquireRequest({ headers });
        admissionMaxActiveBytes = Math.max(admissionMaxActiveBytes, acquireRequest.stats().activeBytes);
        const req = fs.createReadStream(filePath);
        req.headers = headers;
        try {
          const parsed = await readJsonBody(req);
          req.destroy();
          sample();
          const prepared = prepareResponsesRequest(parsed, { mutate: true });
          const result = await prepareResponsesPayload(prepared.body);
          sample();
          return { inputBytes, outputBytes: result.bodyBytes };
        } finally {
          req.destroy();
          releaseRequest();
        }
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
        admission_max_active_mib: mib(admissionMaxActiveBytes),
        admission_budget_mib: mib(acquireRequest.stats().maxBytes),
        memory,
      }));
    `);
    result.fixture_prepare_ms = +fixturePrepareMs.toFixed(1);
    return result;
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

function toolOutputParseCacheProbe() {
  return runProbe(`
    import { enforceResponsesImageLimit } from "./src/responses-image-limit.mjs";
    import { responsesHistoricalImageStats } from "./src/responses-byte-budget.mjs";
    import { prepareResponsesChatPayload } from "./src/responses-chat-payload.mjs";

    const item = {
      type: "function_call_output",
      call_id: "call_benchmark",
      output: JSON.stringify([{ type: "input_text", text: "x".repeat(8 * 1024 * 1024) }]),
    };
    const source = item.output;
    const originalParse = JSON.parse;
    let parseCalls = 0;
    JSON.parse = function countedParse(value, ...args) {
      if (value === source) parseCalls += 1;
      return originalParse.call(this, value, ...args);
    };
    const started = performance.now();
    try {
      enforceResponsesImageLimit([item]);
      responsesHistoricalImageStats([item], 1);
      await prepareResponsesChatPayload({
        body: { model: "gpt-4o", input: [item] },
        currentInputStart: 1,
      }, { payloadOptions: { maxBytes: 30 * 1024 * 1024 } });
    } finally {
      JSON.parse = originalParse;
    }
    process.stdout.write(JSON.stringify({
      output_mib: +(Buffer.byteLength(source) / 1048576).toFixed(1),
      parse_calls: parseCalls,
      elapsed_ms: +(performance.now() - started).toFixed(1),
    }));
  `);
}

function visualHistoryPressureProbe() {
  return runProbe(`
    import { applyResponsesImagePressure } from "./src/responses-image-pressure.mjs";

    const concurrency = 4;
    const historicalImages = 36;
    const imageBytes = 256 * 1024;
    const dataUrls = Array.from({ length: historicalImages }, (_, index) => (
      \`data:image/png;base64,\${Buffer.alloc(imageBytes, index + 1).toString("base64")}\`
    ));
    const contexts = Array.from({ length: concurrency }, (_, requestIndex) => ({
      historyRootId: \`resp_benchmark_\${requestIndex}\`,
      currentInputStart: historicalImages,
      body: {
        model: "gpt-5.6-sol",
        stream: true,
        input: [
          ...dataUrls.map((imageUrl) => ({
            type: "message",
            role: "user",
            content: [{ type: "input_image", image_url: imageUrl }],
          })),
          { type: "message", role: "user", content: "continue" },
        ],
      },
    }));
    globalThis.gc?.();
    const before = process.memoryUsage();
    let peakRss = before.rss;
    let peakHeap = before.heapUsed;
    const started = performance.now();
    const results = await Promise.all(contexts.map(async (context) => {
      await Promise.resolve();
      const result = applyResponsesImagePressure(context);
      const memory = process.memoryUsage();
      peakRss = Math.max(peakRss, memory.rss);
      peakHeap = Math.max(peakHeap, memory.heapUsed);
      return result;
    }));
    const mib = (bytes) => +(bytes / 1048576).toFixed(1);
    process.stdout.write(JSON.stringify({
      concurrency,
      historical_images_per_request: historicalImages,
      elapsed_ms: +(performance.now() - started).toFixed(1),
      omitted_images: results.map((result) => result.imagesOmitted),
      retained_historical_images: results.map((result) => result.historicalImages),
      input_body_mib: results.map((result) => mib(result.initialBodyBytes)),
      output_body_mib: results.map((result) => mib(result.bodyBytes)),
      rss_peak_delta_mib: mib(peakRss - before.rss),
      heap_peak_delta_mib: mib(peakHeap - before.heapUsed),
    }));
  `);
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

const checkMode = process.argv.includes("--check");
const report = {
  note: checkMode
    ? "Relative performance and resource checks; absolute timings vary by machine."
    : "Report-only benchmark; timings vary by machine and are not pass/fail thresholds.",
  adapter_import: adapterImport,
  duplicate_images: duplicateImages,
  oversized_payload: oversizedPayload,
};

if (checkMode) {
  report.sse_linearity = sseLinearityProbe();
  report.tool_output_parse_cache = toolOutputParseCacheProbe();
  report.large_payload_peak = [
    largePayloadProbe(5, 4),
    largePayloadProbe(30, 1),
    largePayloadProbe(30, 2),
  ];
  report.visual_history_pressure_36x4 = visualHistoryPressureProbe();
} else if (process.argv.includes("--large-payload")) {
  report.large_payload_peak = [
    largePayloadProbe(5, 1),
    largePayloadProbe(5, 4),
    largePayloadProbe(30, 1),
    largePayloadProbe(30, 2),
    largePayloadProbe(60, 1),
  ];
}

console.log(JSON.stringify(report, null, 2));

if (checkMode) {
  const failures = [];
  if (report.tool_output_parse_cache.parse_calls !== 1) {
    failures.push(`stringified tool output parsed ${report.tool_output_parse_cache.parse_calls} times instead of once`);
  }
  const expectedSseSizes = [1, 2, 4, 8];
  if (report.sse_linearity.results.length !== expectedSseSizes.length
    || report.sse_linearity.results.some((sample, index) => sample.input_mib !== expectedSseSizes[index])) {
    failures.push("SSE linearity probe did not cover 1/2/4/8 MiB inputs");
  }
  for (const sample of report.sse_linearity.results) {
    const inputBytes = sample.input_mib * 1024 * 1024;
    if (sample.lines !== 1 || sample.output_bytes !== inputBytes) {
      failures.push(`SSE parser changed the ${sample.input_mib}MiB fragmented line`);
    }
    if (sample.scanned_bytes > inputBytes * 1.01 || sample.byte_length_calls > sample.chunks + 1) {
      failures.push(`SSE parser scan complexity is not linear at ${sample.input_mib}MiB`);
    }
  }
  for (const payload of report.large_payload_peak) {
    if (payload.admission_max_active_mib > payload.admission_budget_mib) {
      failures.push(`request admission exceeded its budget at ${payload.target_request_mib}MiB x${payload.concurrency}`);
    }
  }
  const visualHistory = report.visual_history_pressure_36x4;
  if (!visualHistory.omitted_images.every((count) => count === 20)
    || !visualHistory.retained_historical_images.every((count) => count === 16)
    || !visualHistory.output_body_mib.every((size, index) => size < visualHistory.input_body_mib[index])) {
    failures.push("36-image x4 visual history pressure did not preserve the expected 16-image upstream window");
  }
  if (failures.length) {
    for (const failure of failures) console.error(`[FAIL] ${failure}`);
    process.exitCode = 1;
  } else {
    console.error("[OK] Performance and resource checks passed");
  }
}
