import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTH_PROFILE_CLAUDE,
  readAuthProfileCredentials,
  writeClaudeAuthProfile,
} from "../src/auth-profile.mjs";
import { githubTokenMetadataPath, githubTokenPath, writeToken } from "../src/auth.mjs";
import {
  authStatus,
  authStatusOnline,
  authorizeClaudeProfile,
  formatAuthStatus,
  requestDeviceFlowToken,
  runAuthCommand,
  validateClaudeCandidate,
} from "../src/cli-auth.mjs";
import { loadModelCache } from "../src/model-cache.mjs";

function jsonResponse(statusCode, body) {
  const text = JSON.stringify(body);
  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    json: async () => body,
    text: async () => text,
  };
}

function modelResponse(models) {
  return jsonResponse(200, { data: models });
}

function claudeModel(id = "claude-sonnet-test") {
  return {
    id,
    vendor: "Anthropic",
    model_picker_enabled: true,
    policy: { state: "enabled" },
    supported_endpoints: ["/chat/completions"],
  };
}

function writeLocalCopilotAuth(home, appName, token) {
  const filePath = path.join(home, "Library", "Application Support", appName, "auth.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    ghcAuth: { gitHubTokens: { access_token: token } },
  }));
  return filePath;
}

function candidateFetch({ login = "personal", id = 2, models = [claudeModel()] } = {}) {
  return async (url, options = {}) => {
    if (url === "https://api.github.com/user") return jsonResponse(200, { login, id });
    if (url === "https://api.github.com/copilot_internal/v2/token") {
      return jsonResponse(200, {
        token: "copilot_personal",
        expires_at: 9999999999,
        endpoints: { api: "https://api.personal.githubcopilot.com" },
      });
    }
    if (url === "https://api.personal.githubcopilot.com/models") return modelResponse(models);
    throw new Error(`unexpected request ${url} (${options.method || "GET"})`);
  };
}

test("requestDeviceFlowToken: expires after sleep without one extra poll", async () => {
  let clock = 0;
  let polls = 0;

  await assert.rejects(requestDeviceFlowToken({
    log: () => {},
    openAndCopyFn: () => {},
    now: () => clock,
    sleepImpl: async (ms) => { clock += ms; },
    fetchImpl: async (url) => {
      if (url.endsWith("/login/device/code")) {
        return jsonResponse(200, {
          device_code: "device",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 5,
          expires_in: 2,
        });
      }
      polls += 1;
      throw new Error(`unexpected request ${url}`);
    },
  }), /Claude login failed: device code expired/);

  assert.equal(clock, 2000);
  assert.equal(polls, 0);
});

test("requestDeviceFlowToken: drains transient polling bodies and keeps slow_down timing", async () => {
  const waits = [];
  let bodyReads = 0;
  let polls = 0;

  const token = await requestDeviceFlowToken({
    log: () => {},
    openAndCopyFn: () => {},
    now: () => 0,
    sleepImpl: async (ms) => { waits.push(ms); },
    fetchImpl: async (url) => {
      if (url.endsWith("/login/device/code")) {
        return jsonResponse(200, {
          device_code: "device",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 1,
          expires_in: 900,
        });
      }
      polls += 1;
      if (polls === 1) {
        return {
          ok: false,
          status: 503,
          text: async () => { bodyReads += 1; return "retry"; },
        };
      }
      if (polls === 2) return jsonResponse(200, { error: "slow_down" });
      return jsonResponse(200, { access_token: "ghu_claude" });
    },
  });

  assert.equal(token, "ghu_claude");
  assert.equal(bodyReads, 1);
  assert.deepEqual(waits, [1000, 1000, 6000]);
});

test("requestDeviceFlowToken: preserves abort reason and code-request HTTP copy", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel Claude login");
  let polls = 0;
  await assert.rejects(requestDeviceFlowToken({
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
        return jsonResponse(200, {
          device_code: "device",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 1,
          expires_in: 900,
        });
      }
      polls += 1;
      throw new Error(`unexpected request ${url}`);
    },
  }), reason);
  assert.equal(polls, 0);

  let bodyReads = 0;
  await assert.rejects(requestDeviceFlowToken({
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      text: async () => { bodyReads += 1; return "failed"; },
    }),
  }), /Device code request failed with HTTP 500/);
  assert.equal(bodyReads, 1);
});

