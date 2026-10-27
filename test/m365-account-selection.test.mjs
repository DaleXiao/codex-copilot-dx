import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProviderRuntime } from "../src/provider-runtime.mjs";
import { createM365Provider } from "../src/providers/m365.mjs";
import { accountChoiceId } from "../src/providers/m365-accounts.mjs";
import { readM365Account, readM365Json, m365Paths, writeM365Binding, m365AccountKey, writeM365Json } from "../src/m365-settings.mjs";

const a = { id: "account-a", tenant: "company-a", login: "a@example.test", selection_source: "single" };
const b = { id: "account-b", tenant: "company-b", login: "b@example.test" };
const catalog = { data: [{ id: "gpt-test", publisher: "OpenAI", supported_endpoints: ["/responses"] }, { id: "claude-test", publisher: "Anthropic", supported_endpoints: ["/v1/messages"] }] };
function fixture(t, legacyClaude = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-account-selection-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (legacyClaude) writeM365Json(m365Paths({ home }).ownership, {});
  const providers = [];let fetches = 0, discoveries = 0, refuse = false, hold;
  const runtime = createProviderRuntime({ home, env: {}, platform: "win32", githubClient: {}, githubRegistry: { models: { data: [] } }, log() {},
    discoverM365: async () => { discoveries++;return { accounts: [a, b], windowsLogin: null }; },
    configureClients: () => ({ code: "configured", app: "configured" }),
    createM365: options => {
      const account = options.account || a;
      const provider = createM365Provider({ ...options, auth: { getToken: async () => ({ token: "synthetic-secret", account, expiresAt: Date.now() + 3600000 }), snapshot: () => ({ token_cached: true }), reset() {} },
        fetchImpl: async url => { fetches++;if (hold) await hold;if (refuse && account.id === b.id) return new Response("denied", { status: 403 });return new Response(JSON.stringify(url.endsWith("/models") ? catalog : { content: [{ type: "text", text: "ok" }] })); } });
      providers.push(provider);return provider;
    } });
  t.after(() => runtime.close());
  return { home, runtime, providers, fetches: () => fetches, discoveries: () => discoveries, refuse: () => { refuse = true; }, hold(value) { hold = value; } };
}

test("listing accounts performs local discovery only; explicit selection validates once and commits an isolated binding", async t => {
  const f = fixture(t);await f.runtime.start();const before = f.fetches();
  const choices = await f.runtime.action({ action: "accounts" });assert.equal(choices.accounts.length, 2);assert.equal(f.fetches(), before);
  const state = await f.runtime.action({ action: "account", account_id: accountChoiceId(b) });
  assert.equal(f.fetches(), before + 1);assert.equal(state.m365.account.login, b.login);assert.equal(state.m365.account_change_in_flight, false);
  assert.equal(state.codex_provider, "github");assert.equal(readM365Account({ home: f.home }).selection_source, "manual");
  assert.equal(readM365Account({ home: f.home }).history_isolation, true);
});

test("permission refusal and stale selection preserve the prior account and model cache without trying other accounts", async t => {
  const f = fixture(t);await f.runtime.start();const saved = fs.readFileSync(m365Paths({ home: f.home }).catalog, "utf8");
  f.refuse();const before = f.fetches();
  await assert.rejects(f.runtime.action({ action: "account", account_id: accountChoiceId(b) }), { code: "m365_catalog_http_403" });
  assert.equal(f.fetches(), before + 1);assert.equal(readM365Account({ home: f.home }).id, a.id);
  assert.equal(fs.readFileSync(m365Paths({ home: f.home }).catalog, "utf8"), saved);assert.equal(f.runtime.snapshot().m365.account.login, a.login);
  await assert.rejects(f.runtime.action({ action: "account", account_id: "0".repeat(64) }), { code: "m365_account_selection_stale" });
  assert.equal(f.fetches(), before + 1);
  await assert.rejects(f.runtime.action({ action: "account", account_id: [accountChoiceId(b)] }), { statusCode: 400 });
});

test("active M365 work prevents selection before discovery; validation blocks new M365 work and leaves GitHub available", async t => {
  const f = fixture(t, true);await f.runtime.start();const finish = f.runtime.track({ id: "m365" });
  await assert.rejects(f.runtime.action({ action: "account", account_id: accountChoiceId(b) }), { code: "m365_account_busy" });
  assert.equal(f.discoveries(), 0);finish();
  let release;f.hold(new Promise(resolve => { release = resolve; }));
  const pending = f.runtime.action({ action: "account", account_id: accountChoiceId(b) });
  await new Promise(resolve => setImmediate(resolve));assert.equal(f.runtime.current().id, "github");
  let status;f.runtime.handleClaude({}, { writeHead(code) { status = code; }, end() {} });assert.equal(status, 409);
  release();await pending;
});

test("known old conversations and unknown old history never cross accounts, including after provider restart", async t => {
  const f = fixture(t);await f.runtime.start();
  const first = { model: "claude-test", messages: [{ role: "user", content: "synthetic private text" }] };
  await f.providers[0].client.messages(first, { headers: { "session-id": "old-session" } });
  await f.runtime.action({ action: "account", account_id: accountChoiceId(b) });const current = f.providers.at(-1), before = f.fetches();
  await assert.rejects(current.client.messages(first, { headers: { "session-id": "old-session" } }), { code: "m365_account_changed" });
  const old = { ...first, messages: [...first.messages, { role: "assistant", content: "old reply" }, { role: "user", content: "continue" }] };
  await assert.rejects(current.client.messages(old, { headers: { "session-id": "unknown-old" } }), { code: "m365_account_changed" });assert.equal(f.fetches(), before);
  await current.client.messages(first, { headers: { "session-id": "new-session" } });
  const owners = readM365Json(path.join(m365Paths({ home: f.home }).directory, "conversations.json"));assert.doesNotMatch(JSON.stringify(owners), /private text|old-session|new-session/);
  const restarted = createM365Provider({ home: f.home, log() {}, auth: { getToken: async () => ({ account: readM365Account({ home: f.home }), token: "synthetic-secret" }), snapshot: () => ({}), reset() {} }, fetchImpl: async () => new Response("{}") });
  t.after(() => restarted.close());
  await restarted.client.messages(old, { headers: { "session-id": "new-session" } });
  await assert.rejects(restarted.client.messages(old, { headers: { "session-id": "old-session" } }), { code: "m365_account_changed" });
});

test("a binding commit failure restores the previous catalog and account; stale writers cannot replace a newer selection", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-account-rollback-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = m365Paths({ home }), initial = { account_key: m365AccountKey(a), models: catalog, saved_at: 1 };
  writeM365Binding(a, initial, { home, expectedAccount: null });
  const previous = [paths.account, paths.catalog].map(file => fs.readFileSync(file, "utf8"));
  const rename = fs.renameSync;let fail = true;
  fs.renameSync = (from, to) => { if (to === paths.account && fail) { fail = false;throw Object.assign(Error("fixture denied"), { code: "EACCES" }); }return rename(from, to); };
  try { assert.throws(() => writeM365Binding(b, { ...initial, account_key: m365AccountKey(b), saved_at: 2 }, { home, expectedAccount: a }), /fixture denied/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual([paths.account, paths.catalog].map(file => fs.readFileSync(file, "utf8")), previous);
  assert.throws(() => writeM365Binding(b, initial, { home, expectedAccount: b }), { code: "m365_account_selection_stale" });
});
