import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConversationSourceGuard } from "../src/conversation-source-guard.mjs";
import { createMessagesHistoryTransfer, messagesTransferPath } from "../src/messages-history-transfer.mjs";
import { createM365ConversationGuard } from "../src/providers/m365-conversation-accounts.mjs";
import { startClaudeGateway } from "../src/claude-gateway.mjs";
import { execFileSync } from "node:child_process";

const user = content => ({ role: "user", content });
const body = () => ({ model: "model-two", max_tokens: 32, messages: [user("Remember PRIVATE-ALPHA"),
  { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE-THOUGHT", signature: "PRIVATE-SIGNATURE" }, { type: "text", text: "ALPHA" }] }, user("Continue")],
  tools: [{ name: "read", input_schema: { type: "object" } }], thinking: { type: "adaptive" } });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-messages-transfer-")), options = { home, env: {} }, headers = { "x-conversation-id": "synthetic-session" };
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let guard, transfer;
  const restart = () => { guard = createConversationSourceGuard(options);transfer = createMessagesHistoryTransfer(options); };restart();
  const prepare = (profile, value, extra = {}) => guard(extra.client || "generic-native-client", profile, value, headers, "a".repeat(64),
    extra.strict ? undefined : { profiles: extra.profiles || ["source-one", "source-two", "target-profile"], prepare: input => transfer.prepare({ ...input, countTokens: extra.count === true }) });
  const seed = prepare("source-one", { model: "one", messages: [user("Remember PRIVATE-ALPHA")] });seed?.commit();seed?.release();
  return { options, headers, file: messagesTransferPath(options), prepare, restart };
}
test("Messages transfer preserves original history, tools and new-source thinking across restart and return", t => {
  const f = fixture(t), input = body(), original = structuredClone(input), plan = f.prepare("source-two", input);
  assert.deepEqual(input.messages[1].content, [{ type: "text", text: "ALPHA" }]);assert.deepEqual(input.tools, original.tools);assert.deepEqual(input.thinking, original.thinking);
  assert.equal(fs.existsSync(f.file), false);plan.commit();plan.release();
  const saved = fs.readFileSync(f.file, "utf8");assert(!/PRIVATE|source-two|synthetic-session/.test(saved));assert.equal(Object.keys(JSON.parse(saved).records).length, 1);
  f.restart();
  const next = structuredClone(original);next.messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "new", signature: "new-source-signature" }, { type: "text", text: "BETA" }] }, user("Again"));
  const continued = f.prepare("source-two", next);assert.equal(next.messages[1].content.length, 1);assert.equal(next.messages[3].content[0].signature, "new-source-signature");continued.commit();continued.release();
  assert.equal(fs.readFileSync(f.file, "utf8"), saved);
  const back = structuredClone(original);back.messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "new", signature: "new-source-signature" }, { type: "text", text: "BETA" }] }, user("Back"));
  const returned = f.prepare("source-one", back);assert.equal(back.messages[3].content.length, 1);returned.commit();returned.release();
  assert.deepEqual(original, body(), "Client-owned history was not changed");
});
test("model validation, token counts and failed pre-output requests never commit a transfer", t => {
  const f = fixture(t), probe = () => ({ model: "two", messages: [user("Check")], max_tokens: 1 });
  f.prepare("source-two", probe()).release();assert.equal(fs.existsSync(f.file), false);
  f.prepare("source-two", body(), { count: true }).release();assert.equal(fs.existsSync(f.file), false);
  f.prepare("source-two", body()).release();assert.equal(fs.existsSync(f.file), false);
  const actual = f.prepare("source-two", body());actual.commit();actual.release();const saved = fs.readFileSync(f.file, "utf8");
  const validation = f.prepare("source-two", probe());validation.commit?.();validation.release();f.prepare("source-one", body(), { count: true }).release();
  f.prepare("source-one", body()).release();assert.equal(fs.readFileSync(f.file, "utf8"), saved);
  f.restart();assert.doesNotThrow(() => { const p = f.prepare("source-two", body());p.release(); });
});
test("complete tool pairs stay native; active tools, dangling results and concurrent source changes are rejected", t => {
  const f = fixture(t), value = body();value.messages.splice(2, 0,
    { role: "assistant", content: [{ type: "tool_use", id: "call-one", name: "read", input: { file_id: "ordinary-tool-argument" } }] },
    user([{ type: "tool_result", tool_use_id: "call-one", content: [{ type: "text", text: "FILE" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }]),
    { role: "assistant", content: "Done" });
  const raw = structuredClone(value), before = structuredClone(value.messages.slice(2)), plan = f.prepare("source-two", value);assert.deepEqual(value.messages.slice(2), before);
  assert.throws(() => f.prepare("source-one", body()), { code: "ccdx_history_transfer_busy" });plan.commit();plan.release();
  const tool = structuredClone(raw);tool.messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "keep", signature: "own-signature" }, { type: "tool_use", id: "call-two", name: "read", input: {} }] }, user([{ type: "tool_result", tool_use_id: "call-two", content: "MORE" }]));
  const own = f.prepare("source-two", tool);assert.equal(tool.messages.at(-2).content[0].signature, "own-signature");own.release();
  assert.throws(() => f.prepare("source-one", tool), { code: "ccdx_history_transfer_tool_incomplete" });
  const dangling = body();dangling.messages[2].content = [{ type: "tool_result", tool_use_id: "absent", content: "FAIL" }];
  assert.throws(() => f.prepare("source-one", dangling), { code: "ccdx_history_transfer_tool_incomplete" });
});
test("source-owned content and corrupt metadata fail without modifying stored history", t => {
  const f = fixture(t);
  for (const change of [value => { value.container = "remote-container"; }, value => { value.messages[0].content = [{ type: "document", source: { type: "file", file_id: "remote-file" } }]; }]) {
    const value = body();change(value);assert.throws(() => f.prepare("source-two", value), { code: "ccdx_history_transfer_rebuild_required" });
  }
  const invalid = body();invalid.messages[0].content = [{ type: "compaction", encrypted_content: "opaque" }];
  assert.throws(() => f.prepare("source-two", invalid));assert.equal(fs.existsSync(f.file), false);
  fs.writeFileSync(f.file, "{broken");f.restart();assert.throws(() => f.prepare("source-two", body()), { code: "ccdx_history_transfer_state_invalid" });assert.equal(fs.readFileSync(f.file, "utf8"), "{broken");
});
test("M365 accepts a matching prepared transfer but retains known-account and ungranted-history isolation", t => {
  const f = fixture(t), account = { id: "one", tenant: "tenant", login: "one@example.test", history_isolation: true };
  const guard = createM365ConversationGuard(f.options), value = body();
  assert.throws(() => guard(account, value, f.headers), { code: "m365_account_changed" });
  const plan = f.prepare("target-profile", value);
  assert.throws(() => guard(account, value, f.headers, { profile: "wrong-profile" }), { code: "m365_account_changed" });
  guard(account, value, f.headers, { profile: "target-profile" });plan.commit();plan.release();
  const another = { ...account, id: "two" }, changed = body(), next = f.prepare("another-profile", changed);
  assert.throws(() => guard(another, changed, f.headers, { profile: "another-profile" }), { code: "m365_account_changed" });next.release();
});
test("clients without the transfer policy retain their original source guard", t => {
  const f = fixture(t), value = { model: "one", input: [{ role: "user", content: "A" }, { role: "assistant", content: "B" }] };
  f.prepare("codex-one", value, { client: "codex", strict: true });
  assert.throws(() => f.prepare("codex-two", value, { client: "codex", strict: true }), { code: "ccdx_conversation_source_changed" });
  assert.equal(fs.existsSync(f.file), false);
});