test("validateClaudeCandidate: accepts a distinct pinned account with Claude models", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-valid-"));
  writeToken("ghu_enterprise", home, { login: "enterprise", id: 1 });

  const result = await validateClaudeCandidate("ghu_personal", {
    home,
    expectedLogin: "PERSONAL",
    fetchImpl: candidateFetch(),
  });

  assert.equal(result.identity.login, "personal");
  assert.deepEqual(result.models.map((model) => model.id), ["claude-sonnet-test"]);
});

test("validateClaudeCandidate: uses the shared Claude chat eligibility rules", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-model-matrix-"));
  writeToken("ghu_enterprise", home, { login: "enterprise", id: 1 });

  const result = await validateClaudeCandidate("ghu_personal", {
    home,
    fetchImpl: candidateFetch({ models: [
      {
        id: "claude-picker-unspecified",
        vendor: "Anthropic",
        supported_endpoints: ["/chat/completions"],
      },
      {
        id: "claude-picker-disabled",
        vendor: "Anthropic",
        model_picker_enabled: false,
        supported_endpoints: ["/chat/completions"],
      },
      {
        id: "claude-policy-disabled",
        vendor: "Anthropic",
        policy: { state: "disabled" },
        supported_endpoints: ["/chat/completions"],
      },
      {
        id: "claude-messages-only",
        vendor: "Anthropic",
        supported_endpoints: ["/v1/messages"],
      },
    ] }),
  });

  assert.deepEqual(result.models.map((model) => model.id), ["claude-picker-unspecified"]);
});

test("validateClaudeCandidate: rejects the wrong pinned account before writing", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-wrong-"));
  writeToken("ghu_enterprise", home, { login: "enterprise", id: 1 });

  await assert.rejects(
    validateClaudeCandidate("ghu_other", {
      home,
      expectedLogin: "personal",
      fetchImpl: candidateFetch({ login: "other", id: 3 }),
    }),
    /does not match requested Claude account personal/,
  );
  assert.equal(readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home }).configured, false);
});

test("validateClaudeCandidate: rejects the existing Codex account", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-same-"));
  writeToken("ghu_enterprise", home, { login: "enterprise", id: 1 });

  await assert.rejects(
    validateClaudeCandidate("ghu_same", {
      home,
      fetchImpl: candidateFetch({ login: "enterprise", id: 1 }),
    }),
    /already the Codex account/,
  );
});

test("validateClaudeCandidate: rejects Copilot accounts without enabled Claude models", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-models-"));
  writeToken("ghu_enterprise", home, { login: "enterprise", id: 1 });

  await assert.rejects(
    validateClaudeCandidate("ghu_personal", {
      home,
      fetchImpl: candidateFetch({
        models: [{
          id: "gpt-test",
          vendor: "OpenAI",
          model_picker_enabled: true,
          supported_endpoints: ["/responses"],
        }],
      }),
    }),
    /advertises no enabled Claude models/,
  );
});

