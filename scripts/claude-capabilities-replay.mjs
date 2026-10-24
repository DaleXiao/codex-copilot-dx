// Installed Claude Code against a synthetic API, in a temporary home. No real
// provider, credential, user configuration, tools or model inference is used.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProviderRuntime } from "../src/provider-runtime.mjs";
import { createApiProvider } from "../src/providers/api.mjs";
import { createAdapterHandler } from "../src/adapter.mjs";
import { readClientGatewayKeys } from "../src/client-gateway-keys.mjs";
import { claudeSharedCapabilityPlan, syncClaudeCapabilities } from "../src/claude-capability-config.mjs";
import { claudeClientPaths } from "../src/claude-client-config.mjs";

const [flag, executable] = process.argv.slice(2);assert.ok(flag === "--claude" && path.isAbsolute(executable), "Use --claude /absolute/path/to/claude");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-native-capabilities-")), env = { CCDX_M365: "0" }, calls = [], stored = new Map();let handler;
const server = http.createServer((req, res) => handler(req, res));await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port, run = promisify(execFile), marker = "CCDX_NATIVE_CAPABILITIES_OK";
const runtime = createProviderRuntime({ home, env, platform: "linux", corePort: port, githubClient: {}, githubRegistry: { models: { data: [] } },
  secretStore: { get: async id => stored.get(id), set: async (id, value) => stored.set(id, value), remove: async id => stored.delete(id), close() {} },
  createApi: options => createApiProvider({ ...options, networkFactory: async () => ({ close() {}, async fetch(url, init) {
    const body = init.body ? JSON.parse(init.body) : null;
    if (!body) return Response.json({ data: [["small", 128000, 16000], ["large", 1000000, 64000]].map(([id, max_input_tokens, max_tokens]) => ({ id, type: "model", max_input_tokens, max_tokens,
      capabilities: { thinking: { supported: true }, effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true } } } })) });
    if (url.endsWith("count_tokens")) return Response.json({ input_tokens: 100 });
    calls.push({ model: body.model, max_tokens: body.max_tokens, effort: body.output_config?.effort, thinking: body.thinking?.type });
    const message = { id: "msg_replay_" + calls.length, type: "message", role: "assistant", model: body.model, content: [], usage: { input_tokens: 100, output_tokens: 1 } };
    if (!body.stream) return Response.json({ ...message, content: [{ type: "text", text: marker }], stop_reason: "end_turn" });
    const events = [{ type: "message_start", message }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: marker } }, { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" }];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } }) }) });
handler = createAdapterHandler({ providerRuntime: runtime, codexClient: {} });
try {
  const state = await runtime.manageConnections({ operation: "save_api", config: { name: "Native replay", base_url: "https://synthetic.test/v1", endpoints: { messages: "https://synthetic.test/v1/messages" }, auth_header: "bearer",
    models: ["small", "large"].map(id => ({ id, protocols: ["messages"] })) }, key: "synthetic-only", allowed: ["claude_code"] });
  const source = state.providers.find(p => !p.builtin).id, client = state.clients.find(c => c.id === "claude_code");
  await runtime.manageConnections({ operation: "client", id: "claude_code", enabled: true, allowed: client.allowed, deployments: ["small", "large"].map(model => ({ source, model })) });
  const compiled = runtime.connections().clients.find(c => c.id === "claude_code").model_plan.models;
  const models = compiled.map(model => ({ id: model.id, public_id: model.public_id, client_id: model.public_id, capability: model.capability }));
  const plan = claudeSharedCapabilityPlan({ code: models, support: { code: true } });syncClaudeCapabilities(plan, { home, env, platform: "linux" });
  const settings = JSON.parse(fs.readFileSync(claudeClientPaths({ home, env, platform: "linux" }).code));
  const isolated = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    ...settings.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/anthropic`, ANTHROPIC_AUTH_TOKEN: readClientGatewayKeys({ home, env }).claude_code,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
  for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "NODE_OPTIONS"]) delete isolated[key];
  const version = (await run(executable, ["--version"], { env: isolated, cwd: home, timeout: 15000 })).stdout.trim(), results = [];
  for (const model of models) {
    const start = calls.length, reply = await run(executable, ["--bare", "-p", `Reply with ${marker}.`, "--model", model.public_id, "--effort", "high", "--tools", "", "--no-session-persistence", "--output-format", "json", "--max-turns", "1"], { env: isolated, cwd: home, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    assert.match(reply.stdout, new RegExp(marker));const value = JSON.parse(reply.stdout), requests = calls.slice(start);
    assert.ok(requests.some(request => request.model === model.id && request.effort === "high" && request.max_tokens === model.capability.values.max_output_tokens));
    const usage = Object.values(value.modelUsage || {})[0];
    results.push({ model: model.id, declared_context: model.capability.values.context_window, client_context: usage?.contextWindow || null,
      client_output_limit: usage?.maxOutputTokens || null, configured_budget: settings.modelSettings?.[model.public_id]?.autoCompactWindow,
      requests, marker_received: true });
  }
  console.log(JSON.stringify({ version, host_context: settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, host_output: settings.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
    results, live_provider_calls: 0, tools_executed: 0 }));
} finally { handler.dispose?.();server.closeAllConnections();await new Promise(resolve => server.close(resolve));await runtime.close();fs.rmSync(home, { recursive: true, force: true }); }
