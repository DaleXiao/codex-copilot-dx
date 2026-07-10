import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverGithubToken,
  ensureAuth,
  extractGithubTokenFromAuthJson,
  githubReauthMessage,
  githubTokenLockPath,
  githubTokenMetadataPath,
  githubTokenPath,
  githubTokenSources,
  importDiscoveredGithubToken,
  interpretPoll,
  readGithubTokenMetadata,
  writeToken,
} from "../src/auth.mjs";
import { withFileLock } from "../src/lock.mjs";

function jsonResp(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function writeLocalCopilotAuth(home, appName, profileName, token) {
  writeJson(path.join(home, "Library", "Application Support", appName, "profiles", profileName, "auth.json"), {
    ghcAuth: {
      gitHubTokens: {
        access_token: token,
      },
    },
  });
}

test("interpretPoll: access_token returns done", () => {
  assert.deepEqual(interpretPoll({ access_token: "gho_x" }), { state: "done", token: "gho_x" });
});

test("interpretPoll: authorization_pending returns wait", () => {
  assert.deepEqual(interpretPoll({ error: "authorization_pending" }), { state: "wait" });
});

test("interpretPoll: slow_down returns slow", () => {
  assert.deepEqual(interpretPoll({ error: "slow_down" }), { state: "slow" });
});

test("interpretPoll: expired_token returns fail", () => {
  assert.deepEqual(interpretPoll({ error: "expired_token" }), { state: "fail", error: "expired_token" });
});

test("interpretPoll: unknown errors return fail", () => {
  assert.deepEqual(interpretPoll({ error: "access_denied" }), { state: "fail", error: "access_denied" });
});

test("interpretPoll: empty access_token is not done", () => {
  assert.equal(interpretPoll({ access_token: "" }).state, "fail");
});

test("githubReauthMessage: points users to the token file and login command", () => {
  const message = githubReauthMessage("Saved token is invalid.", "/tmp/ccdx-home");
  assert.match(message, /Saved token is invalid\./);
  assert.match(message, /rm '\/tmp\/ccdx-home\/\.local\/share\/copilot-api\/github_token'/);
  assert.match(message, /codex-copilot-dx/);
});

test("extractGithubTokenFromAuthJson: reads Copilot auth JSON shape", () => {
  assert.equal(extractGithubTokenFromAuthJson({
    ghcAuth: {
      gitHubTokens: {
        access_token: "  ghu_local  ",
      },
    },
  }), "ghu_local");
});

test("githubTokenSources: includes explicit env and generic local auth files", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-sources-"));
  writeLocalCopilotAuth(home, "some-copilot-client", "dingxiao_microsoft", "ghu_local");

  const sources = githubTokenSources({
    home,
    env: {
      CCDX_GITHUB_TOKEN: "ghu_env",
      CCDX_GITHUB_TOKEN_PATH: "~/copilot-token",
      CCDX_GITHUB_TOKEN_PATHS: ["~/copilot-token-a", "~/copilot-token-b"].join(path.delimiter),
    },
  });

  assert.equal(sources.some((source) => source.type === "env" && source.name === "CCDX_GITHUB_TOKEN"), true);
  assert.equal(sources.filter((source) => source.type === "token-file").length, 3);
  assert.equal(sources.some((source) => source.type === "token-file" && source.path === path.join(home, "copilot-token")), true);
  assert.equal(sources.some((source) => source.type === "token-file" && source.path === path.join(home, "copilot-token-b")), true);
  assert.equal(sources.some((source) => source.type === "auth-json" && source.path.endsWith(path.join("some-copilot-client", "profiles", "dingxiao_microsoft", "auth.json"))), true);
});

