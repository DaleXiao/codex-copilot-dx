import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { additionalGithubSources, readAdditionalGithubSource } from "../src/auth-sources.mjs";
import { discoverGithubToken, ensureAuth, validateGithubToken } from "../src/auth.mjs";
import { githubTokenSources, readGithubTokenSource } from "../src/auth-credentials.mjs";

function home(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-sources-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));return directory;
}

test("OpenCode imports only Copilot GitHub OAuth refresh, respects XDG_DATA_HOME and skips other audiences", t => {
  const directory = home(t), env = { XDG_DATA_HOME: path.join(directory, "data") };
  const file = path.join(env.XDG_DATA_HOME, "opencode", "auth.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const write = value => fs.writeFileSync(file, JSON.stringify(value));
  write({ "github-copilot": { type: "oauth", refresh: "ghu_fixture", access: "service-token" }, openai: { type: "api", key: "sk_never" } });
  const sources = githubTokenSources({ home: directory, env });
  assert.equal(sources.length, 1);assert.equal(readGithubTokenSource(sources[0]), "ghu_fixture");
  for (const value of [{ type: "api", key: "sk_never" }, { type: "oauth", access: "service-token" },
    { type: "oauth", refresh: "ghu_fixture", enterpriseUrl: "https://enterprise.test" }]) {
    write({ "github-copilot": value });assert.equal(readGithubTokenSource(sources[0]), "");
  }
  assert.deepEqual(githubTokenSources({ home: directory, env: { ...env, CCDX_DISABLE_TOKEN_DISCOVERY: "1" } }), []);
});

test("GitHub CLI discovery is ordered, deduplicated and noninteractive with bounded output/time", t => {
  const directory = home(t), executable = path.join(directory, process.platform === "win32" ? "gh.exe" : "gh");
  fs.writeFileSync(executable, "fixture");
  const env = { PATH: [directory, directory].join(path.delimiter) };
  const sources = additionalGithubSources(directory, env);
  assert.equal(sources.length, 1);
  const token = readAdditionalGithubSource(sources[0], { env, exec(command, args, options) {
    assert.equal(command, executable);assert.deepEqual(args, ["auth", "token", "--hostname", "github.com"]);
    assert.equal(options.env.GH_PROMPT_DISABLED, "1");assert.equal(options.shell, false);
    assert.equal(options.timeout, 1000);assert.equal(options.maxBuffer, 16384);
    return "ghu_fixture\n";
  } });
  assert.equal(token, "ghu_fixture");
});

test("transient auth failures do not initiate device login or save credentials", async t => {
  const directory = home(t);let calls = 0;
  await assert.rejects(ensureAuth({ home: directory, env: { CCDX_GITHUB_TOKEN: "ghu_fixture" }, log() {},
    fetchImpl: async url => { calls++;assert.ok(url.endsWith("/user"));return new Response("offline", { status: 503 }); },
    openAndCopyFn: () => assert.fail("must not open login"),
  }), /no new login was started/);
  assert.equal(calls, 1);
});

test("discovery total deadline, candidate budget and cancelled fetches cannot silently choose an unverified account", async t => {
  const directory = home(t), keepAlive = setTimeout(() => {}, 1000);t.after(() => clearTimeout(keepAlive));
  const sources = [{ type: "auth-json", path: "first" }, { type: "auth-json", path: "second" }];
  const result = await discoverGithubToken({ home: directory, env: {}, sources, timeoutMs: 20,
    readSource: () => "fixture", fetchImpl: () => new Promise(() => {}) });
  assert.equal(result.ok, false);assert.equal(result.incomplete, true);
  let calls = 0;
  const limited = await discoverGithubToken({ home: directory, env: {}, sources, maxCandidates: 1,
    readSource: source => source.path, fetchImpl: async url => { calls++;return Response.json(url.endsWith("/user") ? { login: "alice", id: 1 } : { token: "service" }); } });
  assert.equal(limited.incomplete, true);assert.equal(calls, 2);
  assert.equal((await validateGithubToken("fixture", { timeoutMs: 20, fetchImpl: () => new Promise(() => {}) })).transient, true);
});
