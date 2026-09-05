// Optional installed-runtime regression: node scripts/codex-message-id-replay.mjs --codex /absolute/path/to/codex
// Uses synthetic SSE only. No installed configuration, credentials, or Copilot requests are used.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const codex = args.length === 2 && args[0] === "--codex"
  ? args[1]
  : args.length === 0 ? process.env.CCDX_CODEX_BINARY : null;
assert.ok(codex && path.isAbsolute(codex), "Supply --codex /absolute/path/to/codex or CCDX_CODEX_BINARY");

process.env.CCDX_DISABLE_USAGE = "1";
// The proxy receives an injected synthetic upstream. Fail closed if it ever attempts a real fetch.
globalThis.fetch = async () => { throw new Error("Network fetch is forbidden in this offline replay"); };
const { proxyCopilotResponses } = await import("../src/responses-proxy.mjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-message-id-replay-"));
const phases = ["commentary", "final_answer"];
const texts = ["SYNTHETIC COMMENTARY ONLY.", "SYNTHETIC FINAL ONLY."];
const timeoutMs = 20_000;

function runtimeEnv(home) {
  // Deliberately omit inherited credentials, provider URLs, proxies, and Codex configuration overrides.
  return Object.fromEntries(Object.entries({
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: root,
    LANG: process.env.LANG || "en_US.UTF-8",
    CODEX_HOME: home,
  }));
}

async function bounded(promise, label, milliseconds = timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function message(index, suffix, text = "", status = "in_progress") {
  return {
    id: `msg_${index}_${suffix}`,
    type: "message",
    role: "assistant",
    phase: phases[index],
    status,
    content: text ? [{ type: "output_text", text, annotations: [] }] : [],
  };
}

function syntheticStream(mode) {
  let sequence = 0;
  const events = [];
  const emit = (type, payload) => events.push(`event: ${type}\ndata: ${JSON.stringify({
    type, sequence_number: sequence++, ...payload,
  })}\n\n`);
  const response = {
    id: `resp_${mode}`,
    object: "response",
    created_at: 1720000000,
    status: "completed",
    model: "gpt-5.5",
    output: texts.map((text, index) => message(index, "B", text, "completed")),
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  emit("response.created", { response: { ...response, status: "in_progress", output: [] } });
  for (const [index, text] of texts.entries()) {
    const location = { output_index: index, content_index: 0 };
    const part = { type: "output_text", text, annotations: [] };
    emit("response.output_item.added", { output_index: index, item: message(index, "A") });
    emit("response.content_part.added", {
      ...location, item_id: `msg_${index}_A`, part: { ...part, text: "" },
    });
    emit("response.output_text.delta", { ...location, item_id: `msg_${index}_X`, delta: "SYNTHETIC " });
    emit("response.output_text.delta", { ...location, item_id: `msg_${index}_Y`, delta: text.slice(10) });
    emit("response.output_text.done", { ...location, item_id: `msg_${index}_B`, text });
    emit("response.content_part.done", { ...location, item_id: `msg_${index}_B`, part });
    emit("response.output_item.done", {
      output_index: index, item: message(index, "B", text, "completed"),
    });
  }
  emit("response.completed", { response });
  const encoder = new TextEncoder();
  let next = 0;
  return new ReadableStream({
    pull(controller) {
      if (next === events.length) controller.close();
      else controller.enqueue(encoder.encode(events[next++]));
    },
  });
}

function createClient(child) {
  const pending = new Map();
  const events = [];
  let nextId = 0;
  let buffer = "";
  let finishTurn;
  const turnCompleted = new Promise((resolve) => { finishTurn = resolve; });
  const abort = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    finishTurn({ turn: { status: "failed", error: { message: error.message } } });
  };
  child.on("error", abort);
  child.on("exit", (code, signal) => abort(new Error(`Codex exited: ${code ?? signal}`)));
  child.stdin.on("error", abort);
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const delimiter = buffer.indexOf("\n");
      if (delimiter < 0) break;
      const line = buffer.slice(0, delimiter);
      buffer = buffer.slice(delimiter + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch (error) { abort(error); continue; }
      if (pending.has(event.id)) {
        const request = pending.get(event.id);
        pending.delete(event.id);
        if (event.error) request.reject(new Error(JSON.stringify(event.error)));
        else request.resolve(event.result);
      } else if (event.method) {
        events.push(event);
        if (event.method === "turn/completed") finishTurn(event.params);
      }
    }
  });
  return {
    events,
    turnCompleted,
    notify(method) { child.stdin.write(`${JSON.stringify({ method, params: {} })}\n`); },
    call(method, params) {
      const id = ++nextId;
      return bounded(new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      }), method).finally(() => pending.delete(id));
    },
  };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  try { await bounded(exited, "Codex shutdown", 2_000); } catch {
    child.kill("SIGKILL");
    await bounded(exited, "Codex forced shutdown", 2_000);
  }
}

