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
import { MAX_UPSTREAM_MODEL_CATALOG_BYTES } from "../src/http-transport.mjs";

function writeToken(home, name, token) {
  const filePath = path.join(home, name, "github_token");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, token, { mode: 0o600 });
  return filePath;
}

function authHeader(options) {
  return new Headers(options?.headers).get("authorization");
}

test("createCopilotClient: isolated clients keep credentials, API bases, refreshes, and model metadata separate", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-clients-"));
  const primaryPath = writeToken(home, "primary", "github_enterprise");
  const secondaryPath = writeToken(home, "secondary", "github_secondary");
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    const authorization = authHeader(options);
    calls.push({ target, authorization });
    if (target === "https://api.github.com/copilot_internal/v2/token") {
      const enterprise = authorization === "token github_enterprise";
      return Response.json({
        token: enterprise ? "service_enterprise" : "service_secondary",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
        endpoints: { api: enterprise ? "https://enterprise.example" : "https://secondary.example" },
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

  const primary = createCopilotClient({
    profile: "codex",
    tokenPath: primaryPath,
    tokenFetchImpl: fetchImpl,
    allowTokenDiscovery: false,
    readGithubIdentity: () => ({ login: "enterprise-user", id: 1 }),
  });
  const secondary = createCopilotClient({
    profile: "secondary",
    tokenPath: secondaryPath,
    tokenFetchImpl: fetchImpl,
    allowTokenDiscovery: false,
    readGithubIdentity: () => ({ login: "secondary-user", id: 2 }),
  });

  await Promise.all([
    primary.listModels({ fetchImpl }),
    secondary.listModels({ fetchImpl }),
  ]);

  assert.equal(primary.getApiBase(), "https://enterprise.example");
  assert.equal(secondary.getApiBase(), "https://secondary.example");
  assert.deepEqual(primary.getCachedModelEndpoints("shared-model"), ["/responses"]);
  assert.deepEqual(secondary.getCachedModelEndpoints("shared-model"), ["/chat/completions"]);
  assert.equal(primary.runtimeStatus().profile, "codex");
  assert.equal(secondary.runtimeStatus().profile, "secondary");

  await Promise.all([
    primary.chatCompletions({ model: "shared-model", messages: [] }, { fetchImpl }),
    secondary.chatCompletions({ model: "shared-model", messages: [] }, { fetchImpl }),
  ]);

  const chatCalls = calls.filter(({ target }) => target.endsWith("/chat/completions"));
  assert.deepEqual(chatCalls, [
    { target: "https://enterprise.example/chat/completions", authorization: "Bearer service_enterprise" },
    { target: "https://secondary.example/chat/completions", authorization: "Bearer service_secondary" },
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

test("createCopilotClient: bounds model catalogs before parsing or caching them", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-client-model-limit-"));
  const tokenPath = writeToken(home, "codex", "github_enterprise");
  let cancelled = false;
  const client = createCopilotClient({
    profile: "codex",
    tokenPath,
    tokenFetchImpl: async () => Response.json({
      token: "service_enterprise",
      expires_at: Math.floor(Date.now() / 1000) + 1800,
      endpoints: { api: "https://enterprise.example" },
    }),
    allowTokenDiscovery: false,
    readGithubIdentity: () => ({ login: "enterprise-user", id: 1 }),
  });

  await assert.rejects(client.listModels({
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.alloc(MAX_UPSTREAM_MODEL_CATALOG_BYTES + 1, 0x78));
      },
      cancel() { cancelled = true; },
    }), { status: 200 }),
  }), (error) => error.statusCode === 502 && error.code === "ccdx_upstream_response_too_large");
  assert.equal(cancelled, true);
  assert.equal(client.getCachedModelEndpoints("gpt-test"), null);
});

test("createCopilotClient: non-Codex profiles require an isolated credential source", () => {
  assert.throws(
    () => createCopilotClient({ profile: "secondary" }),
    /requires an isolated tokenPath or readGithubCredentials loader/,
  );
  assert.throws(
    () => createCopilotClient({ profile: "secondary", tokenPath: "" }),
    /requires an isolated tokenPath or readGithubCredentials loader/,
  );
  assert.throws(
    () => createCopilotClient({
      profile: "secondary",
      tokenPath: "/profiles/secondary/github_token",
      allowTokenDiscovery: true,
    }),
    /cannot enable legacy token discovery/,
  );
});

test("createCopilotClient: a fail-closed isolated refresh does not disturb the primary client", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-client-failure-"));
  const primaryPath = writeToken(home, "primary", "github_enterprise");
  const secondaryPath = writeToken(home, "secondary", "github_secondary_expired");
  let primaryTokenCalls = 0;
  let secondaryTokenCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    const authorization = authHeader(options);
    if (target === "https://api.github.com/copilot_internal/v2/token") {
      if (authorization === "token github_enterprise") {
        primaryTokenCalls += 1;
        return Response.json({
          token: "service_enterprise",
          expires_at: Math.floor(Date.now() / 1000) + 1800,
          endpoints: { api: "https://enterprise.example" },
        });
      }
      secondaryTokenCalls += 1;
      return new Response("denied", { status: 401 });
    }
    if (target === "https://enterprise.example/chat/completions") {
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
  const primary = createCopilotClient({
    profile: "codex",
    tokenPath: primaryPath,
    tokenFetchImpl: fetchImpl,
    allowTokenDiscovery: false,
    readGithubIdentity: () => ({ login: "enterprise-user", id: 1 }),
  });
  const secondary = createCopilotClient({
    profile: "secondary",
    tokenPath: secondaryPath,
    tokenFetchImpl: fetchImpl,
    allowTokenDiscovery: false,
    readGithubIdentity: () => ({ login: "secondary-user", id: 2 }),
    reauthMessage: (reason) => `${reason} Reauthorize only the secondary profile.`,
  });

  await primary.chatCompletions({ model: "gpt", messages: [] }, { fetchImpl });
  await assert.rejects(
    secondary.chatCompletions({ model: "alternate", messages: [] }, { fetchImpl }),
    (error) => error.statusCode === 401 && /only the secondary profile/.test(error.message),
  );
  await primary.chatCompletions({ model: "gpt", messages: [] }, { fetchImpl });

  assert.equal(primaryTokenCalls, 1);
  assert.equal(secondaryTokenCalls, 1);
  assert.equal(primary.runtimeStatus().token_cached, true);
  assert.equal(secondary.runtimeStatus().token_cached, false);
});

test("createCopilotClient: rejects an inactive isolated credential snapshot before token exchange", async () => {
  let fetchCalls = 0;
  const secondary = createCopilotClient({
    profile: "secondary",
    tokenPath: "/profiles/secondary/github_token",
    allowTokenDiscovery: false,
    readGithubCredentials: () => ({
      configured: true,
      valid: false,
      reason: "token_metadata_mismatch",
      token: "must-not-be-used",
    }),
  });

  await assert.rejects(
    secondary.getCopilotToken({ fetchImpl: async () => { fetchCalls += 1; } }),
    (error) => error.statusCode === 401
      && /token_metadata_mismatch/.test(error.message)
      && /ccdx auth login secondary --reauth/.test(error.message),
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
