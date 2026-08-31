import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverGithubToken,
  ensureAuth,
  extractGithubTokenFromAuthJson,
  fetchGithubIdentity,
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
import { atomicWriteFileSync } from "../src/atomic-file.mjs";
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
  assert.match(message, /ccdx/);
});

test("fetchGithubIdentity: bounds a stalled response body with an independent deadline", async () => {
  let bodyCancelled = false;
  const result = await fetchGithubIdentity("ghu_new", {
    timeoutMs: 10,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: { cancel: async () => { bodyCancelled = true; } },
      json: async () => new Promise(() => {}),
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.transient, true);
  assert.equal(result.reason, "github_user_timeout");
  assert.equal(result.error.code, "CCDX_GITHUB_IDENTITY_TIMEOUT");
  assert.equal(bodyCancelled, true);
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

test("ensureAuth: expires Device Flow without polling or writing after its deadline", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-device-expiry-"));
  let clock = 0;
  let pollCalls = 0;

  await assert.rejects(ensureAuth({
    home,
    env: { CCDX_DISABLE_TOKEN_DISCOVERY: "1" },
    log: () => {},
    openAndCopyFn: () => {},
    now: () => clock,
    sleepImpl: async (ms, { signal } = {}) => {
      assert.equal(signal, undefined);
      clock += ms;
    },
    fetchImpl: async (url) => {
      if (url.endsWith("/login/device/code")) {
        return jsonResp(200, {
          device_code: "device",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 5,
          expires_in: 2,
        });
      }
      if (url.endsWith("/login/oauth/access_token")) pollCalls += 1;
      throw new Error(`unexpected request ${url}`);
    },
  }), /Login failed: device code expired/);

  assert.equal(clock, 2000);
  assert.equal(pollCalls, 0);
  assert.equal(fs.existsSync(githubTokenPath(home)), false);
});

test("ensureAuth: rejects a token that arrives after the Device Flow deadline", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-device-late-token-"));
  let clock = 0;

  await assert.rejects(ensureAuth({
    home,
    env: { CCDX_DISABLE_TOKEN_DISCOVERY: "1" },
    log: () => {},
    openAndCopyFn: () => {},
    now: () => clock,
    sleepImpl: async (ms) => { clock += ms; },
    fetchImpl: async (url) => {
      if (url.endsWith("/login/device/code")) {
        return jsonResp(200, {
          device_code: "device",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 1,
          expires_in: 2,
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        clock = 2500;
        return jsonResp(200, { access_token: "ghu_too_late" });
      }
      throw new Error(`unexpected request ${url}`);
    },
  }), /Login failed: device code expired/);

  assert.equal(fs.existsSync(githubTokenPath(home)), false);
});

test("ensureAuth: aborts a pending Device Flow poll at its internal deadline", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-device-pending-deadline-"));
  let pollAborted = false;

  await assert.rejects(ensureAuth({
    home,
    env: { CCDX_DISABLE_TOKEN_DISCOVERY: "1" },
    log: () => {},
    openAndCopyFn: () => {},
    sleepImpl: async () => {},
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith("/login/device/code")) {
        return jsonResp(200, {
          device_code: "device",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 0.001,
          expires_in: 0.02,
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            pollAborted = true;
            reject(options.signal.reason || new DOMException("Aborted", "AbortError"));
          };
          options.signal.addEventListener("abort", onAbort, { once: true });
          if (options.signal.aborted) onAbort();
        });
      }
      throw new Error(`unexpected request ${url}`);
    },
  }), /Login failed: device code expired/);

  assert.equal(pollAborted, true);
  assert.equal(fs.existsSync(githubTokenPath(home)), false);
});

test("ensureAuth: bounds a nonterminating non-OK poll body by the Device Flow deadline", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-device-poll-body-deadline-"));
  let bodyCancelled = false;
  const body = {
    getReader() {
      return {
        read: async () => new Promise(() => {}),
        cancel: async () => { bodyCancelled = true; },
        releaseLock() {},
      };
    },
    cancel: async () => { bodyCancelled = true; },
  };

  await assert.rejects(ensureAuth({
    home,
    env: { CCDX_DISABLE_TOKEN_DISCOVERY: "1" },
    log: () => {},
    openAndCopyFn: () => {},
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      if (url.endsWith("/login/device/code")) {
        return jsonResp(200, {
          device_code: "device",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 0.001,
          expires_in: 0.02,
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        return { ok: false, status: 503, headers: new Headers(), body };
      }
      throw new Error(`unexpected request ${url}`);
    },
  }), /Login failed: device code expired/);

  assert.equal(bodyCancelled, true);
  assert.equal(fs.existsSync(githubTokenPath(home)), false);
});