test("authorizeClaudeProfile: uses explicit device flow and leaves legacy Codex files byte-for-byte unchanged", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-device-"));
  writeToken("ghu_enterprise", home, { login: "enterprise", id: 1 });
  const beforeToken = fs.readFileSync(githubTokenPath(home));
  const beforeMetadata = fs.readFileSync(githubTokenMetadataPath(home));
  const beforeTokenMtime = fs.statSync(githubTokenPath(home)).mtimeMs;
  const beforeMetadataMtime = fs.statSync(githubTokenMetadataPath(home)).mtimeMs;
  const urls = [];

  const result = await authorizeClaudeProfile({
    home,
    env: { CCDX_TOKEN_LOCK_TIMEOUT_MS: "1000" },
    expectedLogin: "personal",
    log: () => {},
    openAndCopyFn: () => {},
    sleepImpl: async () => {},
    now: () => 0,
    fetchImpl: async (url, options = {}) => {
      urls.push(url);
      if (url === "https://github.com/login/device/code") {
        return jsonResponse(200, {
          device_code: "device",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 1,
          expires_in: 900,
        });
      }
      if (url === "https://github.com/login/oauth/access_token") {
        return jsonResponse(200, { access_token: "ghu_personal" });
      }
      return candidateFetch()(url, options);
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.identity.login, "personal");
  assert.equal(result.modelCacheSaved, true);
  assert.deepEqual(loadModelCache({ home, profile: "claude" }), result.catalog);
  assert.equal(readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home }).token, "ghu_personal");
  assert.deepEqual(fs.readFileSync(githubTokenPath(home)), beforeToken);
  assert.deepEqual(fs.readFileSync(githubTokenMetadataPath(home)), beforeMetadata);
  assert.equal(fs.statSync(githubTokenPath(home)).mtimeMs, beforeTokenMtime);
  assert.equal(fs.statSync(githubTokenMetadataPath(home)).mtimeMs, beforeMetadataMtime);
  assert.deepEqual(urls, [
    "https://github.com/login/device/code",
    "https://github.com/login/oauth/access_token",
    "https://api.github.com/user",
    "https://api.github.com/copilot_internal/v2/token",
    "https://api.personal.githubcopilot.com/models",
  ]);
});

test("authorizeClaudeProfile: reuses a distinct local Copilot credential before Device Flow", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-reuse-"));
  writeToken("ghu_enterprise", home, { login: "enterprise", id: 1 });
  writeLocalCopilotAuth(home, "Personal Copilot", "ghu_personal");
  const urls = [];
  const lines = [];

  const result = await authorizeClaudeProfile({
    home,
    expectedLogin: "personal",
    log: (line) => lines.push(line),
    fetchImpl: async (url, options = {}) => {
      urls.push(url);
      return candidateFetch()(url, options);
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.identity.login, "personal");
  assert.equal(readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home }).token, "ghu_personal");
  assert.equal(urls.includes("https://github.com/login/device/code"), false);
  assert.equal(urls.filter((url) => url === "https://api.github.com/user").length, 2);
  assert.equal(lines.some((line) => /Reusing a local Copilot credential/.test(line)), true);
});

test("authorizeClaudeProfile: ambiguous local Copilot accounts require an explicit selector", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-ambiguous-"));
  writeToken("ghu_enterprise", home, { login: "enterprise", id: 1 });
  writeLocalCopilotAuth(home, "Personal One", "ghu_personal_one");
  writeLocalCopilotAuth(home, "Personal Two", "ghu_personal_two");
  let deviceRequests = 0;

  await assert.rejects(authorizeClaudeProfile({
    home,
    log: () => {},
    fetchImpl: async (url, options = {}) => {
      if (url === "https://github.com/login/device/code") deviceRequests += 1;
      const token = new Headers(options.headers).get("authorization")?.replace(/^token\s+/i, "");
      if (url === "https://api.github.com/user") {
        const suffix = token === "ghu_personal_one" ? "one" : "two";
        return jsonResponse(200, { login: `personal-${suffix}`, id: suffix === "one" ? 2 : 3 });
      }
      if (url === "https://api.github.com/copilot_internal/v2/token") {
        return jsonResponse(200, { token: "copilot", endpoints: { api: "https://api.personal.githubcopilot.com" } });
      }
      throw new Error(`unexpected request ${url}`);
    },
  }), /Multiple reusable GitHub Copilot accounts were found.*--github-login/);

  assert.equal(deviceRequests, 0);
  assert.equal(readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home }).configured, false);
});

test("authorizeClaudeProfile: failed reauth preserves the old Claude credential", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-reauth-"));
  writeToken("ghu_enterprise", home, { login: "enterprise", id: 1 });
  writeClaudeAuthProfile("ghu_personal_old", { login: "personal", id: 2 }, { home });
  writeLocalCopilotAuth(home, "Reusable Personal", "ghu_should_be_ignored");

  await assert.rejects(
    authorizeClaudeProfile({
      home,
      reauth: true,
      log: () => {},
      openAndCopyFn: () => {},
      sleepImpl: async () => {},
      now: () => 0,
      fetchImpl: async (url, options = {}) => {
        if (url === "https://github.com/login/device/code") {
          return jsonResponse(200, {
            device_code: "device",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            interval: 1,
          });
        }
        if (url === "https://github.com/login/oauth/access_token") {
          return jsonResponse(200, { access_token: "ghu_personal_new" });
        }
        return candidateFetch({ login: "personal-new", id: 3, models: [] })(url, options);
      },
    }),
    /advertises no enabled Claude models/,
  );

  const profile = readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home });
  assert.equal(profile.valid, true);
  assert.equal(profile.token, "ghu_personal_old");
  assert.equal(profile.identity.login, "personal");
});

