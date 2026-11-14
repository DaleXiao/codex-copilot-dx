// One installed native Codex, synthetic source only: compression fallback and
// subsequent expansion. No user's profile, credentials or conversations load.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createAdapterHandler } from "../src/adapter.mjs";
import { buildCodexModelResponse } from "../src/codex-model-catalog.mjs";
import { createContextCompactionService } from "../src/context-compaction.mjs";
import { testEnvironment } from "../test/helpers/environment.mjs";

const binary = process.argv[2] === "--codex" && process.argv[3];assert.ok(binary && path.isAbsolute(binary), "Use --codex /absolute/path");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-native-compaction-")), fact = "EARLY_ASSISTANT_DECISION_RETAINED";
const env = testEnvironment(directory, { CODEX_HOME: directory, XDG_CONFIG_HOME: path.join(directory, "settings"), CCDX_DISABLE_USAGE: "1",
  HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1,localhost" });
const wait = async (promise, label, timeout = 20000) => { let timer;try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + " timed out")), timeout); })]); } finally { clearTimeout(timer); } };
let child, server, handler, sequence = 0, native = 0, summaries = 0, continuations = 0, realCalls = 0;
globalThis.fetch = async () => { realCalls++;throw Error("Live source calls forbidden"); };
const stream = text => {
  const id = "resp_replay_" + ++sequence, item = { type: "message", id: "msg_" + sequence, role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const response = { id, object: "response", model: "gpt-5.5", status: "completed", output: [item], usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } };
  return new Response([{ type: "response.created", response: { ...response, output: [], status: "in_progress" } }, { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: text }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }]
    .map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
};
const watchdog = setTimeout(() => { console.error("Native compaction replay exceeded its bounded deadline");process.exit(124); }, 90000);watchdog.unref();
try {
  const bundled = JSON.parse(execFileSync(binary, ["debug", "models", "--bundled"], { env, encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024 }));
  const registry = { models: { data: [{ id: "gpt-5.5", supported_endpoints: ["/responses"], capabilities: { limits: { max_context_window_tokens: 128000 } } }] } };
  const compaction = createContextCompactionService({ recordUsageFn() {} });
  const source = async body => {
    if (body.input.some(item => item.type === "compaction_trigger")) { native++;return Response.json({ error: { code: "unsupported_compaction" } }, { status: 400 }); }
    if (body.instructions?.startsWith("Compress the quoted")) { summaries++;assert.match(JSON.stringify(body.input), new RegExp(fact));return stream("Continuation summary: " + fact); }
    if (summaries) {
      assert.doesNotMatch(JSON.stringify(body.input), /ccdx-compaction-v1:/);assert.match(JSON.stringify(body.input), new RegExp(fact));continuations++;
      for (const text of ["FIRST_USER_REQUIREMENT", "SECOND_USER_REQUIREMENT"]) assert.equal(body.input.filter(item => item.role === "user" && JSON.stringify(item.content).includes(text)).length, 1, "Human messages must survive exactly once");
    }
    return stream(fact);
  };
  const catalog = buildCodexModelResponse({ copilotModels: registry.models, codexCatalog: bundled });
  handler = createAdapterHandler({ env, dashboardOptions: { home: directory }, openAIModelEnv: env, compaction, compactionKey: () => "a".repeat(64), modelRegistry: registry,
    getCachedModelEndpointsFn: () => ["/responses"], responsesFn: source, responsesCompactFn: async () => { native++;return new Response(null, { status: 404 }); } });
  server = http.createServer((req, res) => { if (req.method === "GET" && req.url.startsWith("/v1/models")) { res.writeHead(200, { "content-type": "application/json" });res.end(JSON.stringify(catalog)); }else handler(req, res); });
  server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  await fs.writeFile(path.join(directory, "models.json"), JSON.stringify(bundled));
  await fs.writeFile(path.join(directory, "config.toml"), `model="gpt-5.5"\nmodel_provider="openai"\nopenai_base_url="http://127.0.0.1:${server.address().port}/v1"\nmodel_catalog_json=${JSON.stringify(path.join(directory, "models.json"))}\ncheck_for_update_on_startup=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n[features]\ncontext_management=true\nshell_snapshot=false\napps=false\nplugins=false\n`);
  await fs.writeFile(path.join(directory, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "synthetic-only" }));
  child = spawn(binary, ["app-server"], { env, cwd: directory, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", next = 0, stderr = "";const pending = new Map(), events = [];
  child.stderr.on("data", value => { stderr = (stderr + value).slice(-2000); });
  child.stdout.setEncoding("utf8");child.stdout.on("data", chunk => { buffer += chunk;let boundary;while ((boundary = buffer.indexOf("\n")) >= 0) {
    const raw = buffer.slice(0, boundary);buffer = buffer.slice(boundary + 1);if (!raw) continue;const event = JSON.parse(raw);
    const callback = pending.get(event.id);if (callback) { pending.delete(event.id);event.error ? callback.reject(Error(JSON.stringify(event.error))) : callback.resolve(event.result); }else events.push(event);
  } });
  const call = (method, params) => wait(new Promise((resolve, reject) => { const id = ++next;pending.set(id, { resolve, reject });child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); }), method);
  const until = (predicate, label) => wait((async () => { for (;;) { const event = events.find(predicate);if (event) return event;await new Promise(resolve => setTimeout(resolve, 10)); } })(), label);
  await call("initialize", { clientInfo: { name: "ccdx-compaction-replay", version: "1" }, capabilities: { experimentalApi: true } });child.stdin.write('{"method":"initialized","params":{}}\n');
  const thread = await call("thread/start", { cwd: directory, model: "gpt-5.5", approvalPolicy: "never", sandbox: "read-only" }), threadId = thread.thread.id;
  const turn = async text => { const result = await call("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });const ended = await until(event => event.method === "turn/completed" && event.params.turn.id === result.turn.id, "turn");assert.equal(ended.params.turn.status, "completed", stderr + JSON.stringify(ended.params.turn.error)); };
  await turn("FIRST_USER_REQUIREMENT");await turn("SECOND_USER_REQUIREMENT");
  await call("thread/compact/start", { threadId });const compacted = await until(event => event.method === "item/completed" && event.params.item?.type === "contextCompaction", "compression");
  const completed = await until(event => event.method === "turn/completed" && event.params.turn.id === compacted.params.turnId, "compression completion");assert.equal(completed.params.turn.status, "completed", stderr + JSON.stringify(completed.params.turn.error));
  await turn("Continue from retained assistant facts");assert.equal(native, 1);assert.equal(summaries, 1);assert.equal(continuations, 1);assert.equal(realCalls, 0);
  console.log(JSON.stringify({ nativeClient: true, gatewayStateAccepted: true, humanMessagesRetainedOnce: true, assistantFactsRetained: true, nativeAttempts: native, summaryJobs: summaries, liveSourceCalls: realCalls }));
} finally {
  clearTimeout(watchdog);if (child && child.exitCode === null) { const ended = once(child, "exit");child.kill();try { await wait(ended, "shutdown", 2000); } catch { child.kill("SIGKILL");await wait(ended, "forced shutdown", 2000); } }
  handler?.dispose?.();server?.closeAllConnections();if (server?.listening) await new Promise(resolve => server.close(resolve));await fs.rm(directory, { recursive: true, force: true });
}