test("ensureAuth: bounds a nonterminating successful poll body by the Device Flow deadline", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-device-success-body-deadline-"));
  let bodyCancelled = false;
  const body = {
    getReader() {
      return {
        read: async () => new Promise(() => {}),
        cancel: async () => { bodyCancelled = true; },
        releaseLock() {},
      };
    },
    cancel: async () => { bodyCancelled = true; },
  };

  await assert.rejects(ensureAuth({
    home,
    env: { CCDX_DISABLE_TOKEN_DISCOVERY: "1" },
    log: () => {},
    openAndCopyFn: () => {},
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      if (url.endsWith("/login/device/code")) {
        return jsonResp(200, {
          device_code: "device",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 0.001,
          expires_in: 0.02,
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        return { ok: true, status: 200, headers: new Headers(), body };
      }
      throw new Error(`unexpected request ${url}`);
    },
  }), /Login failed: device code expired/);

  assert.equal(bodyCancelled, true);
  assert.equal(fs.existsSync(githubTokenPath(home)), false);
});

test("ensureAuth: preserves caller abort during a successful poll body", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-device-poll-abort-"));
  const controller = new AbortController();
  const reason = new Error("cancel poll body");
  let bodyCancelled = false;
  let bodyStarted;
  const bodyIsStarted = new Promise((resolve) => { bodyStarted = resolve; });
  const body = {
    getReader() {
      return {
        read: async () => {
          bodyStarted();
          return new Promise(() => {});
        },
        cancel: async () => { bodyCancelled = true; },
        releaseLock() {},
      };
    },
    cancel: async () => { bodyCancelled = true; },
  };
  const pending = ensureAuth({
    home,
    env: { CCDX_DISABLE_TOKEN_DISCOVERY: "1" },
    signal: controller.signal,
    log: () => {},
    openAndCopyFn: () => {},
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      if (url.endsWith("/login/device/code")) {
        return jsonResp(200, {
          device_code: "device",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 0.001,
          expires_in: 60,
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        return { ok: true, status: 200, headers: new Headers(), body };
      }
      throw new Error(`unexpected request ${url}`);
    },
  });
  await bodyIsStarted;
  controller.abort(reason);

  await assert.rejects(pending, reason);
  assert.equal(bodyCancelled, true);
  assert.equal(fs.existsSync(githubTokenPath(home)), false);
});

test("ensureAuth: slow_down increases all later Device Flow polling intervals", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-device-slow-"));
  const waits = [];
  const pollResults = [
    { error: "slow_down" },
    { error: "authorization_pending" },
    { access_token: "ghu_device" },
  ];

  await ensureAuth({
    home,
    env: { CCDX_DISABLE_TOKEN_DISCOVERY: "1" },
    log: () => {},
    openAndCopyFn: () => {},
    now: () => 0,
    sleepImpl: async (ms) => { waits.push(ms); },
    fetchImpl: async (url) => {
      if (url.endsWith("/login/device/code")) {
        return jsonResp(200, {
          device_code: "device",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 1,
          expires_in: 900,
        });
      }
      if (url.endsWith("/login/oauth/access_token")) return jsonResp(200, pollResults.shift());
      if (url.endsWith("/user")) return jsonResp(200, { login: "device-user", id: 1 });
      throw new Error(`unexpected request ${url}`);
    },
  });

  assert.deepEqual(waits, [1000, 6000, 6000]);
  assert.equal(fs.readFileSync(githubTokenPath(home), "utf8"), "ghu_device");
});