test("authorizeClaudeProfile: a concurrent Codex account change aborts before committing Claude", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-codex-race-"));
  writeToken("ghu_enterprise", home, { login: "enterprise", id: 1 });

  await assert.rejects(
    authorizeClaudeProfile({
      home,
      env: { CCDX_TOKEN_LOCK_TIMEOUT_MS: "1000" },
      expectedLogin: "personal",
      log: () => {},
      openAndCopyFn: () => {},
      sleepImpl: async () => {},
      now: () => 0,
      fetchImpl: async (url, options = {}) => {
        if (url === "https://github.com/login/device/code") {
          return jsonResponse(200, {
            device_code: "device",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            interval: 1,
            expires_in: 900,
          });
        }
        if (url === "https://github.com/login/oauth/access_token") {
          return jsonResponse(200, { access_token: "ghu_personal" });
        }
        if (url === "https://api.personal.githubcopilot.com/models") {
          writeToken("ghu_personal_codex", home, { login: "personal", id: 2 });
          return modelResponse([claudeModel()]);
        }
        return candidateFetch()(url, options);
      },
    }),
    /Codex authentication changed while Claude was being authorized/,
  );

  const claude = readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home });
  assert.equal(claude.configured, false);
  assert.equal(claude.valid, false);
});

test("authorizeClaudeProfile: an existing profile cannot silently ignore a different login pin", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-pin-existing-"));
  writeToken("ghu_enterprise", home, { login: "enterprise", id: 1 });
  writeClaudeAuthProfile("ghu_personal", { login: "personal", id: 2 }, { home });
  const before = readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home });
  let fetchCalls = 0;

  await assert.rejects(
    authorizeClaudeProfile({
      home,
      expectedLogin: "another-personal",
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("must not fetch");
      },
    }),
    /already authenticated as personal; use --reauth/,
  );

  assert.equal(fetchCalls, 0);
  const after = readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home });
  assert.equal(after.token, before.token);
  assert.deepEqual(after.metadata, before.metadata);
});

test("authorizeClaudeProfile: cache failure warns without rolling back valid authentication", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-cache-failure-"));
  writeToken("ghu_enterprise", home, { login: "enterprise", id: 1 });
  const lines = [];

  const result = await authorizeClaudeProfile({
    home,
    log: (line) => lines.push(line),
    openAndCopyFn: () => {},
    sleepImpl: async () => {},
    now: () => 0,
    saveModelCacheFn: () => { throw new Error("disk full"); },
    fetchImpl: async (url, options = {}) => {
      if (url === "https://github.com/login/device/code") {
        return jsonResponse(200, {
          device_code: "device",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 1,
        });
      }
      if (url === "https://github.com/login/oauth/access_token") {
        return jsonResponse(200, { access_token: "ghu_personal" });
      }
      return candidateFetch()(url, options);
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.modelCacheSaved, false);
  assert.equal(readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home }).valid, true);
  assert.equal(lines.some((line) => /model cache could not be saved \(disk full\)/.test(line)), true);
});

