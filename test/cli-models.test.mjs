import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fetchLiveCopilotModels,
  formatLiveCopilotModels,
  selectableCopilotModels,
} from "../src/cli-models.mjs";
import {
  AUTH_PROFILE_CLAUDE,
  authProfilePaths,
  writeClaudeAuthProfile,
} from "../src/auth-profile.mjs";
import { githubTokenMetadataPath, githubTokenPath } from "../src/auth.mjs";

function model(id, vendor, endpoints, overrides = {}) {
  return {
    id,
    vendor,
    model_picker_enabled: true,
    capabilities: { type: "chat" },
    supported_endpoints: endpoints,
    ...overrides,
  };
}

function tokenHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-models-"));
  const dir = path.join(home, ".local", "share", "copilot-api");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "github_token"), "saved-github-token\n", { mode: 0o600 });
  return home;
}

test("selectableCopilotModels filters hidden, disabled, utility, and unsupported entries", () => {
  const catalog = selectableCopilotModels({ data: [
    model("gpt-5.6-sol", "OpenAI", ["/responses", "ws:/responses"]),
    model("claude-sonnet-5", "Anthropic", ["/chat/completions"], { preview: true }),
    model("hidden", "Microsoft", ["/responses"], { model_picker_enabled: false }),
    model("unconfigured", "Google", ["/chat/completions"], { policy: { state: "unconfigured" } }),
    model("embedding", "OpenAI", ["/embeddings"], { capabilities: { type: "embeddings" } }),
    model("no-picker-field", "OpenAI", ["/responses"], { model_picker_enabled: undefined }),
    model("codex-auto-review", "CCDX", ["/responses"]),
  ] });

  assert.equal(catalog.advertised, 7);
  assert.deepEqual(catalog.models, [
    { id: "claude-sonnet-5", vendor: "Anthropic", endpoints: ["chat"], preview: true },
    { id: "gpt-5.6-sol", vendor: "OpenAI", endpoints: ["responses"], preview: false },
  ]);
});

test("selectableCopilotModels sanitizes terminal control characters and sorts by vendor and id", () => {
  const catalog = selectableCopilotModels({ data: [
    model("z-model\u001b[2J", "Vendor\nB", ["/v1/messages"]),
    model("a-model", "Vendor A", ["/v1/responses", "/chat/completions"]),
  ] });

  assert.deepEqual(catalog.models, [
    { id: "a-model", vendor: "Vendor A", endpoints: ["responses", "chat"], preview: false },
    { id: "z-model [2J", vendor: "Vendor B", endpoints: ["messages"], preview: false },
  ]);
});

test("selectableCopilotModels rejects malformed responses", () => {
  assert.throws(() => selectableCopilotModels({ object: "list" }), /contained no model list/);
});

test("fetchLiveCopilotModels validates the saved token and queries its Copilot API endpoint", async () => {
  const home = tokenHome();
  const tokenPath = githubTokenPath(home);
  const tokenBefore = fs.readFileSync(tokenPath);
  const tokenMtimeBefore = fs.statSync(tokenPath).mtimeMs;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify({ login: "octocat", id: 1 }), { status: 200 });
    }
    if (url === "https://api.github.com/copilot_internal/v2/token") {
      return new Response(JSON.stringify({
        token: "copilot-service-token",
        endpoints: { api: "https://api.enterprise.githubcopilot.com" },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      data: [model("gpt-5.6-sol", "OpenAI", ["/responses"])],
    }), { status: 200 });
  };

  const catalog = await fetchLiveCopilotModels({ home, fetchImpl, timeoutMs: 100 });
  assert.equal(catalog.profile, "codex");
  assert.equal(catalog.upstreamHost, "api.enterprise.githubcopilot.com");
  assert.equal(catalog.advertised, 1);
  assert.equal(catalog.models[0].id, "gpt-5.6-sol");
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url, "https://api.enterprise.githubcopilot.com/models");
  assert.equal(calls[2].init.redirect, "error");
  assert.equal(calls[2].init.headers.Authorization, "Bearer copilot-service-token");
  assert.deepEqual(fs.readFileSync(tokenPath), tokenBefore);
  assert.equal(fs.statSync(tokenPath).mtimeMs, tokenMtimeBefore);
  assert.equal(fs.existsSync(githubTokenMetadataPath(home)), false);
  assert.equal(fs.existsSync(path.join(home, ".local", "share", "codex-copilot-dx")), false);
});

test("fetchLiveCopilotModels reads the isolated Claude profile without falling back to Codex", async () => {
  const home = tokenHome();
  writeClaudeAuthProfile("saved-claude-token", { login: "personal", id: 2 }, { home });
  const claudePaths = authProfilePaths(AUTH_PROFILE_CLAUDE, { home });
  const claudeTokenBefore = fs.readFileSync(claudePaths.tokenPath);
  const claudeMetadataBefore = fs.readFileSync(claudePaths.metadataPath);
  const tokenMtimeBefore = fs.statSync(claudePaths.tokenPath).mtimeMs;
  const metadataMtimeBefore = fs.statSync(claudePaths.metadataPath).mtimeMs;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "https://api.github.com/user") {
      assert.equal(init.headers.Authorization, "token saved-claude-token");
      return new Response(JSON.stringify({ login: "personal", id: 2 }), { status: 200 });
    }
    if (url === "https://api.github.com/copilot_internal/v2/token") {
      assert.equal(init.headers.Authorization, "token saved-claude-token");
      return new Response(JSON.stringify({
        token: "claude-service-token",
        endpoints: { api: "https://api.personal.githubcopilot.com" },
      }), { status: 200 });
    }
    assert.equal(url, "https://api.personal.githubcopilot.com/models");
    assert.equal(init.headers.Authorization, "Bearer claude-service-token");
    return new Response(JSON.stringify({
      data: [model("claude-sonnet-test", "Anthropic", ["/chat/completions"])],
    }), { status: 200 });
  };

  const catalog = await fetchLiveCopilotModels({
    home,
    profile: "claude",
    fetchImpl,
    timeoutMs: 100,
  });

  assert.equal(catalog.profile, "claude");
  assert.equal(catalog.upstreamHost, "api.personal.githubcopilot.com");
  assert.deepEqual(catalog.models.map((entry) => entry.id), ["claude-sonnet-test"]);
  assert.equal(calls.length, 3);
  assert.deepEqual(fs.readFileSync(claudePaths.tokenPath), claudeTokenBefore);
  assert.deepEqual(fs.readFileSync(claudePaths.metadataPath), claudeMetadataBefore);
  assert.equal(fs.statSync(claudePaths.tokenPath).mtimeMs, tokenMtimeBefore);
  assert.equal(fs.statSync(claudePaths.metadataPath).mtimeMs, metadataMtimeBefore);
  assert.equal(fs.existsSync(path.join(home, ".local", "share", "codex-copilot-dx")), false);
});