test("ensureAuth: an identity timeout never binds old metadata to a new token", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-identity-timeout-"));
  writeToken("ghu_old", home, { login: "old-user", id: 1 });
  fs.writeFileSync(githubTokenPath(home), "");

  await ensureAuth({
    home,
    env: { CCDX_DISABLE_TOKEN_DISCOVERY: "1" },
    log: () => {},
    openAndCopyFn: () => {},
    now: () => 0,
    sleepImpl: async () => {},
    githubIdentityTimeoutMs: 10,
    fetchImpl: async (url) => {
      if (url.endsWith("/login/device/code")) {
        return jsonResp(200, {
          device_code: "device",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 1,
          expires_in: 900,
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        return jsonResp(200, { access_token: "ghu_new" });
      }
      if (url.endsWith("/user")) return new Promise(() => {});
      throw new Error(`unexpected request ${url}`);
    },
  });

  assert.equal(fs.readFileSync(githubTokenPath(home), "utf8"), "ghu_new");
  assert.equal(fs.existsSync(githubTokenMetadataPath(home)), false);
  assert.equal(readGithubTokenMetadata(home, "ghu_new"), null);
});

test("ensureAuth: aborting Device Flow sleep stops before polling or writing", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-device-abort-"));
  const controller = new AbortController();
  const reason = new Error("stop login");
  let pollCalls = 0;

  await assert.rejects(ensureAuth({
    home,
    env: { CCDX_DISABLE_TOKEN_DISCOVERY: "1" },
    signal: controller.signal,
    log: () => {},
    openAndCopyFn: () => {},
    now: () => 0,
    sleepImpl: async (_ms, { signal } = {}) => {
      controller.abort(reason);
      assert.equal(signal.reason, reason);
    },
    fetchImpl: async (url) => {
      if (url.endsWith("/login/device/code")) {
        return jsonResp(200, {
          device_code: "device",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 1,
          expires_in: 900,
        });
      }
      if (url.endsWith("/login/oauth/access_token")) pollCalls += 1;
      throw new Error(`unexpected request ${url}`);
    },
  }), reason);

  assert.equal(pollCalls, 0);
  assert.equal(fs.existsSync(githubTokenPath(home)), false);
});

test("ensureAuth: consumes non-2xx Device Flow bodies and preserves retry and error copy", async () => {
  const retryHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-device-drain-"));
  let retryBodyReads = 0;
  let polls = 0;

  await ensureAuth({
    home: retryHome,
    env: { CCDX_DISABLE_TOKEN_DISCOVERY: "1" },
    log: () => {},
    openAndCopyFn: () => {},
    now: () => 0,
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      if (url.endsWith("/login/device/code")) {
        return jsonResp(200, {
          device_code: "device",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 1,
          expires_in: 900,
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        polls += 1;
        if (polls === 1) {
          return new Response(new ReadableStream({
            pull(controller) {
              retryBodyReads += 1;
              controller.enqueue(Buffer.from("retry"));
              controller.close();
            },
          }), { status: 503 });
        }
        return jsonResp(200, { access_token: "ghu_after_retry" });
      }
      if (url.endsWith("/user")) return jsonResp(200, { login: "retry-user", id: 2 });
      throw new Error(`unexpected request ${url}`);
    },
  });

  assert.equal(retryBodyReads, 1);
  assert.equal(fs.readFileSync(githubTokenPath(retryHome), "utf8"), "ghu_after_retry");

  const errorHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-device-code-drain-"));
  let oversizedCancelled = false;
  await assert.rejects(ensureAuth({
    home: errorHome,
    env: { CCDX_DISABLE_TOKEN_DISCOVERY: "1" },
    log: () => {},
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.alloc(40 * 1024));
        controller.enqueue(Buffer.alloc(40 * 1024));
      },
      cancel() { oversizedCancelled = true; },
    }), { status: 500 }),
  }), /device code request failed: 500/);
  assert.equal(oversizedCancelled, true);
});

test("ensureAuth: bounds a nonterminating device-code response with an internal deadline", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-device-code-timeout-"));
  let bodyCancelled = false;
  const body = {
    getReader() {
      return {
        read: async () => new Promise(() => {}),
        cancel: async () => { bodyCancelled = true; },
        releaseLock() {},
      };
    },
    cancel: async () => { bodyCancelled = true; },
  };

  await assert.rejects(ensureAuth({
    home,
    env: { CCDX_DISABLE_TOKEN_DISCOVERY: "1" },
    log: () => {},
    deviceCodeTimeoutMs: 20,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body,
      json: async () => new Promise(() => {}),
    }),
  }), (error) => error.code === "CCDX_DEVICE_CODE_TIMEOUT");

  assert.equal(bodyCancelled, true);
  assert.equal(fs.existsSync(githubTokenPath(home)), false);
});

