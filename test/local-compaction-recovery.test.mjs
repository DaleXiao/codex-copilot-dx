import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { recoverLocalCompaction } from "../src/local-compaction-recovery.mjs";
import { invokeAdapter } from "../test-support/adapter.mjs";
import { createResponseFailureDiagnostics } from "../src/response-failures.mjs";
import { openCopilotResponse } from "../src/copilot-responses-compat.mjs";

const id = "12345678-1234-4234-8234-123456789abc";
const other = "87654321-1234-4234-8234-123456789abc";
const message = (role, text) => ({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
const cipher = { type: "compaction", encrypted_content: "synthetic-unavailable-compaction" };
const errorText = JSON.stringify({ error: { message: "input item does not belong to this connection" } });
const history = [message("user", "Remember the earlier decision."), message("assistant", "Important earlier detail, absent from the compacted request."),
  { type: "function_call", call_id: "call_original", name: "lookup", arguments: "{}" },
  { type: "function_call_output", call_id: "call_original", output: '{"id":"original-id","status":"original-status"}' }];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-local-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "09", "07");fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-09-07T10-00-00-${id}.jsonl`);
  const rows = [{ type: "session_meta", payload: { id, source: "cli" } },
    ...history.map(payload => ({ type: "response_item", payload: structuredClone(payload) })),
    { type: "compacted", payload: { replacement_history: [structuredClone(history[0]), cipher] } }];
  const write = () => fs.writeFileSync(file, rows.map(JSON.stringify).join("\n") + "\n");write();
  const input = [structuredClone(history[0]), structuredClone(cipher), { type: "reasoning", encrypted_content: "synthetic-reasoning" }, message("user", "Continue.")];
  const context = { body: { model: "gpt-6-astra", input, stream: false, prompt_cache_key: id, client_metadata: { thread_id: id } }, surface: "responses" };
  const request = { socket: { remoteAddress: "127.0.0.1" }, headers: { host: "localhost:2026", "thread-id": id } };
  const env = { CODEX_HOME: root, XDG_CONFIG_HOME: path.join(root, "settings") };
  return { root, file, directory, rows, write, context, request, env };
}

test("verified same-thread compaction restores earlier messages/tools exactly once without changing the rollout or request", async t => {
  const f = fixture(t), before = fs.readFileSync(f.file), original = structuredClone(f.context);
  if (process.platform === "win32") {
    const stat = await fsp.lstat(f.file), handle = await fsp.open(f.file, "r");
    try { const opened = await handle.stat();t.diagnostic(JSON.stringify({ syntheticFixtureSnapshot: {
      lstat: { dev: stat.dev, ino: stat.ino, size: stat.size }, fstat: { dev: opened.dev, ino: opened.ino, size: opened.size } } })); }
    finally { await handle.close(); }
  }
  let reservations = 0, releases = 0;
  const result = await recoverLocalCompaction(f.context, { ...f, reserveHistory: async () => { reservations++;return () => { releases++; }; } });
  assert.deepEqual(result.reqContext.body.input, [...history, message("user", "Continue.")]);
  assert.deepEqual(f.context, original);assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(result.reqContext.historyParentId, null);assert.equal(result.reqContext.currentInputStart, history.length);
  assert.equal(result.recovery.compaction_items_removed, 1);assert.equal(result.recovery.reasoning_items_removed, 1);
  assert.equal(reservations, 1);assert.equal(releases, 0);result.releasePreparation();assert.equal(releases, 1);
});

test("exact archived zstd rollout and mixed-case IDs are supported without an external decoder", async t => {
  const f = fixture(t), bytes = fs.readFileSync(f.file);
  const archived = path.join(f.root, "archived_sessions");fs.mkdirSync(archived);
  const compressed = path.join(archived, path.basename(f.file) + ".zst");
  fs.writeFileSync(compressed, zstdCompressSync(bytes));fs.unlinkSync(f.file);
  f.request.headers["thread-id"] = id.toUpperCase();
  const result = await recoverLocalCompaction(f.context, f);
  assert.deepEqual(result.reqContext.body.input, [...history, message("user", "Continue.")]);
});

test("current developer instructions survive while retained user messages are not duplicated", async t => {
  const f = fixture(t), instruction = message("developer", "Current safety instructions.");
  f.context.body.input.unshift(instruction);
  const result = await recoverLocalCompaction(f.context, f);
  assert.deepEqual(result.reqContext.body.input, [...history, instruction, message("user", "Continue.")]);
});

test("file identity, compaction fingerprint and retained history must all match", async t => {
  for (const [change, code] of [
    [f => { f.rows[0].payload.id = other;f.write(); }, "rollout_identity_mismatch"],
    [f => { f.context.body.input[1].encrypted_content = "different-compaction"; }, "matching_rollout_missing"],
    [f => { f.context.body.input[0] = message("user", "A different conversation."); }, "retained_prefix_mismatch"],
    [f => { f.context.body.input.splice(1, 0, { ...history[3], output: '{"id":"altered-id","status":"original-status"}' }); }, "retained_prefix_mismatch"],
  ]) {
    const f = fixture(t);change(f);
    await assert.rejects(recoverLocalCompaction(f.context, f), error => error.code === code);
  }
});

test("remote, cross-origin and conflicting thread IDs never probe local directories", async t => {
  const f = fixture(t);t.mock.method(fsp, "opendir", () => assert.fail("must not inspect local histories"));
  for (const [request, code] of [
    [{ ...f.request, socket: { remoteAddress: "192.168.1.2" } }, "local_request_required"],
    [{ ...f.request, headers: { ...f.request.headers, origin: "https://other.test" } }, "local_request_required"],
    [{ ...f.request, headers: { ...f.request.headers, host: "other.test" } }, "local_request_required"],
    [{ ...f.request, headers: { ...f.request.headers, "thread-id": other } }, "thread_binding_conflict"],
    [{ ...f.request, headers: { ...f.request.headers, "thread-id": "../outside" } }, "thread_binding_missing"],
  ]) await assert.rejects(recoverLocalCompaction(f.context, { ...f, request }), error => error.code === code);
  await assert.rejects(recoverLocalCompaction(f.context, { ...f, env: { ...f.env, CCDX_ALLOW_LAN: "1" } }), error => error.code === "local_request_required");
});

test("missing primary thread metadata can use an exact UUID cache key, never an arbitrary path", async t => {
  const f = fixture(t);delete f.context.body.client_metadata;delete f.request.headers["thread-id"];
  assert.equal((await recoverLocalCompaction(f.context, f)).recovery.source, "local_codex_rollout");
  f.context.body.prompt_cache_key = f.file;
  await assert.rejects(recoverLocalCompaction(f.context, f), error => error.code === "thread_binding_missing");
});

test("invalid or partial records, forks, referenced pages and rollback histories fail closed", async t => {
  for (const [change, code] of [
    [f => fs.writeFileSync(f.file, '{"partial":'), "invalid_rollout"],
    [f => { f.rows[0].payload.history_base = { thread_id: id, end_ordinal_exclusive: 10 };f.write(); }, "incomplete_rollout"],
    [f => { f.rows[0].payload.forked_from_id = other;f.write(); }, "incomplete_rollout"],
    [f => { f.rows[0].ordinal = 99;f.write(); }, "incomplete_rollout"],
    [f => { f.rows.splice(2, 0, { type: "event_msg", payload: { type: "thread_rolled_back" } });f.write(); }, "unsupported_history_change"],
    [f => { f.rows.splice(1, history.length);f.write(); }, "incomplete_rollout"],
  ]) {
    const f = fixture(t);change(f);await assert.rejects(recoverLocalCompaction(f.context, f), error => error.code === code);
  }
});

test("opaque-only tools and broken call/result pairs cannot be replaced with invented text", async t => {
  for (const [change, code] of [
    [f => { f.rows[4].payload.output = [{ type: "encrypted_content", encrypted_content: "unavailable-tool-data" }];f.write(); }, "plaintext_content_missing"],
    [f => { f.rows[4].payload.call_id = "unpaired";f.write(); }, "invalid_tool_pairs"],
  ]) {
    const f = fixture(t);change(f);await assert.rejects(recoverLocalCompaction(f.context, f), error => error.code === code);
  }
});

test("literal encrypted_content text, custom tools and images retain their original values", async t => {
  const f = fixture(t);
  const custom = [{ type: "custom_tool_call", call_id: "custom", name: "edit", input: "literal encrypted_content" },
    { type: "custom_tool_call_output", call_id: "custom", output: "literal encrypted_content remains text" }];
  const image = { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AQID" }] };
  f.rows.splice(5, 0, ...[...custom, image].map(payload => ({ type: "response_item", payload })));f.write();
  const result = await recoverLocalCompaction(f.context, f);
  assert.deepEqual(result.reqContext.body.input, [...history, ...custom, image, message("user", "Continue.")]);
});

test("multiple files and multiple compactions never select a guessed source", async t => {
  const f = fixture(t);fs.copyFileSync(f.file, path.join(f.directory, `rollout-copy-${id}.jsonl`));
  await assert.rejects(recoverLocalCompaction(f.context, f), error => error.code === "ambiguous_rollout");
  f.context.body.input.push(structuredClone(cipher));
  await assert.rejects(recoverLocalCompaction(f.context, f), error => error.code === "multiple_compactions");
});

test("symlinked roots and exhausted read/decode budgets are rejected and reservations are released", async t => {
  const f = fixture(t);
  await assert.rejects(recoverLocalCompaction(f.context, { ...f, maxBytes: 10 }), error => error.code === "rollout_read_limit");
  let released = 0;
  f.context.body.input[0] = message("user", "mismatch");
  await assert.rejects(recoverLocalCompaction(f.context, { ...f, reserveHistory: async () => () => { released++; } }));
  assert.equal(released, 1);
  f.context.body.input[0] = history[0];
  fs.renameSync(path.join(f.root, "sessions"), path.join(f.root, "original-sessions"));
  fs.symlinkSync(path.join(f.root, "original-sessions"), path.join(f.root, "sessions"), "junction");
  await assert.rejects(recoverLocalCompaction(f.context, f), error => error.code === "unsafe_rollout_path");
});

test("compressed expansion and restored payload respect the byte budget, not just disk size", async t => {
  const f = fixture(t);f.rows[2].payload.content[0].text = "x".repeat(16_000);f.write();
  fs.writeFileSync(f.file + ".zst", zstdCompressSync(fs.readFileSync(f.file)));fs.unlinkSync(f.file);
  await assert.rejects(recoverLocalCompaction(f.context, { ...f, maxBytes: 4000 }), error => error.code === "rollout_read_limit");
  const g = fixture(t);g.context.body.input.at(-1).content[0].text = "x".repeat(4000);
  await assert.rejects(recoverLocalCompaction(g.context, { ...g, maxBytes: 2000 }), error => error.code === "restored_payload_limit");
});

test("large later turns need not be read when the verified compaction prefix is small", async t => {
  const f = fixture(t);fs.appendFileSync(f.file, JSON.stringify({ type: "event_msg", payload: { type: "unrelated_later_event", text: "x".repeat(100_000) } }) + "\n");
  const result = await recoverLocalCompaction(f.context, { ...f, maxBytes: 80_000 });
  assert.deepEqual(result.reqContext.body.input, [...history, message("user", "Continue.")]);
  assert.ok(result.recovery.source_bytes < fs.statSync(f.file).size);
});

test("cancellation and deadlines stop recovery without changing stored history", async t => {
  const f = fixture(t), controller = new AbortController();controller.abort(new Error("fixture cancelled"));
  await assert.rejects(recoverLocalCompaction(f.context, { ...f, signal: controller.signal }), /fixture cancelled/);
  await assert.rejects(recoverLocalCompaction(f.context, { ...f, timeoutMs: -1 }), error => error.code === "rollout_read_timeout");
});

test("overlapping recovery shares source decoding but independently validates and owns each result", async t => {
  const f = fixture(t), originalOpen = fsp.open.bind(fsp);let reads = 0;
  t.mock.method(fsp, "open", async (...args) => { if (args[0] === fs.realpathSync(f.file)) reads++;return originalOpen(...args); });
  const contexts = Array.from({ length: 8 }, () => structuredClone(f.context));
  contexts[7].body.input[0] = message("user", "wrong retained prefix");
  const results = await Promise.allSettled(contexts.map(context => recoverLocalCompaction(context, f)));
  assert.equal(reads, 1);assert.equal(results[7].reason.code, "retained_prefix_mismatch");
  for (const result of results.slice(0, 7)) assert.equal(result.status, "fulfilled");
  results[0].value.reqContext.body.input[0].content[0].text = "changed caller result";
  assert.deepEqual(results[1].value.reqContext.body.input, [...history, message("user", "Continue.")]);
  await recoverLocalCompaction(f.context, f);assert.equal(reads, 2, "successful plaintext must not remain cached");
});

test("one cancelled recovery does not cancel another waiter's shared source read", async t => {
  const f = fixture(t), originalOpen = fsp.open.bind(fsp), controller = new AbortController();
  let entered, resume;const opened = new Promise(resolve => { entered = resolve; });const gate = new Promise(resolve => { resume = resolve; });
  t.mock.method(fsp, "open", async (...args) => { entered();await gate;return originalOpen(...args); });
  const cancelled = recoverLocalCompaction(f.context, { ...f, signal: controller.signal });
  const survivor = recoverLocalCompaction(f.context, f);
  const rejected = assert.rejects(cancelled, /cancel this waiter/);
  await opened;controller.abort(new Error("cancel this waiter"));resume();
  await rejected;assert.deepEqual((await survivor).reqContext.body.input, [...history, message("user", "Continue.")]);
});

test("failure reuse is snapshot-bound, expires, and never hides newly added source files", async t => {
  const f = fixture(t), originalOpen = fsp.open.bind(fsp);let reads = 0;
  t.mock.method(fsp, "open", async (...args) => { reads++;return originalOpen(...args); });
  f.rows[0].payload.id = other;f.write();
  for (let i = 0; i < 2; i++) await assert.rejects(recoverLocalCompaction(f.context, f), error => error.code === "rollout_identity_mismatch");
  assert.equal(reads, 1);
  f.rows[0].payload.id = id;f.write();
  assert.deepEqual((await recoverLocalCompaction(f.context, f)).reqContext.body.input, [...history, message("user", "Continue.")]);
  assert.equal(reads, 2);
  f.rows[0].payload.id = other;f.write();
  await assert.rejects(recoverLocalCompaction(f.context, f));assert.equal(reads, 3);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 2500 });
  await assert.rejects(recoverLocalCompaction(f.context, f));assert.equal(reads, 4);
  t.mock.timers.reset();
  fs.unlinkSync(f.file);
  await assert.rejects(recoverLocalCompaction(f.context, f), error => error.code === "matching_rollout_missing");
  f.rows[0].payload.id = id;f.write();
  assert.equal((await recoverLocalCompaction(f.context, f)).recovery.source, "local_codex_rollout");
});

for (const mode of ["http", "json-failed", "sse-failed"]) {
  test(`${mode} recovery preserves pre-compaction facts and reports bounded metadata through the real handler`, async t => {
    const f = fixture(t), records = createResponseFailureDiagnostics();let calls = 0;
    const result = await invokeAdapter({ openAIModelEnv: f.env, responseFailures: records, getCachedModelEndpointsFn: () => ["/responses"], responsesFn: async body => {
      calls++;
      if (calls === 1) {
        if (mode === "http") return new Response(errorText, { status: 400 });
        const response = { id: "resp_failed", status: "failed", output: [], error: JSON.parse(errorText).error };
        if (mode === "json-failed") return Response.json(response);
        return new Response(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
      }
      assert.deepEqual(body.input, [...history, message("user", "Continue.")]);
      if (mode !== "sse-failed") return Response.json({ id: "resp_recovered", status: "completed", output: [] });
      const response = { id: "resp_recovered", status: "completed", output: [] };
      return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    } }, { body: { ...f.context.body, stream: mode === "sse-failed" }, headers: f.request.headers });
    assert.equal(result.status, 200);assert.equal(calls, 2);assert.match(result.text, /completed/);
    assert.equal(records.snapshot().recent[0].recovery.source, "local_codex_rollout");
    assert.doesNotMatch(JSON.stringify(records.snapshot()), /Important earlier detail|synthetic-unavailable|rollout-/);
  });
}

test("healthy and unrelated errors never read rollouts; repeated ownership errors do not loop", async t => {
  const f = fixture(t);t.mock.method(fsp, "opendir", () => assert.fail("healthy paths must not read histories"));
  for (const response of [Response.json({ id: "healthy", status: "completed", output: [] }), new Response('{"error":{"message":"Invalid model"}}', { status: 400 })]) {
    let calls = 0;
    await invokeAdapter({ openAIModelEnv: f.env, getCachedModelEndpointsFn: () => ["/responses"], responsesFn: async () => { calls++;return response; } },
      { body: f.context.body, headers: f.request.headers });
    assert.equal(calls, 1);
  }
  t.mock.restoreAll();let calls = 0;
  const result = await invokeAdapter({ openAIModelEnv: f.env, getCachedModelEndpointsFn: () => ["/responses"], responsesFn: async () => { calls++;return new Response(errorText, { status: 400 }); } },
    { body: f.context.body, headers: f.request.headers });
  assert.equal(calls, 2);assert.equal(result.status, 400);
});

test("SSE failure after visible output cannot trigger a local read or duplicate a delivered reply", async t => {
  const f = fixture(t);t.mock.method(fsp, "opendir", () => assert.fail("must not recover after visible output"));
  let calls = 0;
  const result = await invokeAdapter({ openAIModelEnv: f.env, getCachedModelEndpointsFn: () => ["/responses"], responsesFn: async () => {
    calls++;
    const events = [{ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_started", delta: "already visible" },
      { type: "response.failed", response: { id: "resp_started", status: "failed", output: [], error: JSON.parse(errorText).error } }];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  } }, { body: { ...f.context.body, stream: true }, headers: f.request.headers });
  assert.equal(calls, 1);assert.match(result.text, /already visible/);assert.match(result.text, /response.failed/);
});

test("upstream exceptions after restoration release the transferred reservation", async t => {
  const f = fixture(t);let calls = 0, releases = 0;
  await assert.rejects(openCopilotResponse(f.context, async () => { if (++calls === 1) return new Response(errorText, { status: 400 });throw new Error("fixture upstream failure"); },
    { restorePlaintextHistory: context => recoverLocalCompaction(context, { ...f, reserveHistory: async () => () => { releases++; } }) }), /fixture upstream failure/);
  assert.equal(releases, 1);assert.equal(calls, 2);
});
