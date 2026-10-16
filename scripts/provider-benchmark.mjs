// Optional paired loopback benchmark. Both revisions receive the same synthetic
// native Responses traffic; only the candidate enables its real provider runtime.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const [mode, ...args] = process.argv.slice(2);
if (mode !== "--worker") {
  const roots = [mode, args[0]];
  assert.ok(roots.every(root => root && path.isAbsolute(root)), "Supply baseline and candidate absolute directories");
  const runs = [[], []];
  for (let round = 0; round < 4; round++) for (const which of round % 2 ? [1, 0] : [0, 1]) {
    const raw = execFileSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--worker", roots[which]],
      { env: { ...process.env, CCDX_DISABLE_USAGE: "1", CCDX_M365: "0" }, timeout: 60000, encoding: "utf8", maxBuffer: 1024 * 1024 });
    runs[which].push(JSON.parse(raw));
  }
  const median = values => { const sorted = [...values].sort((a, b) => a - b);return (sorted[1] + sorted[2]) / 2; };
  const summary = runs.map(list => Object.fromEntries(["requests_per_second", "p50_ms", "p95_ms", "heap_mib", "rss_mib"].map(key => [key, +median(list.map(run => run[key])).toFixed(3)])));
  console.log(JSON.stringify({ boundary: "same-host loopback; no live inference; candidate provider runtime enabled", runs, baseline: summary[0], candidate: summary[1],
    throughput_percent: +((summary[1].requests_per_second / summary[0].requests_per_second - 1) * 100).toFixed(2) }, null, 2));
  process.exit(0);
}

const root = args[0];assert.ok(root && path.isAbsolute(root));
const load = relative => import(pathToFileURL(path.join(root, relative)).href);
const { startAdapter } = await load("src/adapter.mjs");
const { closeHttpServer } = await load("src/shutdown.mjs");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-provider-bench-"));
let sequence = 0;
const client = { getCachedModelEndpoints: () => ["/responses"], runtimeStatus: () => ({}), responses: async body => {
  const response = { id: `resp_${++sequence}`, status: "completed", model: body.model,
    output: [{ type: "message", id: `msg_${sequence}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "synthetic response" }] }],
    usage: { input_tokens: 1000, output_tokens: 4, total_tokens: 1004 } };
  return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "synthetic response" })}\n\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
    { headers: { "Content-Type": "text/event-stream" } });
} };
const registry = { models: { data: [] } };
const runtime = fs.existsSync(path.join(root, "src/provider-runtime.mjs"))
  ? (await load("src/provider-runtime.mjs")).createProviderRuntime({ githubClient: client, githubRegistry: registry,
    githubCredentialFingerprint: "benchmark-account", home, env: { CCDX_M365: "0" }, platform: "linux" }) : null;
const savedLog = console.log;console.log = console.warn = () => {};
const server = await startAdapter(0, "127.0.0.1", { codexClient: client, modelRegistry: registry, providerRuntime: runtime,
  terminalActivity: null, openAIModelEnv: {}, log: () => {} });
const url = `http://127.0.0.1:${server.address().port}/v1/responses`;
const body = JSON.stringify({ model: "gpt-6-sol", stream: true, input: [{ role: "user", content: "Synthetic request context. ".repeat(300) }] });
const samples = [];
async function request(measured) {
  const start = performance.now();
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", session_id: "benchmark-thread" }, body });
  assert.equal(response.status, 200);assert.match(await response.text(), /response.completed/);
  if (measured) samples.push(performance.now() - start);
}
try {
  for (let i = 0; i < 20; i++) await Promise.all(Array.from({ length: 8 }, () => request(false)));
  const started = performance.now();
  for (let i = 0; i < 100; i++) await Promise.all(Array.from({ length: 8 }, () => request(true)));
  const elapsed = performance.now() - started;samples.sort((a, b) => a - b);global.gc?.();
  const memory = process.memoryUsage();
  savedLog(JSON.stringify({ requests: samples.length, requests_per_second: samples.length * 1000 / elapsed,
    p50_ms: samples[Math.floor(samples.length * .5)], p95_ms: samples[Math.floor(samples.length * .95)],
    heap_mib: memory.heapUsed / 1048576, rss_mib: memory.rss / 1048576 }));
} finally { await closeHttpServer(server);await runtime?.close();fs.rmSync(home, { recursive: true, force: true }); }