test("authorizeClaudeProfile: concurrent first-time callers share one device flow", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-concurrent-"));
  writeToken("ghu_enterprise", home, { login: "enterprise", id: 1 });
  let deviceRequests = 0;
  let releaseSleep;
  let sleepStarted;
  const sleeping = new Promise((resolve) => { sleepStarted = resolve; });
  const fetchImpl = async (url, options = {}) => {
    if (url === "https://github.com/login/device/code") {
      deviceRequests += 1;
      return jsonResponse(200, {
        device_code: "device",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        interval: 1,
      });
    }
    if (url === "https://github.com/login/oauth/access_token") {
      return jsonResponse(200, { access_token: "ghu_personal" });
    }
    return candidateFetch()(url, options);
  };
  const first = authorizeClaudeProfile({
    home,
    fetchImpl,
    log: () => {},
    openAndCopyFn: () => {},
    now: () => 0,
    sleepImpl: async () => {
      sleepStarted();
      await new Promise((resolve) => { releaseSleep = resolve; });
    },
  });
  await sleeping;
  const second = authorizeClaudeProfile({
    home,
    fetchImpl,
    log: () => {},
    openAndCopyFn: () => {},
    now: () => 0,
    sleepImpl: async () => {},
  });
  releaseSleep();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.changed, true);
  assert.equal(secondResult.changed, false);
  assert.equal(deviceRequests, 1);
});

test("authStatus: reports routing without exposing credentials", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-status-"));
  writeToken("ghu_enterprise_secret", home, { login: "enterprise", id: 1 });
  writeClaudeAuthProfile("ghu_personal_secret", { login: "personal", id: 2 }, { home });

  const snapshot = authStatus({ home });
  const output = formatAuthStatus(snapshot);
  assert.equal(snapshot.routing.responses, "codex");
  assert.equal(snapshot.routing.messages, "claude");
  assert.equal(output, [
    "ccdx auth status",
    "[OK] Codex: enterprise [legacy path]",
    "[OK] Claude: personal [isolated profile]",
    "[INFO] Routing: responses -> codex; messages -> claude",
  ].join("\n"));
  assert.doesNotMatch(JSON.stringify(snapshot), /ghu_/);
  assert.doesNotMatch(output, /ghu_/);

  const table = formatAuthStatus(snapshot, {
    format: "auto",
    output: { isTTY: true, columns: 120 },
  });
  assert.match(table, /^PROFILE\s+ACCOUNT\s+MODE\s+LOCAL\s+ONLINE\s+MODELS\s+CLAUDE$/m);
  assert.match(table, /^Codex\s+enterprise\s+legacy path\s+\[OK\] ready\s+\[INFO\] not checked/m);
  assert.match(table, /^Claude\s+personal\s+isolated\s+\[OK\] ready\s+\[INFO\] not checked/m);
  assert.match(table, /\[INFO\] Routing: responses -> codex; messages -> claude$/m);
  assert.doesNotMatch(table, /ghu_/);
});