test("fetchLiveCopilotModels fails closed for missing or invalid Claude credentials", async (t) => {
  await t.test("missing profile", async () => {
    const home = tokenHome();
    await assert.rejects(
      fetchLiveCopilotModels({
        home,
        profile: "claude",
        fetchImpl: async () => { throw new Error("must not use Codex"); },
      }),
      /not configured.*ccdx auth login claude/,
    );
  });

  await t.test("fingerprint mismatch", async () => {
    const home = tokenHome();
    writeClaudeAuthProfile("saved-claude-token", { login: "personal", id: 2 }, { home });
    const paths = authProfilePaths(AUTH_PROFILE_CLAUDE, { home });
    fs.writeFileSync(paths.tokenPath, "replaced-claude-token", { mode: 0o600 });
    await assert.rejects(
      fetchLiveCopilotModels({
        home,
        profile: "claude",
        fetchImpl: async () => { throw new Error("must not use Codex"); },
      }),
      /invalid \(token_metadata_mismatch\).*--reauth/,
    );
  });
});

test("fetchLiveCopilotModels reports missing credentials, auth failures, HTTP errors, and invalid JSON", async (t) => {
  await t.test("missing token", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-models-missing-"));
    await assert.rejects(fetchLiveCopilotModels({ home }), /GitHub token not found/);
  });

  await t.test("auth failure", async () => {
    const home = tokenHome();
    await assert.rejects(
      fetchLiveCopilotModels({
        home,
        fetchImpl: async () => new Response("forbidden", { status: 403 }),
      }),
      /authentication failed: github_token_invalid \(HTTP 403\)/,
    );
  });

  await t.test("models HTTP failure", async () => {
    const home = tokenHome();
    let call = 0;
    const fetchImpl = async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
      if (call === 2) return new Response(JSON.stringify({ token: "service-token" }), { status: 200 });
      return new Response(JSON.stringify({ error: "policy denied" }), { status: 403 });
    };
    await assert.rejects(fetchLiveCopilotModels({ home, fetchImpl }), /HTTP 403.*policy denied/);
  });

  await t.test("invalid JSON", async () => {
    const home = tokenHome();
    let call = 0;
    const fetchImpl = async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
      if (call === 2) return new Response(JSON.stringify({ token: "service-token" }), { status: 200 });
      return new Response("not-json", { status: 200 });
    };
    await assert.rejects(fetchLiveCopilotModels({ home, fetchImpl }), /returned invalid JSON/);
  });
});

test("fetchLiveCopilotModels aborts a stalled live lookup", async () => {
  const home = tokenHome();
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  await assert.rejects(
    fetchLiveCopilotModels({ home, fetchImpl, timeoutMs: 5 }),
    /timed out after 5ms/,
  );
});

test("formatLiveCopilotModels reports live totals, capabilities, previews, and zero Claude", () => {
  const output = formatLiveCopilotModels({
    upstreamHost: "api.enterprise.githubcopilot.com",
    advertised: 33,
    models: [
      { id: "gpt-5.6-sol", vendor: "OpenAI", endpoints: ["responses"], preview: false },
      { id: "gemini-preview", vendor: "Google", endpoints: ["chat"], preview: true },
    ],
  }, { commandName: "codex-copilot-dx" });

  assert.match(output, /^codex-copilot-dx models/m);
  assert.match(output, /Live catalog from api\.enterprise\.githubcopilot\.com: 2 selectable of 33 advertised/);
  assert.match(output, /Responses: 1; Chat: 1; Claude\/Anthropic: 0/);
  assert.match(output, /gemini-preview \[chat, preview\]/);
  assert.match(output, /gpt-5\.6-sol \[responses\]/);
});

test("formatLiveCopilotModels labels only the isolated Claude profile", () => {
  const claude = formatLiveCopilotModels({
    profile: "claude",
    upstreamHost: "api.personal.githubcopilot.com",
    advertised: 1,
    models: [{ id: "claude-sonnet-test", vendor: "Anthropic", endpoints: ["chat"], preview: false }],
  });
  const codex = formatLiveCopilotModels({
    profile: "codex",
    upstreamHost: "api.enterprise.githubcopilot.com",
    advertised: 1,
    models: [{ id: "gpt-test", vendor: "OpenAI", endpoints: ["responses"], preview: false }],
  });

  assert.match(claude, /^ccdx models --profile claude/m);
  assert.match(codex, /^ccdx models$/m);
  assert.doesNotMatch(codex, /--profile codex/);
});