test("protocol-equivalent history forms preserve an ongoing tool turn without a source change", t => {
  const f = fixture(t), original = body(), first = f.prepare("source-two", structuredClone(original));first.commit();first.release();f.restart();
  const next = structuredClone(original);next.messages[0].content = [{ text: next.messages[0].content, type: "text" }];
  next.messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "keep", signature: "own" }, { type: "tool_use", id: "current", name: "read", input: {} }] },
    user([{ type: "tool_result", tool_use_id: "current", content: "done" }]));
  const plan = f.prepare("source-two", next);assert.equal(next.messages.at(-2).content[0].signature, "own");plan.commit();plan.release();
});

test("adjacent Messages turns may be combined without losing the migrated prefix boundary", t => {
  const f = fixture(t), original = { model: "two", messages: [user("alpha"), user("beta")] };
  const first = f.prepare("source-two", original);first.commit();first.release();f.restart();
  const combined = { model: "two", messages: [user([{ type: "text", text: "alpha" }, { type: "text", text: "beta" }]),
    { role: "assistant", content: [{ type: "thinking", thinking: "keep", signature: "own" }, { type: "tool_use", id: "current", name: "read", input: {} }] },
    user([{ type: "tool_result", tool_use_id: "current", content: "done" }])] };
  const plan = f.prepare("source-two", combined);assert.equal(combined.messages[1].content[0].signature, "own");plan.release();
});