test("ensureAuth: rejects oversized successful device-code and poll JSON bodies", async (t) => {
  const oversizedResponse = (onCancel) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('{"padding":"'));
      controller.enqueue(Buffer.alloc(70 * 1024, 0x61));
      controller.enqueue(Buffer.from('"}'));
    },
    cancel: onCancel,
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  await t.test("device code", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-device-code-oversized-"));
    let cancelled = false;
    await assert.rejects(ensureAuth({
      home,
      env: { CCDX_DISABLE_TOKEN_DISCOVERY: "1" },
      log: () => {},
      fetchImpl: async () => oversizedResponse(() => { cancelled = true; }),
    }), (error) => error.code === "ccdx_upstream_response_too_large");
    assert.equal(cancelled, true);
    assert.equal(fs.existsSync(githubTokenPath(home)), false);
  });

  await t.test("poll", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-device-poll-oversized-"));
    let cancelled = false;
    await assert.rejects(ensureAuth({
      home,
      env: { CCDX_DISABLE_TOKEN_DISCOVERY: "1" },
      log: () => {},
      openAndCopyFn: () => {},
      sleepImpl: async () => {},
      fetchImpl: async (url) => {
        if (url.endsWith("/login/device/code")) {
          return jsonResp(200, {
            device_code: "device",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            interval: 1,
            expires_in: 900,
          });
        }
        if (url.endsWith("/login/oauth/access_token")) {
          return oversizedResponse(() => { cancelled = true; });
        }
        throw new Error(`unexpected request ${url}`);
      },
    }), (error) => error.code === "ccdx_upstream_response_too_large");
    assert.equal(cancelled, true);
    assert.equal(fs.existsSync(githubTokenPath(home)), false);
  });
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

test("writeToken: commits metadata last as a 0600 pair", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-pair-order-"));
  const writes = [];

  writeToken("ghu_pair", home, { login: "pair-user", id: 3 }, {
    now: () => new Date("2026-08-28T00:00:00.000Z"),
    writeFile: (filePath, data, options) => {
      writes.push(filePath);
      atomicWriteFileSync(filePath, data, options);
    },
  });

  assert.deepEqual(writes, [githubTokenPath(home), githubTokenMetadataPath(home)]);
  assert.equal(fs.statSync(githubTokenPath(home)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(githubTokenMetadataPath(home)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(githubTokenPath(home))).mode & 0o777, 0o700);
  assert.equal(readGithubTokenMetadata(home, "ghu_pair").login, "pair-user");
});

test("writeToken: metadata failure restores previous bytes, existence, and modes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-pair-rollback-"));
  writeToken("ghu_old", home, { login: "old-user", id: 4 });
  fs.chmodSync(githubTokenPath(home), 0o640);
  fs.chmodSync(githubTokenMetadataPath(home), 0o604);
  const oldToken = fs.readFileSync(githubTokenPath(home));
  const oldMetadata = fs.readFileSync(githubTokenMetadataPath(home));
  let writes = 0;

  assert.throws(() => writeToken("ghu_new", home, { login: "new-user", id: 5 }, {
    writeFile: (filePath, data, options) => {
      writes += 1;
      if (writes === 2) throw new Error("simulated Codex metadata failure");
      atomicWriteFileSync(filePath, data, options);
    },
  }), /simulated Codex metadata failure/);

  assert.deepEqual(fs.readFileSync(githubTokenPath(home)), oldToken);
  assert.deepEqual(fs.readFileSync(githubTokenMetadataPath(home)), oldMetadata);
  assert.equal(fs.statSync(githubTokenPath(home)).mode & 0o777, 0o640);
  assert.equal(fs.statSync(githubTokenMetadataPath(home)).mode & 0o777, 0o604);
});

test("writeToken: a token without identity removes stale metadata last", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-pair-unbound-"));
  writeToken("ghu_bound", home, { login: "bound-user", id: 6 });

  writeToken("ghu_unbound", home);

  assert.equal(fs.readFileSync(githubTokenPath(home), "utf8"), "ghu_unbound");
  assert.equal(fs.existsSync(githubTokenMetadataPath(home)), false);
  assert.equal(fs.statSync(githubTokenPath(home)).mode & 0o777, 0o600);
});
