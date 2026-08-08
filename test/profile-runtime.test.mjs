import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTH_PROFILE_CLAUDE,
  authProfilePaths,
  writeClaudeAuthProfile,
} from "../src/auth-profile.mjs";
import { writeToken } from "../src/auth.mjs";
import { createProfileRuntime } from "../src/profile-runtime.mjs";

function fileSnapshot(filePath) {
  const stat = fs.statSync(filePath);
  return {
    data: fs.readFileSync(filePath),
    mode: stat.mode & 0o777,
    mtimeMs: stat.mtimeMs,
  };
}

function assertFileUnchanged(filePath, before) {
  const after = fileSnapshot(filePath);
  assert.deepEqual(after.data, before.data);
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeMs, before.mtimeMs);
}

test("createProfileRuntime: an unconfigured Claude profile inherits the Codex client without writes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-runtime-inherited-"));
  const codexClient = { profile: "codex" };

  const runtime = createProfileRuntime({ home, codexClient });

  assert.equal(runtime.codexClient, codexClient);
  assert.equal(runtime.claudeClient, codexClient);
  assert.equal(runtime.claudeMode, "inherited");
  assert.deepEqual(runtime.claudeProfile, {
    profile: "claude",
    configured: false,
    valid: false,
    reason: "unconfigured",
    identity: null,
  });
  assert.equal(fs.readdirSync(home).length, 0);
});

test("createProfileRuntime: a valid Claude profile creates an isolated client and remains read-only", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-runtime-isolated-"));
  writeToken("github_enterprise", home, { login: "enterprise-user", id: 1 });
  writeClaudeAuthProfile("github_personal", { login: "personal-user", id: 2 }, { home });
  const paths = authProfilePaths(AUTH_PROFILE_CLAUDE, { home });
  const tokenBefore = fileSnapshot(paths.tokenPath);
  const metadataBefore = fileSnapshot(paths.metadataPath);
  const codexClient = { profile: "codex" };
  const calls = [];

  const runtime = createProfileRuntime({ home, codexClient });
  const token = await runtime.claudeClient.getCopilotToken({
    fetchImpl: async (url, options = {}) => {
      calls.push({
        url: String(url),
        authorization: new Headers(options.headers).get("authorization"),
      });
      return Response.json({
        token: "service_personal",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
        endpoints: { api: "https://personal.example" },
      });
    },
  });

  assert.equal(runtime.codexClient, codexClient);
  assert.notEqual(runtime.claudeClient, codexClient);
  assert.equal(runtime.claudeClient.profile, "claude");
  assert.equal(runtime.claudeMode, "isolated");
  assert.match(runtime.codexCredentialFingerprint, /^[a-f0-9]{24}$/);
  assert.notEqual(runtime.codexCredentialFingerprint, runtime.claudeCredentialFingerprint);
  assert.deepEqual(runtime.claudeProfile, {
    profile: "claude",
    configured: true,
    valid: true,
    reason: "",
    identity: { login: "personal-user", id: "2" },
  });
  assert.equal(token, "service_personal");
  assert.deepEqual(calls, [{
    url: "https://api.github.com/copilot_internal/v2/token",
    authorization: "token github_personal",
  }]);
  assertFileUnchanged(paths.tokenPath, tokenBefore);
  assertFileUnchanged(paths.metadataPath, metadataBefore);
});

test("createProfileRuntime: a token-only Claude artifact fails closed instead of borrowing Codex", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-runtime-partial-"));
  const paths = authProfilePaths(AUTH_PROFILE_CLAUDE, { home });
  fs.mkdirSync(path.dirname(paths.tokenPath), { recursive: true });
  fs.writeFileSync(paths.tokenPath, "github_orphan", { mode: 0o600 });
  const codexClient = { profile: "codex" };
  let fetchCalls = 0;

  const runtime = createProfileRuntime({ home, codexClient });

  assert.notEqual(runtime.claudeClient, codexClient);
  assert.equal(runtime.claudeMode, "isolated");
  assert.equal(runtime.claudeProfile.configured, true);
  assert.equal(runtime.claudeProfile.valid, false);
  assert.equal(runtime.claudeProfile.reason, "missing_metadata");
  await assert.rejects(
    runtime.claudeClient.getCopilotToken({
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("must not fetch");
      },
    }),
    (error) => error.statusCode === 401 && /missing_metadata/.test(error.message),
  );
  assert.equal(fetchCalls, 0);
});

test("createProfileRuntime: a fingerprint mismatch is isolated and fails before every fetch", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-runtime-invalid-"));
  writeClaudeAuthProfile("github_personal", { login: "personal-user", id: 2 }, { home });
  const paths = authProfilePaths(AUTH_PROFILE_CLAUDE, { home });
  fs.writeFileSync(paths.tokenPath, "github_replaced", { mode: 0o600 });
  const tokenBefore = fileSnapshot(paths.tokenPath);
  const metadataBefore = fileSnapshot(paths.metadataPath);
  const codexClient = { profile: "codex" };
  let fetchCalls = 0;

  const runtime = createProfileRuntime({ home, codexClient });

  assert.notEqual(runtime.claudeClient, codexClient);
  assert.equal(runtime.claudeMode, "isolated");
  assert.deepEqual(runtime.claudeProfile, {
    profile: "claude",
    configured: true,
    valid: false,
    reason: "token_metadata_mismatch",
    identity: null,
  });
  assert.equal("token" in runtime.claudeProfile, false);
  assert.equal("paths" in runtime.claudeProfile, false);
  assert.equal("metadata" in runtime.claudeProfile, false);

  await assert.rejects(
    runtime.claudeClient.getCopilotToken({
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("must not fetch");
      },
    }),
    (error) => error.statusCode === 401
      && /token_metadata_mismatch/.test(error.message)
      && /ccdx auth login claude --reauth/.test(error.message),
  );
  assert.equal(fetchCalls, 0);
  assertFileUnchanged(paths.tokenPath, tokenBefore);
  assertFileUnchanged(paths.metadataPath, metadataBefore);
});

test("createProfileRuntime: unreadable Claude credentials fail locally without blocking Codex", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-runtime-unreadable-"));
  const paths = authProfilePaths(AUTH_PROFILE_CLAUDE, { home });
  fs.mkdirSync(paths.tokenPath, { recursive: true });
  const codexClient = { profile: "codex" };
  let fetchCalls = 0;

  const runtime = createProfileRuntime({ home, codexClient });

  assert.equal(runtime.codexClient, codexClient);
  assert.notEqual(runtime.claudeClient, codexClient);
  assert.equal(runtime.claudeMode, "isolated");
  assert.deepEqual(runtime.claudeProfile, {
    profile: "claude",
    configured: true,
    valid: false,
    reason: "credential_read_failed",
    identity: null,
  });
  await assert.rejects(
    runtime.claudeClient.getCopilotToken({
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("must not fetch");
      },
    }),
    (error) => error.statusCode === 401
      && /credential_read_failed/.test(error.message)
      && /ccdx auth login claude --reauth/.test(error.message)
      && !error.message.includes(home),
  );
  assert.equal(fetchCalls, 0);
});