test("legacy checkpoints upgrade at a proved prefix and remain readable after rollback", t => {
  const f = fixture(t), original = body(), first = f.prepare("source-two", structuredClone(original));first.commit();first.release();
  const canonicalFile = path.join(path.dirname(f.file), "conversation-prefixes.json");fs.unlinkSync(canonicalFile);f.restart();
  const next = structuredClone(original);next.messages[0].content = [{ type: "text", text: next.messages[0].content }];
  next.messages.push({ role: "assistant", content: [{ type: "thinking", signature: "own", thinking: "keep" }, { type: "tool_use", id: "current", name: "read", input: {} }] }, user([{ type: "tool_result", tool_use_id: "current", content: "done" }]));
  const plan = f.prepare("source-two", next);assert.equal(next.messages.at(-2).content[0].signature, "own");plan.commit();plan.release();assert(fs.existsSync(canonicalFile));
  for (const record of Object.values(JSON.parse(fs.readFileSync(f.file)).records)) assert.deepEqual(Object.keys(record).sort(), ["count", "owner", "prefix"]);
  const raw = JSON.parse(fs.readFileSync(f.file));Object.values(raw.records)[0].prefix = "f".repeat(64);fs.writeFileSync(f.file, JSON.stringify(raw));f.restart();
  assert.throws(() => f.prepare("source-two", next), error => error.jsonBody?.error?.reason === "prefix_changed_active_tool_turn");
});

test("protocol normalization never ignores tool argument changes or user text whitespace", t => {
  const f = fixture(t), original = body();original.messages.splice(2, 0,
    { role: "assistant", content: [{ type: "tool_use", id: "old", name: "read", input: { cache_control: "user-data" } }] },
    user([{ type: "tool_result", tool_use_id: "old", content: "old" }]), { role: "assistant", content: "Done" });
  const first = f.prepare("source-two", structuredClone(original));first.commit();first.release();
  for (const edit of [value => { value.messages[2].content[0].input.cache_control = "changed"; }, value => { value.messages[0].content += " "; }]) {
    const changed = structuredClone(original);edit(changed);changed.messages.push({ role: "assistant", content: [{ type: "tool_use", id: "current", name: "read", input: {} }] }, user([{ type: "tool_result", tool_use_id: "current", content: "done" }]));
    assert.throws(() => f.prepare("source-two", changed), error => error.jsonBody?.error?.reason === "prefix_changed_active_tool_turn");
  }
});

