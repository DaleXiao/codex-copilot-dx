import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  copilotRuntimeStatus,
  createCopilotClient,
  getCopilotToken,
  listModels,
  resetCopilotTokenForTests,
} from "../src/copilot.mjs";

function writeToken(home, name, token) {
  const filePath = path.join(home, name, "github_token");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, token, { mode: 0o600 });
  return filePath;
}

function authHeader(options) {
  return new Headers(options?.headers).get("authorization");
}

test("createCopilotClient: isolates credentials, API bases, refreshes, and model metadata", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-clients-"));
  const codexPath = writeToken(home, "codex", "github_enterprise");
  const claudePath = writeToken(home, "claude", "github_personal");
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    const authorization = authHeader(options);
    calls.push({ target, authorization });
    if (target === "https://api.github.com/copilot_internal/v2/token") {
      const enterprise = authorization === "token github_enterprise";
      return Response.json({
        token: enterprise ? "service_enterprise" : "service_personal",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
        endpoints: { api: enterprise ? "https://enterprise.example" : "https://personal.example" },
      });
    }
    if (target.endsWith("/models")) {
      const enterprise = target.startsWith("https://enterprise.example");
      return Response.json({
        data: [{
          id: "shared-model",
          supported_endpoints: enterprise ? ["/responses"] : ["/chat/completions"],
        }],
      });
    }
    if (target.endsWith("/chat/completions")) {
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  const codex = createCopilotClient({
    profile: "codex",
    tokenPath: codexPath,
    tokenFetchImpl: fetchImpl,
    allowTokenDiscovery: false,
    readGithubIdentity: () => ({ login: "enterprise-user", id: 1 }),
  });
  const claude = createCopilotClient({
    profile: "claude",
    tokenPath: claudePath,
    tokenFetchImpl: fetchImpl,
    allowTokenDiscovery: false,
    readGithubIdentity: () => ({ login: "personal-user", id: 2 }),
  });

  await Promise.all([
    codex.listModels({ fetchImpl }),
    claude.listModels({ fetchImpl }),
  ]);

  assert.equal(codex.getApiBase(), "https://enterprise.example");
  assert.equal(claude.getApiBase(), "https://personal.example");
  assert.deepEqual(codex.getCachedModelEndpoints("shared-model"), ["/responses"]);
  assert.deepEqual(claude.getCachedModelEndpoints("shared-model"), ["/chat/completions"]);
  assert.equal(codex.runtimeStatus().profile, "codex");
  assert.equal(claude.runtimeStatus().profile, "claude");

  await Promise.all([
    codex.chatCompletions({ model: "shared-model", messages: [] }, { fetchImpl }),
    claude.chatCompletions({ model: "shared-model", messages: [] }, { fetchImpl }),
  ]);

  const chatCalls = calls.filter(({ target }) => target.endsWith("/chat/completions"));
  assert.deepEqual(chatCalls, [
    { target: "https://enterprise.example/chat/completions", authorization: "Bearer service_enterprise" },
    { target: "https://personal.example/chat/completions", authorization: "Bearer service_personal" },
  ]);
  assert.equal(calls.filter(({ target }) => target === "https://api.github.com/copilot_internal/v2/token").length, 2);
});

test("createCopilotClient: request fetch injection never receives the long-lived GitHub token", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-client-fetch-boundary-"));
  const tokenPath = writeToken(home, "codex", "github_enterprise");
  const tokenCalls = [];
  const upstreamCalls = [];
  const tokenFetchImpl = async (url, options = {}) => {
    tokenCalls.push({ target: String(url), authorization: authHeader(options) });
    return Response.json({
      token: "service_enterprise",
      expires_at: Math.floor(Date.now() / 1000) + 1800,
      endpoints: { api: "https://enterprise.example" },
    });
  };
  const requestFetchImpl = async (url, options = {}) => {
    const target = String(url);
    const authorization = authHeader(options);
    upstreamCalls.push({ target, authorization });
    assert.equal(target.startsWith("https://api.github.com/"), false);
    assert.equal(authorization, "Bearer service_enterprise");
    if (target.endsWith("/models")) {
      return Response.json({ data: [{ id: "gpt-test", supported_endpoints: ["/responses"] }] });
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  };
  const client = createCopilotClient({
    profile: "codex",
    tokenPath,
    tokenFetchImpl,
    allowTokenDiscovery: false,
    readGithubIdentity: () => ({ login: "enterprise-user", id: 1 }),
  });

  await client.listModels({ fetchImpl: requestFetchImpl });
  await client.chatCompletions({ model: "gpt-test", messages: [] }, { fetchImpl: requestFetchImpl });
  await client.responses({ model: "gpt-test", input: "hello", stream: false }, { fetchImpl: requestFetchImpl });

  assert.deepEqual(tokenCalls, [{
    target: "https://api.github.com/copilot_internal/v2/token",
    authorization: "token github_enterprise",
  }]);
  assert.deepEqual(upstreamCalls.map(({ target }) => target), [
    "https://enterprise.example/models",
    "https://enterprise.example/chat/completions",
    "https://enterprise.example/responses",
  ]);
});