test("discoverGithubToken: validates candidates before returning one", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-discover-"));
  writeLocalCopilotAuth(home, "some-copilot-client", "dingxiao_microsoft", "ghu_local");
  const calls = [];

  const result = await discoverGithubToken({
    home,
    env: {},
    fetchImpl: async (url, options) => {
      calls.push([url, options.headers.Authorization]);
      if (url.endsWith("/user")) return jsonResp(200, { login: "dingxiao_microsoft" });
      if (url.endsWith("/copilot_internal/v2/token")) {
        return jsonResp(200, { token: "copilot_short", expires_at: 9999999999 });
      }
      throw new Error(`unexpected url ${url}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.validation.login, "dingxiao_microsoft");
  assert.equal(result.token, "ghu_local");
  assert.deepEqual(calls.map((call) => call[0]), [
    "https://api.github.com/user",
    "https://api.github.com/copilot_internal/v2/token",
  ]);
});

test("ensureAuth: imports a valid local auth token before device flow", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-import-"));
  writeLocalCopilotAuth(home, "some-copilot-client", "dingxiao_microsoft", "ghu_local");
  const lines = [];

  await ensureAuth({
    home,
    env: {},
    log: (line) => lines.push(line),
    openAndCopyFn: () => {
      throw new Error("device flow should not start");
    },
    fetchImpl: async (url) => {
      if (url.endsWith("/user")) return jsonResp(200, { login: "dingxiao_microsoft" });
      if (url.endsWith("/copilot_internal/v2/token")) {
        return jsonResp(200, { token: "copilot_short", expires_at: 9999999999 });
      }
      throw new Error(`device flow should not request ${url}`);
    },
  });

  assert.equal(fs.readFileSync(githubTokenPath(home), "utf8"), "ghu_local");
  assert.equal((fs.statSync(githubTokenPath(home)).mode & 0o777), 0o600);
  assert.equal(lines.some((line) => /Imported GitHub token from local auth file/.test(line)), true);
});

test("ensureAuth: rechecks the saved token after waiting for the auth lock", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-lock-"));
  const lines = [];
  let releaseLock;
  let lockHeld;
  const lockIsHeld = new Promise((resolve) => { lockHeld = resolve; });

  const holder = withFileLock(githubTokenLockPath(home), async () => {
    lockHeld();
    await new Promise((resolve) => { releaseLock = resolve; });
  }, { timeoutMs: 1000, pollMs: 5 });

  await lockIsHeld;
  const auth = ensureAuth({
    home,
    env: { CCDX_TOKEN_LOCK_TIMEOUT_MS: "1000" },
    log: (line) => lines.push(line),
    fetchImpl: async () => {
      throw new Error("device flow should not start");
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  writeToken("ghu_written_by_other_process", home);
  releaseLock();

  await Promise.all([holder, auth]);
  assert.equal(fs.readFileSync(githubTokenPath(home), "utf8"), "ghu_written_by_other_process");
  assert.equal(lines.some((line) => /\[OK\] GitHub token found/.test(line)), true);
});

test("discoverGithubToken: rejects ambiguous generic accounts", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-ambiguous-"));
  writeLocalCopilotAuth(home, "client-a", "profile", "ghu_alice");
  writeLocalCopilotAuth(home, "client-b", "profile", "ghu_bob");

  const result = await discoverGithubToken({
    home,
    env: {},
    fetchImpl: async (url, options) => {
      const token = options.headers.Authorization.split(" ").at(-1);
      const login = token === "ghu_alice" ? "alice" : "bob";
      const id = token === "ghu_alice" ? 1 : 2;
      if (url.endsWith("/user")) return jsonResp(200, { login, id });
      if (url.endsWith("/copilot_internal/v2/token")) return jsonResp(200, { token: `copilot_${login}` });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ambiguous, true);
  assert.deepEqual(result.candidates.map((candidate) => candidate.login).sort(), ["alice", "bob"]);
});

test("importDiscoveredGithubToken: bound account rejects a different local account", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-bound-"));
  writeToken("ghu_old_alice", home, { login: "alice", id: 1 });
  writeLocalCopilotAuth(home, "client-b", "profile", "ghu_bob");

  const imported = await importDiscoveredGithubToken({
    home,
    env: {},
    excludeTokens: ["ghu_old_alice"],
    validateSavedToken: true,
    fetchImpl: async (url, options) => {
      const token = options.headers.Authorization.split(" ").at(-1);
      if (token === "ghu_old_alice") return jsonResp(401, {});
      if (url.endsWith("/user")) return jsonResp(200, { login: "bob", id: 2 });
      if (url.endsWith("/copilot_internal/v2/token")) return jsonResp(200, { token: "copilot_bob" });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(imported, null);
  assert.equal(fs.readFileSync(githubTokenPath(home), "utf8"), "ghu_old_alice");
  assert.equal(readGithubTokenMetadata(home, "ghu_old_alice").login, "alice");
});

test("token metadata is ignored after another app replaces the token file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-fingerprint-"));
  writeToken("ghu_alice", home, { login: "alice", id: 1 });
  assert.equal(readGithubTokenMetadata(home, "ghu_alice").login, "alice");

  fs.writeFileSync(githubTokenPath(home), "ghu_bob");

  assert.equal(readGithubTokenMetadata(home, "ghu_bob"), null);
  assert.equal(fs.existsSync(githubTokenMetadataPath(home)), true);
});

test("explicit token sources can intentionally switch the bound account", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-explicit-switch-"));
  writeToken("ghu_old_alice", home, { login: "alice", id: 1 });
  const explicitPath = path.join(home, "bob-token");
  fs.writeFileSync(explicitPath, "ghu_bob");

  const imported = await importDiscoveredGithubToken({
    home,
    env: { CCDX_GITHUB_TOKEN_PATH: explicitPath },
    excludeTokens: ["ghu_old_alice"],
    validateSavedToken: true,
    fetchImpl: async (url, options) => {
      const token = options.headers.Authorization.split(" ").at(-1);
      if (token === "ghu_old_alice") return jsonResp(401, {});
      if (url.endsWith("/user")) return jsonResp(200, { login: "bob", id: 2 });
      if (url.endsWith("/copilot_internal/v2/token")) return jsonResp(200, { token: "copilot_bob" });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(imported.token, "ghu_bob");
  assert.equal(fs.readFileSync(githubTokenPath(home), "utf8"), "ghu_bob");
  assert.equal(readGithubTokenMetadata(home, "ghu_bob").login, "bob");
});
