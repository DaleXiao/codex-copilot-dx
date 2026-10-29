import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureAuth, githubTokenPath, writeToken } from "../src/auth.mjs";
import { createCopilotClient } from "../src/copilot.mjs";

const identity = { login: "fixture-account", id: "1" };
const tokenData = (token = "verified-service") => ({ token, expires_at: Math.floor(Date.now() / 1000) + 1800,
  endpoints: { api: "https://copilot.example.test" } });
const imported = (data = tokenData(), token = "ghu_fixture", account = identity) => ({ imported: true, token,
  validation: { ok: true, ...account, copilotTokenData: data } });
function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-reuse-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (url === "https://api.github.com/user") return Response.json(identity);
    if (url === "https://api.github.com/copilot_internal/v2/token") return options.exchange ? options.exchange(init) : Response.json(tokenData());
    if (url === "https://copilot.example.test/models") return Response.json({ data: [{ id: "fixture-model", supported_endpoints: ["/responses"] }] });
    throw Error(`Unexpected external request: ${url}`);
  };
  const client = createCopilotClient({ home, tokenFetchImpl: fetchImpl });t.after(() => client.resetForTests());
  return { home, calls, client, fetchImpl, exchanges: () => calls.filter(url => url.endsWith("/copilot_internal/v2/token")).length };
}

test("startup import reuses its verified service token for catalog and concurrent requests", async t => {
  const f = fixture(t);let reused = false;
  await ensureAuth({ home: f.home, env: { CCDX_GITHUB_TOKEN: "ghu_fixture" }, fetchImpl: f.fetchImpl, log() {},
    onImportedAuth: async result => { reused = await f.client.reuseVerifiedAuth(result); } });
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => f.client.getCopilotToken())), Array(20).fill("verified-service"));
  assert.equal((await f.client.listModels({ fetchImpl: f.fetchImpl })).status, 200);
  assert.equal(f.exchanges(), 1, "Discovery's service token is not exchanged a second time");
  assert.equal(reused, true);
  assert.equal(f.client.getApiBase(), "https://copilot.example.test");
  const before = f.calls.length;
  await ensureAuth({ home: f.home, env: {}, fetchImpl: f.fetchImpl, log() {}, onImportedAuth() { assert.fail("Saved credentials do not trigger another handoff"); } });
  assert.equal(f.calls.length, before);
  const files = [];
  const walk = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);if (entry.isDirectory()) walk(file);else files.push(fs.readFileSync(file, "utf8"));
  } };
  walk(f.home);assert.doesNotMatch(files.join("\n"), /verified-service/);
});

test("stale, invalid and mismatched handoffs leave normal refresh and saved credentials intact", async t => {
  const f = fixture(t);writeToken("ghu_fixture", f.home, identity);
  const saved = fs.readFileSync(githubTokenPath(f.home));
  const candidates = [
    imported({ ...tokenData(), expires_at: Math.floor(Date.now() / 1000) - 1 }),
    imported({ ...tokenData(), expires_at: Math.floor(Date.now() / 1000) + 30 }),
    imported({ token: "missing-expiry" }), imported({ ...tokenData(), expires_at: Number.MAX_VALUE }),
    imported({ ...tokenData(), token: " " }), { ...imported(), validation: { ...imported().validation, ok: false } },
    imported(tokenData(), "different-credential"), imported(tokenData(), "ghu_fixture", { login: "other", id: "2" }),
  ];
  for (const candidate of candidates) assert.equal(await f.client.reuseVerifiedAuth(candidate), false);
  assert.equal(f.client.runtimeStatus().token_cached, false);assert.equal(f.exchanges(), 0);
  assert.deepEqual(fs.readFileSync(githubTokenPath(f.home)), saved);
  assert.equal(await f.client.getCopilotToken(), "verified-service");assert.equal(f.exchanges(), 1);
});

test("a service token already in use is not replaced by a handoff", async t => {
  const f = fixture(t);writeToken("ghu_fixture", f.home, identity);
  assert.equal(await f.client.getCopilotToken(), "verified-service");
  assert.equal(await f.client.reuseVerifiedAuth(imported(tokenData("replacement"))), false);
  assert.equal(await f.client.getCopilotToken(), "verified-service");assert.equal(f.exchanges(), 1);
});

test("a handoff cannot overtake the runtime's existing refresh", async t => {
  let release, started;const began = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { exchange: () => new Promise(resolve => { release = () => resolve(Response.json(tokenData("runtime-refresh")));started(); }) });
  writeToken("ghu_fixture", f.home, identity);
  const flight = f.client.getCopilotToken();await began;
  assert.equal(await f.client.reuseVerifiedAuth(imported()), false);
  release();assert.equal(await flight, "runtime-refresh");assert.equal(f.exchanges(), 1);
});

test("credential invalidation keeps account binding when a different imported account is offered", async t => {
  const f = fixture(t);writeToken("ghu_fixture", f.home, identity);await f.client.getCopilotToken();
  f.client.invalidateCredentials();const other = { login: "other-account", id: "2" };
  writeToken("ghu_other", f.home, other);
  assert.equal(await f.client.reuseVerifiedAuth(imported(tokenData("other-service"), "ghu_other", other)), false);
  assert.equal(f.client.runtimeStatus().account_bound, true);assert.equal(f.client.runtimeStatus().token_cached, false);
  await assert.rejects(f.client.getCopilotToken(), /Refusing to switch/);
});
