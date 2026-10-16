// Compare isolated source checkouts against the same synthetic upstream. No live
// credentials or requests are used. Usage is disabled before either import.
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";

const [baseline, candidate] = process.argv.slice(2);
assert.ok(baseline && candidate && path.isAbsolute(baseline) && path.isAbsolute(candidate),
  "Usage: node scripts/provider-differential.mjs /absolute/baseline /absolute/candidate");
process.env.CCDX_DISABLE_USAGE = "1";
globalThis.fetch = async () => { throw new Error("Live requests are forbidden in provider differential replay"); };
const imports = await Promise.all([baseline, candidate].map(async root => ({
  ...(await import(pathToFileURL(path.join(root, "test-support/adapter.mjs")).href)),
  history: await import(pathToFileURL(path.join(root, "src/response-history.mjs")).href),
  runtime: fs.existsSync(path.join(root, "src/provider-runtime.mjs"))
    ? (await import(pathToFileURL(path.join(root, "src/provider-runtime.mjs")).href)).createProviderRuntime : null,
})));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-provider-differential-"));

const fast = { id: "gpt-5.6-sol-fast", vendor: "OpenAI", policy: { state: "enabled" },
  model_picker_enabled: true, supported_endpoints: ["/responses"] };
const scenarios = [
  { name: "native-json", body: { model: "gpt-6.1-sol", input: "Unicode: 测试 😀", reasoning: { effort: "high" } } },
  { name: "native-stream", body: { model: "gpt-6.1-sol", input: "stream", stream: true } },
  { name: "native-image-coexistence", body: { model: "gpt-6-sol", input: "image", tools: [
    { type: "image_generation" }, { type: "function", name: "mcp__ccdx_image_generate_image", parameters: { type: "object" } },
  ] } },
  { name: "review", body: { model: "codex-auto-review", input: "review", service_tier: "priority",
    tools: [{ type: "function", name: "check", parameters: { type: "object" } }],
    text: { format: { type: "json_schema", name: "result", schema: { type: "object" } } } } },
  { name: "priority-alias", body: { model: "gpt-5.6-sol", input: "fast", service_tier: "priority" }, models: [fast] },
  { name: "gpt6-priority", body: { model: "gpt-6-astra", input: "tier", service_tier: "priority" } },
  { name: "chat", endpoints: ["/chat/completions"], body: { model: "gpt-chat-test", input: "chat" } },
  { name: "chat-truncation", endpoints: ["/chat/completions"], finishReason: "length",
    body: { model: "gpt-chat-test", input: "chat" } },
  { name: "unrepresentable-audio", endpoints: ["/chat/completions"], body: { model: "gpt-chat-test",
    input: [{ role: "user", content: [{ type: "input_audio", data: "synthetic" }] }] } },
  { name: "custom-tool", body: { model: "gpt-6.1-sol", input: "tool", tools: [{ type: "custom", name: "custom" }] } },
  { name: "upstream-error", error: true, body: { model: "gpt-6.1-sol", input: "invalid" } },
  { name: "compact", url: "/v1/responses/compact", body: { model: "gpt-6.1-sol", input: "compact" } },
  { name: "tool-replay", body: { model: "gpt-6.1-sol", input: [
    { type: "function_call", call_id: "call_synthetic", name: "check", arguments: "{}" },
    { type: "function_call_output", call_id: "call_synthetic", output: "retained result" },
  ] } },
];

async function run(implementation, scenario) {
  implementation.history.clearResponseHistoryForTests();
  const calls = [];
  const response = { id: `resp_${scenario.name}`, status: "completed", model: scenario.body.model,
    output: scenario.url ? [{ type: "compaction", encrypted_content: "synthetic_compaction" }]
      : [{ type: "message", id: "msg_synthetic", role: "assistant", content: [{ type: "output_text", text: "Exact output 测试" }] }],
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } };
  const upstream = kind => async body => {
    calls.push({ kind, body: structuredClone(body) });
    if (scenario.error) return Response.json({ error: { code: "invalid_argument", message: "Synthetic rejected argument" } }, { status: 400 });
    if (kind === "chat") return Response.json({ id: response.id, model: body.model, choices: [{
      message: { role: "assistant", content: "Exact output 测试" }, finish_reason: scenario.finishReason || "stop",
    }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
    if (body.stream) return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
      { headers: { "Content-Type": "text/event-stream", "x-reasoning-included": "true" } });
    return Response.json(response);
  };
  const client = { responses: upstream("responses"), responsesCompact: upstream("compact"), chatCompletions: upstream("chat"),
    getCachedModelEndpoints: () => scenario.endpoints || ["/responses"], runtimeStatus: () => ({}) };
  const registry = { models: { data: scenario.models || [] } };
  const runtime = implementation.runtime?.({ githubClient: client, githubRegistry: registry,
    githubCredentialFingerprint: "synthetic-account", home, env: { CCDX_M365: "0" }, platform: "linux" });
  let result;
  try { result = await implementation.invokeAdapter({ openAIModelEnv: {}, codexClient: client, providerRuntime: runtime, modelRegistry: registry,
    responsesFn: client.responses, responsesCompactFn: client.responsesCompact, chatCompletionsFn: client.chatCompletions,
  }, { body: structuredClone(scenario.body), url: scenario.url || "/v1/responses", headers: { session_id: "synthetic-thread" } }); }
  finally { await runtime?.close(); }
  delete result.headers["X-Request-Id"];
  try {
    const json = JSON.parse(result.text);
    if (typeof json.created_at === "number") delete json.created_at;
    if (scenario.endpoints?.includes("/chat/completions") && result.status === 200) {
      assert.match(json.id, /^resp_[a-f0-9]{32}$/);
      json.id = "resp_generated";
      for (const [index, item] of json.output.entries()) {
        assert.match(item.id, /^msg_[a-f0-9]{32}$/);
        item.id = `msg_generated_${index}`;
      }
    }
    result.text = JSON.stringify(json);
  } catch {}
  return { calls, result };
}

const log = console.log, warn = console.warn, error = console.error;
console.log = console.warn = console.error = () => {};
try {
  for (const scenario of scenarios) {
    assert.deepEqual(await run(imports[1], scenario), await run(imports[0], scenario), scenario.name);
  }
} finally { console.log = log;console.warn = warn;console.error = error;fs.rmSync(home, { recursive: true, force: true }); }
console.log(JSON.stringify({ scenarios: scenarios.map(({ name }) => name), passed: scenarios.length, live_requests: 0 }));
