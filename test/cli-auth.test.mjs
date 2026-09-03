import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { githubTokenMetadataPath, githubTokenPath } from "../src/auth.mjs";
import { githubTokenFingerprint } from "../src/github-identity.mjs";
import {
  authStatus,
  authStatusOnline,
  formatAuthStatus,
  runAuthCommand,
} from "../src/cli-auth.mjs";

function tokenHome({ metadata = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-"));
  const tokenPath = githubTokenPath(home);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, "saved-github-token\n", { mode: 0o600 });
  if (metadata) {
    fs.writeFileSync(githubTokenMetadataPath(home), JSON.stringify({
      login: "octocat",
      id: 1,
      token_fingerprint: githubTokenFingerprint("saved-github-token"),
    }));
  }
  return home;
}

function onlineFetch(calls, { modelStatus = 200 } = {}) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "https://api.github.com/user") {
      return Response.json({ login: "octocat", id: 1 });
    }
    if (url === "https://api.github.com/copilot_internal/v2/token") {
      return Response.json({
        token: "copilot-service-token",
        endpoints: { api: "https://api.enterprise.githubcopilot.com" },
      });
    }
    return Response.json({ data: [{ id: "gpt-5.6-sol" }] }, { status: modelStatus });
  };
}

test("authStatus reports only the Codex profile and routing", () => {
  const home = tokenHome({ metadata: true });
  const snapshot = authStatus({ home });

  assert.deepEqual(Object.keys(snapshot.profiles), ["codex"]);
  assert.deepEqual(snapshot.profiles.codex, {
    configured: true,
    valid: true,
    reason: "",
    login: "octocat",
    id: "1",
    source: "legacy",
  });
  assert.deepEqual(snapshot.routing, { responses: "codex" });
});

test("authStatus accepts the legacy Codex token without metadata", () => {
  const home = tokenHome();
  const tokenPath = githubTokenPath(home);
  const tokenBefore = fs.readFileSync(tokenPath);
  const tokenMtimeBefore = fs.statSync(tokenPath).mtimeMs;

  const snapshot = authStatus({ home });

  assert.equal(snapshot.profiles.codex.configured, true);
  assert.equal(snapshot.profiles.codex.valid, true);
  assert.equal(snapshot.profiles.codex.login, "");
  assert.equal(snapshot.profiles.codex.id, "");
  assert.deepEqual(fs.readFileSync(tokenPath), tokenBefore);
  assert.equal(fs.statSync(tokenPath).mtimeMs, tokenMtimeBefore);
  assert.equal(fs.existsSync(githubTokenMetadataPath(home)), false);
});

test("authStatus keeps unreadable credentials local and non-secret", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-unreadable-"));
  const tokenPath = githubTokenPath(home);
  fs.mkdirSync(tokenPath, { recursive: true });

  const snapshot = authStatus({ home });

  assert.equal(snapshot.profiles.codex.configured, true);
  assert.equal(snapshot.profiles.codex.valid, false);
  assert.equal(snapshot.profiles.codex.reason, "credential_read_failed");
  assert.equal(JSON.stringify(snapshot).includes(tokenPath), false);
});

test("authStatusOnline verifies the Codex account and bounded model catalog", async () => {
  const home = tokenHome();
  const tokenBefore = fs.readFileSync(githubTokenPath(home));
  const calls = [];

  const snapshot = await authStatusOnline({
    home,
    fetchImpl: onlineFetch(calls),
    timeoutMs: 100,
  });

  assert.equal(snapshot.profiles.codex.online.ok, true);
  assert.equal(snapshot.profiles.codex.online.login, "octocat");
  assert.equal(snapshot.profiles.codex.online.models, 1);
  assert.equal(snapshot.profiles.codex.online.upstreamHost, "api.enterprise.githubcopilot.com");
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url, "https://api.enterprise.githubcopilot.com/models");
  assert.equal(calls[2].init.redirect, "error");
  assert.deepEqual(fs.readFileSync(githubTokenPath(home)), tokenBefore);
});

test("authStatusOnline reports independent authentication and catalog failures", async (t) => {
  await t.test("missing token", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-missing-"));
    const snapshot = await authStatusOnline({ home, fetchImpl: async () => { throw new Error("must not fetch"); } });
    assert.equal(snapshot.profiles.codex.online.checked, false);
    assert.equal(snapshot.profiles.codex.online.reason, "unconfigured");
  });

  await t.test("models endpoint", async () => {
    const home = tokenHome();
    const snapshot = await authStatusOnline({
      home,
      fetchImpl: onlineFetch([], { modelStatus: 503 }),
      timeoutMs: 100,
    });
    assert.equal(snapshot.profiles.codex.online.ok, false);
    assert.match(snapshot.profiles.codex.online.reason, /HTTP 503/);
  });

  await t.test("timeout", async () => {
    const home = tokenHome();
    const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    const snapshot = await authStatusOnline({ home, fetchImpl, timeoutMs: 5 });
    assert.equal(snapshot.profiles.codex.online.ok, false);
    assert.match(snapshot.profiles.codex.online.reason, /timed out after 5ms/);
  });
});

test("formatAuthStatus renders single-profile plain and responsive table output", async () => {
  const snapshot = {
    profiles: {
      codex: {
        configured: true,
        valid: true,
        reason: "",
        login: "octocat",
        id: "1",
        source: "legacy",
        online: { ok: true, login: "octocat", models: 4 },
      },
    },
    routing: { responses: "codex" },
  };

  const plain = formatAuthStatus(snapshot, { commandName: "codex-copilot-dx" });
  assert.match(plain, /^codex-copilot-dx auth status/m);
  assert.match(plain, /Codex online: octocat; 4 models/);
  assert.match(plain, /Routing: responses -> codex/);
  assert.doesNotMatch(plain, /Claude/);

  const table = formatAuthStatus(snapshot, {
    format: "auto",
    output: { isTTY: true, columns: 120 },
  });
  assert.match(table, /^PROFILE\s+ACCOUNT\s+LOCAL\s+ONLINE\s+MODELS$/m);
  assert.match(table, /^Codex\s+octocat/m);

  const result = await runAuthCommand({ action: "status", home: tokenHome() });
  assert.equal(result.action, "status");
  await assert.rejects(runAuthCommand({ action: "login" }), /Unsupported auth action/);
});

test("formatAuthStatus neutralizes terminal-control and line injection", () => {
  const snapshot = {
    profiles: {
      codex: {
        configured: true,
        valid: true,
        login: "enterprise",
        online: { ok: false, reason: "blocked\u001b[2J\n[OK] injected" },
      },
    },
    routing: { responses: "codex" },
  };

  for (const [format, columns] of [["table", 32], ["auto", 8]]) {
    const output = formatAuthStatus(snapshot, {
      format,
      output: { isTTY: true, columns },
    });
    assert.doesNotMatch(output, /\u001b/);
    assert.doesNotMatch(output, /\n\[OK\] injected/);
    assert.match(output, /blocked \[OK\] injected/);
  }
});
