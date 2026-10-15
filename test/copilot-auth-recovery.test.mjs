import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureAuth, discoverGithubToken, writeToken, githubTokenPath } from "../src/auth.mjs";
import { createCopilotTokenSession } from "../src/copilot-token-session.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-recovery-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeToken("ghu_saved_fixture", home, { login: "fixture", id: "1" });
  const tokenPath = githubTokenPath(home);
  const before = fs.readFileSync(tokenPath);
  return { home, tokenPath, preserved() { assert.deepEqual(fs.readFileSync(tokenPath), before); } };
}

function session(home, fetchImpl) {
  return createCopilotTokenSession({ home, allowTokenDiscovery: false, tokenFetchImpl: fetchImpl,
    defaultApiBase: "https://api.githubcopilot.com", parseApiBase: () => "https://api.githubcopilot.com",
    fetchCopilotUpstream: (url, init, options) => options.fetchImpl(url, init) });
}

test("a denied source cannot hide another fully validated unambiguous local credential", async t => {
  const f = fixture(t);
  const result = await discoverGithubToken({ home: f.home, env: {},
    sources: [{ type: "auth-json", path: "denied" }, { type: "auth-json", path: "usable" }],
    readSource: source => `ghu_${source.path}_fixture`,
    fetchImpl: async (url, options) => {
      if (url.endsWith("/user")) return Response.json({ login: "fixture", id: 1 });
      return options.headers.Authorization.includes("denied") ? new Response("denied", { status: 403 }) : Response.json({ token: "service_fixture" });
    },
  });
  assert.equal(result.ok, true);assert.equal(result.token, "ghu_usable_fixture");f.preserved();
});

test("saved credential startup never validates, deletes, or initiates a new login", async t => {
  const f = fixture(t);
  await ensureAuth({ home: f.home, env: {}, log() {}, fetchImpl: () => assert.fail("saved-token startup must stay offline"),
    openAndCopyFn: () => assert.fail("login must not start") });
  f.preserved();
});

for (const status of [401, 403]) {
  test(`Copilot ${status} is not a reason to delete a GitHub credential that remains usable`, async t => {
    const f = fixture(t);let calls = 0, cancelled = false;
    const client = session(f.home, async url => {
      calls++;
      if (url.endsWith("/user")) return Response.json({ login: "fixture", id: 1 });
      return { ok: false, status, body: { cancel: async () => { cancelled = true; } } };
    });
    await assert.rejects(client.getToken(), error => {
      assert.equal(error.statusCode, status);
      assert.equal(error.transient, undefined, "an explicit denial must not reuse a cached token");
      assert.match(error.message, /preserved/);
      assert.doesNotMatch(error.message, /Delete|\brm\b|run ccdx again to log in/i);
      return true;
    });
    assert.equal(calls, status === 401 ? 2 : 1);
    assert.equal(cancelled, true);f.preserved();
  });
}

test("only a GitHub identity 401 permits reauthorization guidance; the credential is still preserved", async t => {
  const f = fixture(t);
  const client = session(f.home, async () => new Response("denied", { status: 401 }));
  await assert.rejects(client.getToken(), error => {
    assert.match(error.message, /GitHub also rejected/);
    assert.match(error.message, /log in/);return true;
  });
  f.preserved();
});

test("an unavailable identity check after Copilot 401 does not pretend the credential expired", async t => {
  const f = fixture(t);
  const client = session(f.home, async url => {
    if (url.endsWith("/user")) throw new Error("offline");
    return new Response("denied", { status: 401 });
  });
  await assert.rejects(client.getToken(), error => {
    assert.equal(error.statusCode, 401);assert.match(error.message, /could not be confirmed/);
    assert.doesNotMatch(error.message, /Delete|expired|log in/);return true;
  });
  f.preserved();
});

for (const endpoint of ["github", "copilot"]) {
  test(`${endpoint} 403 during discovery preserves existing source and does not start device login`, async t => {
    const f = fixture(t);fs.unlinkSync(f.tokenPath);
    const source = path.join(f.home, "existing-token");fs.writeFileSync(source, "ghu_external_fixture");
    let requests = 0;
    await assert.rejects(ensureAuth({ home: f.home, env: { CCDX_GITHUB_TOKEN_PATH: source }, log() {},
      openAndCopyFn: () => assert.fail("a policy denial must not open login"),
      fetchImpl: async url => {
        requests++;
        if (endpoint === "copilot" && url.endsWith("/user")) return Response.json({ login: "fixture", id: 1 });
        assert.ok(url.endsWith(endpoint === "github" ? "/user" : "/copilot_internal/v2/token"));
        return new Response("denied", { status: 403 });
      },
    }), /denied access.*no new login was started/);
    assert.equal(requests, endpoint === "github" ? 1 : 2);
    assert.equal(fs.readFileSync(source, "utf8"), "ghu_external_fixture");
    assert.equal(fs.existsSync(f.tokenPath), false);
  });
}