test("createCopilotClient: starts the upstream phase only after token and payload preparation", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-client-upstream-phase-"));
  const tokenPath = writeToken(home, "codex", "github_enterprise");
  const sequence = [];
  const client = createCopilotClient({
    profile: "codex",
    tokenPath,
    tokenFetchImpl: async () => {
      sequence.push("token");
      return Response.json({
        token: "service_enterprise",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
        endpoints: { api: "https://enterprise.example" },
      });
    },
    allowTokenDiscovery: false,
    readGithubIdentity: () => ({ login: "enterprise-user", id: 1 }),
  });

  await client.responses({ model: "gpt-test", stream: false, input: "hello" }, {
    fetchImpl: async () => {
      sequence.push("fetch");
      return Response.json({ id: "resp_phase", status: "completed", output: [] });
    },
    onUpstreamStart: () => sequence.push("upstream"),
  });

  assert.deepEqual(sequence, ["token", "upstream", "fetch"]);
});

test("createCopilotClient: non-Codex profiles require an isolated credential source", () => {
  assert.throws(
    () => createCopilotClient({ profile: "claude" }),
    /requires an isolated tokenPath or readGithubCredentials loader/,
  );
  assert.throws(
    () => createCopilotClient({ profile: "claude", tokenPath: "" }),
    /requires an isolated tokenPath or readGithubCredentials loader/,
  );
  assert.throws(
    () => createCopilotClient({
      profile: "claude",
      tokenPath: "/profiles/claude/github_token",
      allowTokenDiscovery: true,
    }),
    /cannot enable legacy token discovery/,
  );
});

test("createCopilotClient: a fail-closed Claude refresh does not disturb Codex", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-client-failure-"));
  const codexPath = writeToken(home, "codex", "github_enterprise");
  const claudePath = writeToken(home, "claude", "github_personal_expired");
  let codexTokenCalls = 0;
  let claudeTokenCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    const authorization = authHeader(options);
    if (target === "https://api.github.com/copilot_internal/v2/token") {
      if (authorization === "token github_enterprise") {
        codexTokenCalls += 1;
        return Response.json({
          token: "service_enterprise",
          expires_at: Math.floor(Date.now() / 1000) + 1800,
          endpoints: { api: "https://enterprise.example" },
        });
      }
      claudeTokenCalls += 1;
      return new Response("denied", { status: 401 });
    }
    if (target === "https://enterprise.example/chat/completions") {
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
  const codex = createCopilotClient({
    profile: "codex",
    tokenPath: codexPath,
    tokenFetchImpl: fetchImpl,
    allowTokenDiscovery: false,
    readGithubIdentity: () => ({ login: "enterprise-user", id: 1 }),
  });
  const claude = createCopilotClient({
    profile: "claude",
    tokenPath: claudePath,
    tokenFetchImpl: fetchImpl,
    allowTokenDiscovery: false,
    readGithubIdentity: () => ({ login: "personal-user", id: 2 }),
    reauthMessage: (reason) => `${reason} Reauthorize only the Claude profile.`,
  });

  await codex.chatCompletions({ model: "gpt", messages: [] }, { fetchImpl });
  await assert.rejects(
    claude.chatCompletions({ model: "claude", messages: [] }, { fetchImpl }),
    (error) => error.statusCode === 401 && /only the Claude profile/.test(error.message),
  );
  await codex.chatCompletions({ model: "gpt", messages: [] }, { fetchImpl });

  assert.equal(codexTokenCalls, 1);
  assert.equal(claudeTokenCalls, 1);
  assert.equal(codex.runtimeStatus().token_cached, true);
  assert.equal(claude.runtimeStatus().token_cached, false);
});

test("createCopilotClient: rejects an inactive Claude credential snapshot before token exchange", async () => {
  let fetchCalls = 0;
  const claude = createCopilotClient({
    profile: "claude",
    tokenPath: "/profiles/claude/github_token",
    allowTokenDiscovery: false,
    readGithubCredentials: () => ({
      configured: true,
      valid: false,
      reason: "token_metadata_mismatch",
      token: "must-not-be-used",
    }),
  });

  await assert.rejects(
    claude.getCopilotToken({ fetchImpl: async () => { fetchCalls += 1; } }),
    (error) => error.statusCode === 401
      && /token_metadata_mismatch/.test(error.message)
      && /ccdx auth login claude --reauth/.test(error.message),
  );
  assert.equal(fetchCalls, 0);
});

test("resetCopilotTokenForTests preserves legacy model-flight cancellation semantics", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-default-reset-"));
  writeToken(home, path.join(".local", "share", "copilot-api"), "github_default");
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/copilot_internal/v2/token")) {
      return Response.json({
        token: "service_default",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
      });
    }
    if (target === "https://api.github.com/user") {
      return Response.json({ login: "default-user", id: 1 });
    }
    if (target.endsWith("/models")) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason || new DOMException("Aborted", "AbortError")), { once: true });
      });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  resetCopilotTokenForTests();
  await getCopilotToken({ home, fetchImpl });
  const pending = listModels({ fetchImpl });
  await Promise.resolve();
  assert.equal(copilotRuntimeStatus().model_list_flights, 1);
  resetCopilotTokenForTests();
  assert.equal(copilotRuntimeStatus().model_list_flights, 0);
  await assert.rejects(pending, (error) => error?.name === "AbortError");
});
