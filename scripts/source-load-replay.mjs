// Synthetic loopback load only. No credentials, live inference or user files.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";

const root = process.argv[2] || path.resolve(import.meta.dirname, "..");
process.env.CCDX_DISABLE_USAGE = "1";
const load = relative => import(pathToFileURL(path.join(root, relative)).href);
const { startAdapter } = await load("src/adapter.mjs"), { closeHttpServer } = await load("src/shutdown.mjs");
const { createProviderRuntime } = await load("src/provider-runtime.mjs");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-source-load-")), streams = new Map();
let sequence = 0;
const client = { runtimeStatus: () => ({}), getCachedModelEndpoints: () => ["/responses"], responses: async body => {
  const id = `resp_load_${++sequence}`;
  return new Response(new ReadableStream({ start(controller) {
    streams.set(id, controller);controller.enqueue(Buffer.from('data: {"type":"response.output_text.delta","delta":"synthetic"}\n\n'));
  }, cancel() { streams.delete(id); } }), { headers: { "Content-Type": "text/event-stream" } });
} };
const registry = { models: { data: [] } }, runtime = createProviderRuntime({ githubClient: client, githubRegistry: registry, home, env: { CCDX_M365: "0" }, platform: "linux" });
const savedLog = console.log, savedWarn = console.warn;console.log = console.warn = () => {};
let server;
try {
  server = await startAdapter(0, "127.0.0.1", { codexClient: client, modelRegistry: registry, providerRuntime: runtime, openAIModelEnv: {}, log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`, results = [];
  for (const concurrency of [16, 64, 128]) {
    const delay = monitorEventLoopDelay({ resolution: 10 });delay.enable();
    const controllers = Array.from({ length: concurrency }, () => new AbortController());
    const responses = await Promise.all(controllers.map(controller => fetch(`${base}/v1/responses`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-load-fixture", input: "synthetic", stream: true }), signal: controller.signal })));
    assert.ok(responses.every(response => response.status === 200));
    const statusTimes = [];
    for (let sample = 0; sample < 20; sample++) {
      const started = performance.now(), response = await fetch(`${base}/_ccdx/status`, { signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200);const status = await response.json();assert.equal(status.requests.by_route.responses.active, concurrency);
      statusTimes.push(performance.now() - started);
    }
    const memory = process.memoryUsage();
    // Disconnect half the clients and finish the rest. All upstream streams
    // must release their readers; management stays responsive throughout.
    for (let i = 0; i < concurrency / 2; i++) controllers[i].abort();
    const reads = responses.map(response => response.text().catch(error => { assert.equal(error.name, "AbortError");return "cancelled"; }));
    await new Promise(resolve => setTimeout(resolve, 25));
    for (const [id, controller] of streams) {
      controller.enqueue(Buffer.from(`data: ${JSON.stringify({ type: "response.completed", response: { id, model: "gpt-load-fixture", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`));
      controller.close();streams.delete(id);
    }
    const bodies = await Promise.all(reads);assert.equal(bodies.filter(body => body === "cancelled").length, concurrency / 2);
    const deadline = Date.now() + 3000;let final;
    do {
      final = await (await fetch(`${base}/_ccdx/status`)).json();
      if (!final.requests.by_route.responses.active) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.equal(final.requests.by_route.responses.active, 0);assert.equal(streams.size, 0);
    statusTimes.sort((a, b) => a - b);delay.disable();
    results.push({ concurrency, status_p50_ms: statusTimes[10], status_p95_ms: statusTimes[19], rss_mib: memory.rss / 1048576,
      heap_mib: memory.heapUsed / 1048576, event_loop_p99_ms: delay.percentile(99) / 1e6, active_after: 0 });
  }
  savedLog(JSON.stringify({ boundary: "synthetic small-body held streams; same host; no upstream inference", results }, null, 2));
} finally {
  await runtime.close();if (server) await closeHttpServer(server);fs.rmSync(home, { recursive: true, force: true });console.log = savedLog;console.warn = savedWarn;
}
