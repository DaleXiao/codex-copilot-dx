import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { acquireSilentM365Token, brokerFailure, M365_RESOURCE } from "../src/providers/m365-auth-helper.mjs";
import { createM365Auth, m365HelperEnvironment, requestM365Token } from "../src/providers/m365-auth.mjs";
import { readM365Settings, updateM365Settings, m365Paths } from "../src/m365-settings.mjs";
import { readProviderSettings, writeProviderSettings, providerSettingsPath } from "../src/provider-settings.mjs";

const identity = { id: "account-a", tenant: "tenant-a", login: "person@example.test" };
const token = () => ({ token: "synthetic_m365_secret", account: identity, expiresAt: Date.now() + 3600000 });
function fixture(t) { const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-m365-auth-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));return home; }
function broker(accounts = [{ ...identity, accountId: "native-a", homeAccountId: identity.id, realm: identity.tenant, username: identity.login }]) {
  const calls = [];
  return { calls, AuthParameters: class {
    CreateAuthParameters(...args) { calls.push(["parameters", ...args]); }
    SetRedirectUri(value) { calls.push(["redirect", value]); }
    SetRequestedScopes(value) { calls.push(["scopes", value]); }
  }, DiscoverAccountsAsync(_client, _correlation, done) { done({ accounts, CheckError() {} }); },
  AcquireTokenSilentlyAsync(_params, _correlation, _account, done) { calls.push(["silent"]);done({ CheckError() {}, accessToken: "synthetic_m365_secret", expiresOn: Date.now() / 1000 + 3600, grantedScopes: `${M365_RESOURCE}/LLM.Read` }); } };
}

test("native M365 authorization uses only silent broker acquisition and honors its account binding", async () => {
  const native = broker();
  const value = await acquireSilentM365Token({ account: identity }, { platform: "win32", loadBroker: () => native });
  assert.equal(value.token, "synthetic_m365_secret");assert.deepEqual(value.account, identity);
  assert.equal(native.calls.filter(([name]) => name === "silent").length, 1);
  assert.ok(native.calls.some(([name, uri]) => name === "redirect" && uri.startsWith("ms-appx-web://Microsoft.AAD.BrokerPlugin/")));
  await assert.rejects(acquireSilentM365Token({ account: { ...identity, id: "different" } }, { platform: "win32", loadBroker: () => native }), { code: "m365_account_unavailable" });
  assert.equal(native.calls.filter(([name]) => name === "silent").length, 1);
});

test("unmanaged or unsupported machines and ambiguous accounts never request a token", async () => {
  let loads = 0;
  await assert.rejects(acquireSilentM365Token({}, { platform: "darwin", execFileImpl: async () => ({ stdout: "MDM enrollment: No" }), loadBroker: () => { loads++; } }), { code: "m365_device_not_managed" });
  await assert.rejects(acquireSilentM365Token({}, { platform: "linux", loadBroker: () => { loads++; } }), { code: "m365_platform_unsupported" });
  assert.equal(loads, 0);
  const native = broker();native.DiscoverAccountsAsync = (_c, _i, done) => done({ CheckError() {}, accounts: [1, 2].map(n => ({ accountId: `id${n}`, username: `user${n}`, realm: "tenant" })) });
  await assert.rejects(acquireSilentM365Token({}, { platform: "win32", loadBroker: () => native }), { code: "m365_account_ambiguous" });
  assert.deepEqual(native.calls, []);
});

test("broker errors and helper environment do not expose or inherit unrelated secrets", () => {
  assert.deepEqual(brokerFailure({ errorStatus: 2, errorContext: "secret marker AADSTS50076 bearer eyJsecret" }),
    { code: "m365_interaction_required", aadsts: ["AADSTS50076"] });
  const env = m365HelperEnvironment({ PATH: "bin", HOME: "home", HTTPS_PROXY: "http://proxy", NODE_EXTRA_CA_CERTS: "ca",
    GH_TOKEN: "github_secret", GITHUB_TOKEN: "github_secret", OPENAI_API_KEY: "image_secret", NODE_OPTIONS: "--import=untrusted.mjs" });
  assert.deepEqual(env, { PATH: "bin", HOME: "home", HTTPS_PROXY: "http://proxy", NODE_EXTRA_CA_CERTS: "ca" });
});

test("M365 tokens are cached, singleflight and private, and cancellation does not cancel another waiter", async t => {
  let calls = 0, complete, aborted = false;
  const auth = createM365Auth({ home: fixture(t), acquire: ({ signal }) => { calls++;signal.addEventListener("abort", () => { aborted = true; });return new Promise(resolve => { complete = resolve; }); } });
  const controller = new AbortController(), first = auth.getToken({ signal: controller.signal }), second = auth.getToken();
  await Promise.resolve();controller.abort();await assert.rejects(first, { name: "AbortError" });
  assert.equal(aborted, false);complete(token());assert.equal((await second).token, "synthetic_m365_secret");
  assert.equal((await auth.getToken()).token, "synthetic_m365_secret");assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(auth.snapshot()), /synthetic_m365_secret|account-a|tenant-a/);
  auth.reset();assert.equal(auth.snapshot().token_cached, false);
});

test("failed silent authorization has bounded backoff and never deletes the account", async t => {
  const home = fixture(t);let now = Date.now(), calls = 0;
  const auth = createM365Auth({ home, now: () => now, acquire: async () => { calls++;throw Object.assign(new Error("secret"), { code: "m365_interaction_required" }); } });
  await assert.rejects(auth.getToken());await assert.rejects(auth.getToken());assert.equal(calls, 1);
  assert.equal(auth.snapshot().reason, "m365_interaction_required");now += 60001;await assert.rejects(auth.getToken());assert.equal(calls, 2);
  assert.equal(fs.existsSync(m365Paths({ home }).directory), false);
});

test("helper timeout terminates only its child and reports a bounded error", async () => {
  let killed = 0;
  const child = new EventEmitter();child.stdin = new PassThrough();child.stdout = new PassThrough();child.stderr = new PassThrough();child.kill = () => { killed++; };
  await assert.rejects(requestM365Token({ spawnImpl: () => child, timeoutMs: 5 }), { code: "m365_auth_timeout" });
  assert.equal(killed, 1);
});

test("M365 backup is opt-in and settings writes reject invalid choices before changing files", t => {
  const home = fixture(t), options = { home };
  assert.deepEqual(readM365Settings(options), { enabled: true });
  assert.equal(readProviderSettings(options).codex, "github");
  writeProviderSettings("m365", { model: "gpt-6-sol", auto_review_model: "gpt-6-sol" }, options);
  const before = fs.readFileSync(providerSettingsPath(options));
  assert.throws(() => writeProviderSettings("other", null, options), { code: "ccdx_provider_selection_invalid" });
  assert.deepEqual(fs.readFileSync(providerSettingsPath(options)), before);
  updateM365Settings({ enabled: false }, options);
  assert.equal(readProviderSettings(options).codex, "m365", "provider preference is owned by the core, not M365 profile writes");
});
