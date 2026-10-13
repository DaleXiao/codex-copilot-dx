// Installed official Codex, isolated synthetic accounts/provider only.
// Checks whether the header changes native history accounting, not model quality.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.CCDX_DISABLE_USAGE = "1";
globalThis.fetch = async () => { throw Error("Real provider calls are forbidden"); };
const { createAdapterHandler } = await import("../src/adapter.mjs");
const args = process.argv.slice(2);
const codex = args.length === 2 && args[0] === "--codex" ? args[1] : process.env.CCDX_CODEX_BINARY;
assert.ok(codex && path.isAbsolute(codex), "Supply --codex /absolute/path/to/codex");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-reasoning-header-"));
const environment = home => ({ PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
  CODEX_HOME: home, TMPDIR: root, LANG: "en_US.UTF-8", CCDX_DISABLE_USAGE: "1" });
async function bounded(promise, label, ms = 20000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), ms); })]); }
  finally { clearTimeout(timer); }
}

function syntheticResponse(index, compact, declaration) {
  const text = "Synthetic reasoning-header replay reply.";
  const message = { type: "message", id: `msg_${index}`, role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const reasoning = { type: "reasoning", id: `reason_${index}`, summary: [], encrypted_content: `opaque_${index}_` + "A".repeat(64 * 1024) };
  const output = compact ? [{ type: "compaction", encrypted_content: "synthetic-compaction" }] : [reasoning, message];
  const response = { id: `resp_${index}`, object: "response", model: "gpt-5.5", status: "completed", output,
    usage: { input_tokens: 1000, output_tokens: 30, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 1030 } };
  const events = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    ...output.flatMap((item, output_index) => [{ type: "response.output_item.added", output_index, item },
      ...(item.type === "message" ? [{ type: "response.output_text.delta", item_id: item.id, output_index, content_index: 0, delta: text }] : []),
      { type: "response.output_item.done", output_index, item }]),
    { type: "response.completed", response }];
  return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream", ...(declaration ? { "x-reasoning-included": declaration } : {}) } });
}

async function replay(declaration, bundled) {
  const home = path.join(root, declaration || "absent");
  await fs.mkdir(home);
  let requests = 0, compactions = 0, child, server;
  const forwarded = [];
  const pending = new Map(), events = [];
  try {
    const handler = createAdapterHandler({ getCachedModelEndpointsFn: () => ["/responses"], responsesFn: async body => {
      assert.ok(++requests <= 8, "No replay/compaction loop");
      const compact = body.input.some(item => item.type === "compaction_trigger");
      if (compact) compactions += 1;
      return syntheticResponse(requests, compact, declaration);
    } });
    server = http.createServer((req, res) => {
      const writeHead = res.writeHead;
      res.writeHead = function (status, headers) {
        forwarded.push(headers?.["X-Reasoning-Included"] || null);
        return writeHead.call(this, status, headers);
      };
      handler(req, res);
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const catalog = path.join(home, "models.json");
    await fs.writeFile(catalog, JSON.stringify(bundled));
    await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "synthetic-only" }));
    await fs.writeFile(path.join(home, "config.toml"), `model="gpt-5.5"\nmodel_provider="openai"\nopenai_base_url="http://127.0.0.1:${server.address().port}/v1"\nmodel_catalog_json=${JSON.stringify(catalog)}\nmodel_auto_compact_token_limit=100000\ncheck_for_update_on_startup=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n[features]\ncontext_management=true\nshell_snapshot=false\n`);
    child = spawn(codex, ["app-server"], { env: environment(home), cwd: home, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume();
    child.on("error", error => { for (const item of pending.values()) item.reject(error); });
    let buffer = "", id = 0;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const boundary = buffer.indexOf("\n"), raw = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        if (!raw) continue;
        const event = JSON.parse(raw);
        const request = pending.get(event.id);
        if (request) { pending.delete(event.id); event.error ? request.reject(Error(JSON.stringify(event.error))) : request.resolve(event.result); }
        else events.push(event);
      }
    });
    const call = (method, params) => bounded(new Promise((resolve, reject) => {
      const next = ++id; pending.set(next, { resolve, reject });
      child.stdin.write(JSON.stringify({ id: next, method, params }) + "\n");
    }), method);
    await call("initialize", { clientInfo: { name: "ccdx-header-replay", version: "1.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const thread = await call("thread/start", { cwd: home, model: "gpt-5.5", modelProvider: "openai", approvalPolicy: "never", sandbox: "read-only" });
    for (let turn = 0; turn < 3; turn += 1) {
      const start = events.length;
      await call("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Synthetic header test.", text_elements: [] }] });
      await bounded((async () => {
        for (;;) {
          if (child.exitCode !== null || child.signalCode !== null) throw Error("Codex exited before turn completion");
          const event = events.slice(start).find(value => value.method === "turn/completed");
          if (event) { assert.equal(event.params.turn.status, "completed", JSON.stringify(event.params.turn.error)); return; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      })(), "turn completion");
    }
    const messages = events.filter(event => event.method === "item/completed" && event.params.item.type === "agentMessage");
    assert.equal(messages.length, 3);
    assert.ok(messages.every(event => event.params.item.text === "Synthetic reasoning-header replay reply."));
    return { declaration: declaration || "absent", normal_turns: 3, automatic_compactions: compactions, provider_requests: requests,
      reasoning_declarations_forwarded: forwarded.filter(Boolean).length,
      last_usage: events.filter(event => /tokenUsage/.test(event.method || "")).at(-1)?.params.tokenUsage?.last };
  } finally {
    if (child && process.platform !== "win32") {
      try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    if (child && child.exitCode === null) {
      const exit = once(child, "exit"); child.kill("SIGTERM");
      try { await bounded(exit, "shutdown", 2000); } catch { child.kill("SIGKILL"); await bounded(exit, "forced shutdown", 2000); }
    }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
}

try {
  const version = execFileSync(codex, ["--version"], { env: environment(root), encoding: "utf8", timeout: 10000 }).trim();
  const bundled = JSON.parse(execFileSync(codex, ["debug", "models", "--bundled"], { env: environment(root), encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024 }));
  const results = [];
  for (const header of [null, "true", "false"]) results.push(await replay(header, bundled));
  assert.equal(results[1].reasoning_declarations_forwarded, results[1].provider_requests);
  assert.equal(results[0].reasoning_declarations_forwarded, 0);
  assert.equal(results[2].reasoning_declarations_forwarded, 0);
  assert.equal(results[1].automatic_compactions, results[0].automatic_compactions);
  assert.equal(results[2].automatic_compactions, results[0].automatic_compactions);
  console.log(JSON.stringify({ version, results, real_provider_calls: 0, synthetic_only: true }));
} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
