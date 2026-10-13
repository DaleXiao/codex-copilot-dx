// Real installed Codex, synthetic provider only. No user's history, configuration
// or credentials are loaded. This checks recorded compaction -> local recovery.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createAdapterHandler } from "../src/adapter.mjs";
import { buildCodexModelResponse } from "../src/codex-model-catalog.mjs";
import { createResponseFailureDiagnostics } from "../src/response-failures.mjs";

const args = process.argv.slice(2);
const codex = args.length === 2 && args[0] === "--codex" ? args[1] : process.env.CCDX_CODEX_BINARY;
assert.ok(codex && path.isAbsolute(codex), "Supply --codex /absolute/path/to/codex");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-native-history-replay-"));
const fact = "EARLY_SYNTHETIC_DECISION_KEEP_BLUE";
const cipher = { type: "compaction", encrypted_content: "synthetic-rejected-compaction" };
const ownership = { message: "input item does not belong to this connection", code: "" };
let sequence = 0, first = true, recoveries = 0, compactions = 0, realCalls = 0;
let child, server, handler;
globalThis.fetch = async () => { realCalls++;throw new Error("Live provider calls are forbidden"); };
const env = Object.fromEntries(Object.entries({ PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
  CODEX_HOME: root, TMPDIR: root, LANG: "en_US.UTF-8", CCDX_DISABLE_USAGE: "1", XDG_CONFIG_HOME: path.join(root, "settings") }));
const wait = async (promise, label, ms = 20_000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + " timed out")), ms); })]); }
  finally { clearTimeout(timer); }
};

function stream(text, compacted = false) {
  const id = "resp_native_" + ++sequence;
  const item = { type: "message", id: "msg_native_" + sequence, role: "assistant", phase: "final_answer", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }] };
  const output = compacted ? [cipher] : [item];
  const response = { id, object: "response", created_at: 1720000000, model: "gpt-5.5", status: "completed", output,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    ...(compacted ? [
      { type: "response.output_item.added", output_index: 0, item: cipher },
      { type: "response.output_item.done", output_index: 0, item: cipher },
    ] : [
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    ]),
    { type: "response.completed", response },
  ];
  return new Response(events.map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } });
}

try {
  const version = execFileSync(codex, ["--version"], { env, encoding: "utf8", timeout: 10_000 }).trim();
  const bundled = JSON.parse(execFileSync(codex, ["debug", "models", "--bundled"], { env, encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }));
  const models = { data: [{ id: "gpt-5.5", vendor: "OpenAI", policy: { state: "enabled" }, model_picker_enabled: true, supported_endpoints: ["/responses"] }] };
  const catalog = buildCodexModelResponse({ copilotModels: models, codexCatalog: bundled });
  const diagnostics = createResponseFailureDiagnostics();
  handler = createAdapterHandler({ openAIModelEnv: env, responseFailures: diagnostics, getCachedModelEndpointsFn: () => ["/responses"], responsesFn: async body => {
    if (body.input.some(item => item.type === "compaction_trigger")) {
      compactions++;
      if (body.stream) return stream("", true);
      return Response.json({ id: "resp_native_compacted", object: "response", status: "completed", output: [
        ...body.input.filter(item => item.type === "message" && item.role === "user"), cipher,
      ] });
    }
    if (first) { first = false;return stream(fact); }
    if (body.input.some(item => item.type === "compaction")) return Response.json({ error: ownership }, { status: 400 });
    assert.ok(JSON.stringify(body.input).includes(fact), "Pre-compaction assistant fact must survive, not just user messages");
    recoveries++;return stream("NATIVE_RECOVERY_CONFIRMED " + fact);
  } });
  server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });res.end(JSON.stringify(catalog));return;
    }
    handler(req, res);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const catalogFile = path.join(root, "models.json");await fs.writeFile(catalogFile, JSON.stringify(bundled));
  await fs.writeFile(path.join(root, "config.toml"), `model="gpt-5.5"\nmodel_provider="openai"\nopenai_base_url="${url}"\nmodel_catalog_json=${JSON.stringify(catalogFile)}\ncheck_for_update_on_startup=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n[features]\ncontext_management=true\nshell_snapshot=false\n`);
  await fs.writeFile(path.join(root, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "synthetic-only" }));
  child = spawn(codex, ["app-server"], { env, cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", next = 0, stderr = "";
  const pending = new Map(), events = [];
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
  child.stdout.setEncoding("utf8");child.stdout.on("data", chunk => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const boundary = buffer.indexOf("\n"), raw = buffer.slice(0, boundary);buffer = buffer.slice(boundary + 1);
      if (!raw) continue;
      const value = JSON.parse(raw);
      if (pending.has(value.id)) {
        const resolve = pending.get(value.id);pending.delete(value.id);resolve(value);
      } else events.push(value);
    }
  });
  const call = async (method, params) => {
    const id = ++next;
    const response = await wait(new Promise(resolve => { pending.set(id, resolve);child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); }), method);
    assert.ok(!response.error, JSON.stringify(response.error));return response.result;
  };
  const until = async (predicate, label) => wait((async () => {
    for (;;) { const value = events.find(predicate);if (value) return value;await new Promise(resolve => setTimeout(resolve, 10)); }
  })(), label);
  await call("initialize", { clientInfo: { name: "ccdx-native-history-replay", version: "1" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const configuration = await call("config/read", { includeLayers: false });
  assert.equal(configuration.config.openai_base_url, url);
  const started = await call("thread/start", { cwd: root, model: "gpt-5.5", modelProvider: "openai", approvalPolicy: "never", sandbox: "read-only" });
  const threadId = started.thread.id;
  const turn = await call("turn/start", { threadId, input: [{ type: "text", text: "Preserve the earlier decision.", text_elements: [] }] });
  const completed = await until(value => value.method === "turn/completed" && value.params.turn.id === turn.turn.id, "first turn");
  assert.equal(completed.params.turn.status, "completed", JSON.stringify(completed.params.turn.error));
  await call("thread/compact/start", { threadId });
  await until(value => value.method === "item/completed" && value.params.item?.type === "contextCompaction", "native compaction");
  const continued = await call("turn/start", { threadId, input: [{ type: "text", text: "Continue from the earlier decision.", text_elements: [] }] });
  const resumed = await until(value => value.method === "turn/completed" && value.params.turn.id === continued.turn.id, "recovered turn");
  assert.equal(resumed.params.turn.status, "completed", JSON.stringify(resumed.params.turn.error) + stderr);
  assert.equal(compactions, 1);assert.equal(recoveries, 1);assert.equal(realCalls, 0);
  assert.equal(diagnostics.snapshot().recent[0].recovery.source, "local_codex_rollout");
  console.log(JSON.stringify({ version, nativeCompactionRecorded: true, preCompactionAssistantFactRetained: true, recoveredTurnCompleted: true, recoveries, realProviderCalls: realCalls }));
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");child.kill();
    try { await wait(exited, "Codex shutdown", 2000); } catch { child.kill("SIGKILL");await wait(exited, "forced shutdown", 2000); }
  }
  handler?.cleanup?.();if (server) await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