test("an active transfer plan does not retain the admitted request body", t => {
  const f = fixture(t), moduleUrl = new URL("../src/messages-history-transfer.mjs", import.meta.url).href;
  execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
    import { createMessagesHistoryTransfer } from ${JSON.stringify(moduleUrl)};
    const policy = createMessagesHistoryTransfer({ home: ${JSON.stringify(f.options.home)}, env: {} });
    let reference;
    (() => {
      const body = { messages: [{ role: 'user', content: 'A'.repeat(5 * 1024 * 1024) }, { role: 'assistant', content: 'B' }, { role: 'user', content: 'C' }] };
      reference = new WeakRef(body);
      globalThis.heldPlan = policy.prepare({ key: 'a'.repeat(64), owner: 'b'.repeat(64), previousOwner: 'c'.repeat(64), profile: 'target', body });
    })();
    for (let i = 0; i < 30; i++) { await new Promise(setImmediate);global.gc(); }
    if (reference.deref()) throw Error('A streaming plan retained its full request body');
    globalThis.heldPlan.release();
  `], { timeout: 10000, stdio: "pipe" });
});

test("switching before a first prompt cannot strand the new model's first tool turn", t => {
  const f = fixture(t), input = { model: "two", messages: [user("Remember PRIVATE-ALPHA")] };
  const probe = f.prepare("source-two", structuredClone(input));probe.commit?.({ tool: false });probe.release();assert(!fs.existsSync(f.file));
  const first = f.prepare("source-two", input);first.commit({ tool: true });first.release();assert(fs.existsSync(f.file));f.restart();
  const continuation = { model: "two", messages: [user("Remember PRIVATE-ALPHA"), { role: "assistant", content: [{ type: "thinking", thinking: "keep", signature: "own-signature" }, { type: "tool_use", id: "first-tool", name: "read", input: {} }] },
    user([{ type: "tool_result", tool_use_id: "first-tool", content: "ALPHA" }])] };
  const next = f.prepare("source-two", continuation);assert.equal(continuation.messages[1].content[0].signature, "own-signature");next.release();
});

test("an obsolete origin cannot authorize unknown company history after an account change", t => {
  const f = fixture(t), value = body(), guard = createM365ConversationGuard(f.options);
  const plan = f.prepare("current-company-profile", value, { profiles: ["current-company-profile"] });
  assert.throws(() => guard({ id: "new-account", tenant: "tenant", login: "new@example.test", history_isolation: true }, value, f.headers,
    { profile: "current-company-profile" }), { code: "m365_account_changed" });plan.release();
});

test("real Messages HTTP commits only delivered state, retains partial-output provenance and releases failures", async t => {
  const key = "a".repeat(64), f = fixture(t);let scenario = "failure";
  const message = { type: "message", id: "msg_test", model: "source-two", content: [{ type: "text", text: "ALPHA" }], stop_reason: "end_turn" };
  const server = await startClaudeGateway({ port: 0, apiKey: key, record() {},
    validateConversation: value => f.prepare(value.model, value),
    provider: { id: "m365", models: () => [], client: { messages: async () => {
      if (scenario === "failure") return Response.json({ error: "synthetic" }, { status: 503 });
      if (scenario === "empty") return Response.json({ ...message, content: [] });
      if (scenario === "json") return Response.json(message);
      const events = [{ type: "message_start", message: { ...message, content: [] } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        ...(scenario === "partial" ? [{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "private-state" } }] : []),
        { type: "error", error: { type: "api_error", message: "synthetic" } }];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    } } } });
  t.after(() => server.close());
  const request = async (stream = false) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...body(), model: "source-two", stream }) });
    await response.text();return response.status;
  };
  assert.equal(await request(), 503);assert.equal(fs.existsSync(f.file), false);
  scenario = "empty";assert.equal(await request(), 200);assert.equal(fs.existsSync(f.file), false);
  scenario = "prelude";assert.equal(await request(true), 200);assert.equal(fs.existsSync(f.file), false);
  scenario = "partial";assert.equal(await request(true), 200);assert(fs.existsSync(f.file));
  f.restart();scenario = "json";assert.equal(await request(), 200);
});