async function replay(mode, catalog) {
  const home = path.join(root, mode);
  await fs.mkdir(home);
  const requests = [];
  let serverError;
  let proxyResult;
  let child;
  let stderr = "";
  const server = http.createServer((req, res) => {
    (async () => {
      requests.push(`${req.method} ${req.url}`);
      if (req.method === "GET" && req.url.startsWith("/v1/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(catalog));
        return;
      }
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/responses");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(body.model, "gpt-5.5");
      assert.equal(body.stream, true);
      const upstream = new Response(syntheticStream(mode), { headers: { "Content-Type": "text/event-stream" } });
      if (mode === "direct") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for await (const chunk of upstream.body) res.write(chunk);
        res.end();
      } else {
        proxyResult = await proxyCopilotResponses({
          body, inputItems: [], historyInputItems: [], surface: "responses",
        }, req, res, async () => upstream);
      }
    })().catch((error) => {
      serverError = error;
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const overrides = {
      model: "gpt-5.5",
      model_provider: "replay",
      "model_providers.replay.name": "Offline message ID replay",
      "model_providers.replay.base_url": `http://127.0.0.1:${server.address().port}/v1`,
      "model_providers.replay.wire_api": "responses",
      "model_providers.replay.requires_openai_auth": false,
      "model_providers.replay.supports_websockets": false,
      "model_providers.replay.request_max_retries": 0,
      "model_providers.replay.stream_max_retries": 0,
      "features.shell_snapshot": false,
      "analytics.enabled": false,
      "feedback.enabled": false,
      check_for_update_on_startup: false,
    };
    child = spawn(codex, [
      ...Object.entries(overrides).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]),
      "app-server", "--stdio",
    ], { cwd: home, env: runtimeEnv(home), stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const client = createClient(child);
    await client.call("initialize", {
      clientInfo: { name: "ccdx-message-id-replay", version: "1.0" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized");
    const started = await client.call("thread/start", {
      cwd: home, model: "gpt-5.5", modelProvider: "replay",
      approvalPolicy: "never", sandbox: "read-only", experimentalRawEvents: false,
    });
    await client.call("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "Synthetic SSE replay.", text_elements: [] }],
    });
    const completed = await bounded(client.turnCompleted, "turn completion");
    if (serverError) throw serverError;
    assert.equal(completed.turn.status, "completed", JSON.stringify(completed.turn.error));
    assert.equal(requests.filter((request) => request === "POST /v1/responses").length, 1);
    if (mode === "proxy") assert.equal(proxyResult?.successful, true);
    const read = await client.call("thread/read", { threadId: started.thread.id, includeTurns: true });
    const summary = [];
    for (const [index, phase] of phases.entries()) {
      const start = client.events.filter((event) => event.method === "item/started"
        && event.params.item.type === "agentMessage" && event.params.item.phase === phase);
      const end = client.events.filter((event) => event.method === "item/completed"
        && event.params.item.type === "agentMessage" && event.params.item.phase === phase);
      assert.equal(start.length, 1, `${mode}: one ${phase} start`);
      assert.equal(end.length, 1, `${mode}: one ${phase} completion`);
      const startedId = start[0].params.item.id;
      const completedId = end[0].params.item.id;
      assert.equal(startedId, `msg_${index}_A`);
      assert.equal(completedId, `msg_${index}_${mode === "direct" ? "B" : "A"}`);
      const deltas = client.events.filter((event) => event.method === "item/agentMessage/delta"
        && event.params.itemId === startedId);
      assert.equal(deltas.map((event) => event.params.delta).join(""), texts[index]);
      assert.equal(end[0].params.item.text, texts[index]);
      const history = read.thread.turns.flatMap((turn) => turn.items)
        .filter((item) => item.type === "agentMessage" && item.phase === phase);
      assert.equal(history.length, 1, `${mode}: one ${phase} history item`);
      assert.equal(history[0].id, completedId);
      assert.equal(history[0].text, texts[index]);
      summary.push({ phase, startedId, deltaIds: deltas.map((event) => event.params.itemId), completedId, historyId: history[0].id });
    }
    assert.equal(client.events.filter((event) => event.method === "item/agentMessage/delta").length, 4);
    return { mode, requests, summary };
  } catch (error) {
    throw new Error(`${mode} replay failed: ${error.message}\n${stderr}`, { cause: error });
  } finally {
    try { await stopChild(child); } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
  }
}

try {
  const probeHome = path.join(root, "probe");
  await fs.mkdir(probeHome);
  const options = { cwd: probeHome, env: runtimeEnv(probeHome), encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] };
  const version = execFileSync(codex, ["--version"], options).trim();
  const catalog = JSON.parse(execFileSync(codex, ["debug", "models", "--bundled"], { ...options, maxBuffer: 8 * 1024 * 1024 }));
  const direct = await replay("direct", catalog);
  const proxy = await replay("proxy", catalog);
  console.log(JSON.stringify({ version, direct, proxy }, null, 2));
  console.log("PASS: installed Codex exposes drift directly and preserves commentary/final identity through CCDX.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
