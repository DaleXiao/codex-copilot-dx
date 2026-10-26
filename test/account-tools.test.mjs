import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAccountTools } from "../src/account-tools.mjs";
import { githubTokenPath, legacyGithubTokenPath, managedGithubTokenPath, writeToken } from "../src/auth-credentials.mjs";
import { readAuthProfileCredentials } from "../src/auth-profile.mjs";
import { runAuthCommand } from "../src/cli-auth.mjs";
import { inspectAuthProfiles } from "../src/doctor.mjs";

function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-accounts-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeToken("old-signin", home, { login: "work_user", id: "7" });
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if (url.endsWith("/device/code")) return Response.json({ device_code: "private-device-code", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 });
    if (url.endsWith("/user")) return Response.json({ login: "work_user", id: 7 });
    if (url.endsWith("/v2/token")) return Response.json({ token: "private-service-token", endpoints: { api: "https://api.githubcopilot.com" } });
    return Response.json({ data: [{ id: "gpt-5" }] });
  };
  const tools = createAccountTools({ home, env: {}, fetchImpl, poll: async () => ({ state: "done", token: "new-signin" }), ...options });
  t.after(() => tools.dispose());
  return { home, tools, calls };
}

test("reauth verifies identity, entitlement and catalog before saving to CCDX; legacy bytes stay intact", async t => {
  let changed = 0;
  const { home, tools, calls } = fixture(t, { onChanged: () => { changed++; } });
  const started = await tools.start({ reauth: true });
  assert.doesNotMatch(JSON.stringify(started), /private-device-code|new-signin|old-signin|service-token/);
  const result = await tools.wait();
  assert.equal(result.operation.state, "complete");assert.equal(result.online.ok, true);assert.equal(result.store, "ccdx");
  assert.equal(readAuthProfileCredentials("codex", { home }).identity.login, "work_user");
  assert.equal(fs.readFileSync(legacyGithubTokenPath(home), "utf8"), "old-signin");
  assert.equal(githubTokenPath(home), managedGithubTokenPath(home));assert.equal(changed, 1);assert.equal(calls.length, 4);
  assert.ok(inspectAuthProfiles({ home }).some(check => check.message.includes("CCDX-owned store")));
  await tools.logout({ confirmed: true });
  assert.equal(tools.snapshot().saved, false);assert.equal(fs.readFileSync(legacyGithubTokenPath(home), "utf8"), "old-signin");
  assert.equal(readAuthProfileCredentials("codex", { home }).token, "", "explicit sign-out never falls back to another app's legacy token");
});

test("failed entitlement, changed accounts and concurrent sign-in writes preserve the saved credential", async t => {
  for (const reason of ["denied", "account", "changed"]) await t.test(reason, async t => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const { home, tools } = fixture(t, { poll: () => pending, inspect: async () => reason === "denied"
      ? { ok: false, reason: "copilot_access_denied" } : { ok: true, login: reason === "account" ? "other" : "work_user", id: reason === "account" ? "8" : "7", models: 1 } });
    await tools.start({ reauth: true });
    if (reason === "changed") writeToken("concurrent-signin", home, { login: "work_user", id: "7" });
    release({ state: "done", token: "candidate-token" });
    const result = await tools.wait();assert.equal(result.operation.state, "failed");
    assert.equal(fs.readFileSync(legacyGithubTokenPath(home), "utf8"), reason === "changed" ? "concurrent-signin" : "old-signin");
    assert.equal(fs.existsSync(managedGithubTokenPath(home)), false);
  });
});

test("device login cancellation, parallel requests and cooldown are bounded", async t => {
  const { tools, home } = fixture(t, { poll: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true })) });
  const started = await tools.start({ reauth: true });
  await assert.rejects(tools.start({ reauth: true }), { code: "auth_busy" });
  const cancelled = await tools.cancel(started.operation.id);assert.equal(cancelled.operation.state, "cancelled");
  await assert.rejects(tools.start({ reauth: true }), { code: "auth_retry_later" });
  assert.equal(fs.readFileSync(githubTokenPath(home), "utf8"), "old-signin");
  await assert.rejects(tools.logout(), { code: "auth_confirmation_required" });
});

test("connection checks distinguish GitHub rejection from Copilot denial and never start Device Flow", async t => {
  for (const [reason, status, stage] of [["identity", 401, "identity"], ["identity", 403, "identity"], ["identity", 429, "identity"],
    ["access", 401, "access"], ["access", 403, "access"], ["catalog", 401, "models"], ["catalog", 403, "models"], ["catalog", 503, "models"]]) await t.test(`${reason}/${status}`, async t => {
    const { tools, home, calls } = fixture(t, { fetchImpl: async url => {
      calls.push(url);
      if (url.endsWith("/user")) return Response.json({ login: "work_user", id: 7 }, { status: reason === "identity" ? status : 200 });
      if (url.endsWith("/v2/token")) return Response.json({ token: "private", endpoints: { api: "https://api.githubcopilot.com" } }, { status: reason === "access" ? status : 200 });
      return Response.json({ data: [] }, { status });
    } });
    const file = githubTokenPath(home), before = fs.readFileSync(file, "utf8");
    const [first, second] = await Promise.all([tools.check(), tools.check()]);
    assert.equal(first.online.ok, false);assert.deepEqual(first, second);
    assert.equal(first.online.stages[stage], reason === "identity" && status === 401 ? "invalid" : "unavailable");
    assert.equal(first.online.reason === "github_token_invalid", reason === "identity" && status === 401);
    assert.equal(fs.readFileSync(file, "utf8"), before);assert.equal(fs.existsSync(managedGithubTokenPath(home)), false);
    assert.ok(calls.length <= 3);assert.ok(calls.every(url => !url.includes("login/")));
    await tools.check();assert.ok(calls.length <= 3, "manual repeated checks reuse a 10-second result");
  });
});

test("CLI refuses noninteractive logout without --yes and login with a saved sign-in performs no network call", async t => {
  const { tools, home, calls } = fixture(t);
  await assert.rejects(runAuthCommand({ action: "logout", home, tools, input: { isTTY: false }, output: { isTTY: false } }), /--yes/);
  const result = await runAuthCommand({ action: "login", home, tools });assert.match(result.output, /sign-in is saved/);assert.equal(calls.length, 0);
});