test("authStatus: an unreadable Claude profile stays isolated without hiding Codex or leaking its path", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-status-unreadable-"));
  writeToken("ghu_enterprise_secret", home, { login: "enterprise", id: 1 });
  const claudeTokenPath = path.join(home, ".local", "share", "copilot-api", "profiles", "claude", "github_token");
  fs.mkdirSync(claudeTokenPath, { recursive: true });

  const snapshot = authStatus({ home });
  const output = formatAuthStatus(snapshot);
  assert.equal(snapshot.profiles.codex.valid, true);
  assert.equal(snapshot.profiles.claude.configured, true);
  assert.equal(snapshot.profiles.claude.valid, false);
  assert.equal(snapshot.profiles.claude.reason, "credential_read_failed");
  assert.equal(snapshot.routing.responses, "codex");
  assert.equal(snapshot.routing.messages, "claude");
  assert.match(output, /Codex: enterprise/);
  assert.match(output, /Claude: invalid \(credential_read_failed\)/);
  assert.doesNotMatch(output, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const compact = formatAuthStatus(snapshot, {
    format: "table",
    output: { isTTY: false, columns: 32 },
  });
  assert.match(compact, /^PROFILE\s+LOCAL\s+ONLINE$/m);
  assert.match(compact, /credential_read_failed/);
  assert.match(compact, /Details:/);
  assert.match(compact, /Routing: responses -> codex; messages -> claude/);
  assert.doesNotMatch(compact, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("authStatus: table details neutralize terminal-control and line injection", () => {
  const snapshot = {
    profiles: {
      codex: {
        configured: true,
        valid: true,
        login: "enterprise",
        online: { ok: false, reason: "blocked\u001b[2J\n[OK] injected" },
      },
      claude: { configured: false, valid: false, online: { inherited: true } },
    },
    routing: { responses: "codex", messages: "codex" },
  };
  const output = formatAuthStatus(snapshot, {
    format: "table",
    output: { isTTY: true, columns: 32 },
  });
  assert.doesNotMatch(output, /\u001b/);
  assert.doesNotMatch(output, /\n\[OK\] injected/);
  assert.match(output, /blocked \[OK\] injected/);

  const auto = formatAuthStatus(snapshot, {
    format: "auto",
    output: { isTTY: true, columns: 8 },
  });
  assert.doesNotMatch(auto, /\u001b/);
  assert.doesNotMatch(auto, /\n\[OK\] injected/);
  assert.match(auto, /blocked \[OK\] injected/);
});

test("auth status --online validates Codex read-only and explains unconfigured Claude inheritance", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-online-inherit-"));
  writeToken("ghu_enterprise", home, { login: "enterprise", id: 1 });
  const urls = [];
  const result = await runAuthCommand({
    action: "status",
    online: true,
    format: "table",
    output: { isTTY: false, columns: 38 },
    home,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url === "https://api.github.com/user") return jsonResponse(200, { login: "enterprise", id: 1 });
      if (url === "https://api.github.com/copilot_internal/v2/token") {
        return jsonResponse(200, {
          token: "copilot_enterprise",
          endpoints: { api: "https://api.enterprise.githubcopilot.com" },
        });
      }
      if (url === "https://api.enterprise.githubcopilot.com/models") {
        return modelResponse([{ id: "gpt-test", model_picker_enabled: true, supported_endpoints: ["/responses"] }]);
      }
      throw new Error(`unexpected request ${url}`);
    },
  });

  assert.equal(result.snapshot.profiles.codex.online.ok, true);
  assert.equal(result.snapshot.profiles.claude.online.inherited, true);
  assert.match(result.output, /^PROFILE\s+LOCAL\s+ONLINE$/m);
  assert.match(result.output, /Claude\s+\[INFO\] inherits Codex\s+\[INFO\] inherits Codex/);
  assert.match(result.output, /Details:/);
  assert.match(result.output, /Claude: inherits Codex \[no isolated profile\]/);
  assert.match(result.output, /Claude online: inherits the Codex profile/);
  assert.match(result.output, /Routing: responses -> codex; messages -> codex/);
  assert.equal(urls.some((url) => url.includes("/login/device")), false);
  assert.equal(fs.existsSync(path.join(home, ".local", "share", "copilot-api", "profiles", "claude")), false);
});

test("authStatusOnline: one profile failure does not hide the other profile result", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-online-independent-"));
  writeToken("ghu_enterprise", home, { login: "enterprise", id: 1 });
  writeClaudeAuthProfile("ghu_personal", { login: "personal", id: 2 }, { home });

  const snapshot = await authStatusOnline({
    home,
    fetchImpl: async (url, options = {}) => {
      const authorization = options.headers?.Authorization || "";
      if (url === "https://api.github.com/user") {
        if (authorization.endsWith("ghu_enterprise")) return jsonResponse(401, {});
        return jsonResponse(200, { login: "personal", id: 2 });
      }
      if (url === "https://api.github.com/copilot_internal/v2/token") {
        return jsonResponse(200, {
          token: "copilot_personal",
          endpoints: { api: "https://api.personal.githubcopilot.com" },
        });
      }
      if (url === "https://api.personal.githubcopilot.com/models") {
        return modelResponse([claudeModel(), { id: "gpt-test", model_picker_enabled: true, supported_endpoints: ["/responses"] }]);
      }
      throw new Error(`unexpected request ${url}`);
    },
  });

  assert.equal(snapshot.profiles.codex.online.ok, false);
  assert.equal(snapshot.profiles.codex.online.reason, "github_token_invalid");
  assert.equal(snapshot.profiles.claude.online.ok, true);
  assert.equal(snapshot.profiles.claude.online.login, "personal");
  assert.equal(snapshot.profiles.claude.online.models, 2);
  assert.equal(snapshot.profiles.claude.online.claudeModels, 1);
});
