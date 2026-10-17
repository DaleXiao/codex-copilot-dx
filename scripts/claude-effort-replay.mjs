// Real Claude Code against an isolated candidate gateway and synthetic upstream.
// No provider credential, live inference, user configuration or tool execution.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createM365Provider } from "../src/providers/m365.mjs";
import http from "node:http";
import { createAdapterHandler } from "../src/adapter.mjs";
import { createProviderRuntime } from "../src/provider-runtime.mjs";
process.env.CCDX_DISABLE_USAGE = "1";
async function startSharedGateway(provider) {
  let handler;
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve, reject) => { server.once("error", reject);server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  const runtime = createProviderRuntime({ corePort: port, home, env: {}, platform: "darwin", githubClient: {},
    createM365: () => provider, configureClients: () => ({ code: "configured", app: "configured" }) });
  handler = createAdapterHandler({ providerRuntime: runtime, codexClient: {} });
  try { await runtime.start(); }
  catch (error) { await runtime.close();server.closeAllConnections();await new Promise(resolve => server.close(resolve));throw error; }
  const state = runtime.snapshot();
  assert.equal(state.m365.claude.port, port);assert.equal(state.m365.claude.base_url, `http://127.0.0.1:${port}/anthropic`);
  // Use the real generated local key, kept entirely inside this isolated home.
  const { ensureM365GatewayKey } = await import("../src/m365-settings.mjs");
  const localKey = ensureM365GatewayKey({ home, env: {} });
  const models = await fetch(`${state.m365.claude.base_url}/v1/models?limit=1000`, { headers: { "x-api-key": localKey } });
  assert.equal(models.status, 200);assert.equal((await models.json()).data[0].id, "claude-opus-5-5");
  return { port, key: localKey, close: async () => { await runtime.close();server.closeAllConnections();await new Promise(resolve => server.close(resolve)); } };
}

const [flag, executable] = process.argv.slice(2);
assert.ok(flag === "--claude" && path.isAbsolute(executable), "Use --claude /absolute/path/to/claude");
const run = promisify(execFile), home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-claude-replay-"));
const calls = [], marker = "CCDX_CAPABILITY_OK";
const model = { id: "claude-opus-5.5", publisher: "Anthropic", supported_endpoints: ["/v1/messages"],
  capabilities: { supports: { reasoning_effort: ["low", "medium", "high", "xhigh", "max"] } } };
const provider = createM365Provider({ home, log() {}, auth: {
  getToken: async () => ({ token: "synthetic", account: { id: "test", tenant: "test", login: "test@example.test" } }), snapshot: () => ({}), reset() {},
}, fetchImpl: async (url, options) => {
  if (options.method === "GET") return Response.json({ data: [model] });
  if (url.endsWith("count_tokens")) return Response.json({ input_tokens: 100 });
  const body = JSON.parse(options.body);calls.push({ model: body.model, effort: body.output_config?.effort });
  const message = { id: "msg_replay", type: "message", role: "assistant", model: model.id, content: [], stop_reason: null,
    usage: { input_tokens: 100, output_tokens: 1 } };
  if (!body.stream) return Response.json({ ...message, content: [{ type: "text", text: marker }], stop_reason: "end_turn" });
  const events = [{ type: "message_start", message }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: marker } }, { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }, { type: "message_stop" }];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
let gateway;
try {
  await provider.refresh();
  gateway = await startSharedGateway(provider);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${gateway.port}/anthropic`, ANTHROPIC_AUTH_TOKEN: gateway.key,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1", CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
  delete env.ANTHROPIC_API_KEY;delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const version = (await run(executable, ["--version"], { env, cwd: home, timeout: 15000 })).stdout.trim();
  const results = [];
  for (const effort of ["low", "high"]) {
    const start = calls.length;
    const result = await run(executable, ["--bare", "-p", `Reply with ${marker}.`, "--model", "claude-opus-5-5", "--effort", effort,
      "--tools", "", "--no-session-persistence", "--output-format", "json", "--max-turns", "1"], { env, cwd: home, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    assert.match(result.stdout, new RegExp(marker));
    const requests = calls.slice(start);assert.ok(requests.some(call => call.model === model.id && call.effort === effort), JSON.stringify(requests));
    results.push({ effort, matched: true, upstream_requests: requests.length });
  }
  console.log(JSON.stringify({ version, results, live_provider_calls: 0 }));
} finally { await gateway?.close();provider.close();fs.rmSync(home, { recursive: true, force: true }); }
