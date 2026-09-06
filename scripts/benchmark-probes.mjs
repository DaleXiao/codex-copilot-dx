import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { setImmediate as immediate } from "node:timers/promises";
import sharp from "sharp";
import { proxyCopilotResponses } from "../src/responses-proxy.mjs";
import { clearResponseHistoryForTests } from "../src/response-history.mjs";
import { imageOptimizationStats, prepareResponsesPayload, resetImageOptimizationCacheForTests } from "../src/image-optimization.mjs";
import { createStreamPerformanceMetrics } from "../src/stream-performance.mjs";
import { runWithRequestContext } from "../src/request-context.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const round = (value) => +value.toFixed(3);

function nativeWire(count, deltaBytes, drifting) {
  const delta = "x".repeat(deltaBytes);
  const id = drifting ? "message_changed" : "message_initial";
  const item = { type: "message", id: "message_initial", role: "assistant", content: [] };
  const events = [
    { type: "response.output_item.added", output_index: 0, item },
    ...Array.from({ length: count }, () => ({ type: "response.output_text.delta", output_index: 0, item_id: id, delta })),
    { type: "response.completed", response: {
      id: "resp_benchmark", status: "completed",
      output: [{ ...item, id, content: [{ type: "output_text", text: delta.repeat(count) }] }],
    } },
  ];
  return Buffer.from(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
}

export async function nativeResponsesProbe() {
  process.env.CCDX_DISABLE_USAGE = "1";
  const cases = [
    { name: "stable-small", count: 5000, deltaBytes: 256 },
    { name: "drifting-small", count: 5000, deltaBytes: 256, drifting: true },
    ...[1, 4, 8].flatMap((mib) => [false, true].map((drifting) => ({
      name: `${drifting ? "drifting" : "stable"}-${mib}MiB`, count: 1, deltaBytes: mib * 1048576 - 1024, drifting,
    }))),
    { name: "slow-client", count: 5000, deltaBytes: 256, drifting: true, slow: true },
    { name: "slow-large-event", count: 1, deltaBytes: 8 * 1048576 - 1024, slow: true },
  ];
  const results = [];
  for (const scenario of cases) {
    clearResponseHistoryForTests();
    const wire = nativeWire(scenario.count, scenario.deltaBytes, scenario.drifting);
    const expectedHash = digest(nativeWire(scenario.count, scenario.deltaBytes, false));
    const outputHash = createHash("sha256");
    let offset = 0;
    let blocked = false;
    let readsWhileBlocked = 0;
    let writes = 0;
    let drains = 0;
    let cancelled = false;
    const response = new Response(new ReadableStream({
      pull(controller) {
        if (blocked) readsWhileBlocked += 1;
        if (offset === wire.length) return controller.close();
        const end = Math.min(wire.length, offset + 16 * 1024);
        controller.enqueue(wire.subarray(offset, end));
        offset = end;
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: { "Content-Type": "text/event-stream" } });
    const res = new EventEmitter();
    Object.assign(res, { destroyed: false, writableEnded: false, headersSent: false });
    res.writeHead = () => { res.headersSent = true; };
    res.end = () => { res.writableEnded = true; };
    res.write = (value) => {
      writes += 1;
      if (scenario.slow) {
        blocked = true;
        setImmediate(() => {
          // Retain the actual Buffer until drain to detect buffer reuse/corruption.
          outputHash.update(value);
          blocked = false;
          drains += 1;
          res.emit("drain");
        });
        return false;
      }
      outputHash.update(value);
      return true;
    };
    const original = { parse: JSON.parse, concat: Buffer.concat, copy: Buffer.prototype.copy, set: Buffer.prototype.set };
    let parseCalls = 0;
    let parsedBytes = 0;
    let copiedBytes = 0;
    JSON.parse = function (value, ...args) {
      parseCalls += 1;
      parsedBytes += Buffer.byteLength(value);
      return original.parse(value, ...args);
    };
    Buffer.concat = function (values, size) {
      copiedBytes += size ?? values.reduce((total, value) => total + value.length, 0);
      return original.concat(values, size);
    };
    Buffer.prototype.copy = function (...args) {
      const copied = original.copy.apply(this, args);
      copiedBytes += copied;
      return copied;
    };
    Buffer.prototype.set = function (value, offset) {
      copiedBytes += value.length;
      return original.set.call(this, value, offset);
    };
    const started = performance.now();
    let result;
    try {
      result = await proxyCopilotResponses({ body: { model: "gpt-benchmark", input: [], stream: true } }, {}, res, async () => response);
    } finally {
      JSON.parse = original.parse;
      Buffer.concat = original.concat;
      Buffer.prototype.copy = original.copy;
      Buffer.prototype.set = original.set;
      clearResponseHistoryForTests();
    }
    results.push({
      name: scenario.name, input_bytes: wire.length, expected_events: scenario.count + 2,
      parse_calls: parseCalls, parse_ratio: round(parsedBytes / wire.length), copy_ratio: round(copiedBytes / wire.length),
      writes, drains, reads_while_blocked: readsWhileBlocked, cancelled,
      content_matches: outputHash.digest("hex") === expectedHash,
      successful: result?.successful === true, elapsed_ms: round(performance.now() - started),
    });
  }
  return results;
}

export async function imageLifecycleProbe() {
  // Public-domain photograph plus a deterministic desktop-sized UI fixture.
  const photo = await sharp(fs.readFileSync(new URL("./fixtures/astronaut.jpg", import.meta.url))).png().toBuffer();
  const rows = Array.from({ length: 65 }, (_, index) => (
    `<text x="48" y="${55 + index * 23}" font-family="sans-serif" font-size="17" fill="#b8d7ef">${index}: const request = await prepareResponsesPayload(input); // screenshot benchmark</text>`
  )).join("");
  const screenshot = await sharp(Buffer.from(`<svg width="2560" height="1600"><rect width="2560" height="1600" fill="#182332"/>${rows}</svg>`)).png().toBuffer();
  const sourceUrls = [photo, screenshot].map((bytes) => `data:image/png;base64,${bytes.toString("base64")}`);
  const concurrency = 4;
  const metrics = createStreamPerformanceMetrics();
  resetImageOptimizationCacheForTests();
  const samples = [];
  let bodyBytes = 0;
  let expectedOutputHash;
  let allOutputsMatch = true;
  let workSettled = true;
  let previousHits = 0;
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    for (let iteration = 0; iteration < 6; iteration += 1) {
      const started = performance.now();
      let peakRss = process.memoryUsage().rss;
      const samplePeak = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
      const timer = setInterval(samplePeak, 5);
      let results;
      try {
        results = await Promise.all(Array.from({ length: concurrency }, async () => {
          const body = { model: "gpt-5.6-sol", input: [{ type: "message", role: "user", content:
            Array.from({ length: 6 }, (_, index) => ({ type: "input_image", image_url: sourceUrls[index % sourceUrls.length], detail: "high" })),
          }] };
          bodyBytes = Buffer.byteLength(JSON.stringify(body));
          const tracker = metrics.begin("responses");
          return runWithRequestContext({ streamPerformance: tracker }, async () => {
            try {
              const payload = await prepareResponsesPayload(body);
              samplePeak();
              return { bytes: payload.bodyBytes, hash: digest(payload.bodyText) };
            } finally {
              tracker.finish();
            }
          });
        }));
      } finally {
        clearInterval(timer);
      }
      expectedOutputHash ??= results[0].hash;
      allOutputsMatch &&= results.every((result) => result.hash === expectedOutputHash);
      await immediate();
      globalThis.gc?.();
      const memory = process.memoryUsage();
      const cache = imageOptimizationStats();
      workSettled &&= cache.active === 0 && cache.queued === 0 && cache.cache_inflight === 0;
      samples.push({
        iteration, elapsed_ms: round(performance.now() - started), peak_rss_bytes: peakRss,
        retained_rss_bytes: memory.rss, retained_heap_bytes: memory.heapUsed, retained_array_buffer_bytes: memory.arrayBuffers,
        cache_bytes: cache.cache_bytes, cache_hits_added: cache.cache_hits - previousHits, output_bytes: results[0].bytes,
      });
      previousHits = cache.cache_hits;
    }
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    resetImageOptimizationCacheForTests();
  }
  const warm = samples[1];
  const late = samples.slice(2);
  return {
    concurrency, input_bytes: bodyBytes, photo_dimensions: [512, 512], screenshot_dimensions: [2560, 1600],
    all_outputs_match: allOutputsMatch, work_settled: workSettled,
    retained_heap_growth_bytes: Math.max(0, ...late.map((sample) => sample.retained_heap_bytes - warm.retained_heap_bytes)),
    retained_array_buffer_growth_bytes: Math.max(0, ...late.map((sample) => sample.retained_array_buffer_bytes - warm.retained_array_buffer_bytes)),
    retention_budget_bytes: Math.max(8 * 1048576, bodyBytes * concurrency * 2),
    samples,
  };
}
