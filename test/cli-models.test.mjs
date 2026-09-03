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
  const tokenPath = githubTokenPath(home);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, "saved-github-token\n", { mode: 0o600 });
  return home;
}

test("selectableCopilotModels exposes enabled GPT models only", () => {
  const catalog = selectableCopilotModels({ data: [
    model("gpt-5.6-sol", "OpenAI", ["/responses", "ws:/responses"]),
    model("gpt-5.6-sol-fast", "OpenAI", ["/responses"], { preview: true }),
    model("claude-sonnet-5", "Anthropic", ["/chat/completions"]),
    model("hidden", "Microsoft", ["/responses"], { model_picker_enabled: false }),
    model("gpt-unconfigured", "OpenAI", ["/chat/completions"], { policy: { state: "unconfigured" } }),
    model("gpt-embedding", "OpenAI", ["/embeddings"], { capabilities: { type: "embeddings" } }),
    model("gpt-no-picker-field", "OpenAI", ["/responses"], { model_picker_enabled: undefined }),
    model("codex-auto-review", "CCDX", ["/responses"]),
  ] });

  assert.equal(catalog.advertised, 8);
  assert.deepEqual(catalog.models, [
    { id: "gpt-5.6-sol", vendor: "OpenAI", endpoints: ["responses"], preview: false },
    { id: "gpt-5.6-sol-fast", vendor: "OpenAI", endpoints: ["responses"], preview: true },
  ]);
});

test("selectableCopilotModels sanitizes terminal control characters", () => {
  const catalog = selectableCopilotModels({ data: [
    model("gpt-z\u001b[2J", "Vendor\nB", ["/v1/responses"]),
    model("gpt-a", "Vendor A", ["/v1/responses", "/chat/completions"]),
  ] });

  assert.deepEqual(catalog.models, [
    { id: "gpt-a", vendor: "Vendor A", endpoints: ["responses", "chat"], preview: false },
    { id: "gpt-z [2J", vendor: "Vendor B", endpoints: ["responses"], preview: false },
  ]);
  assert.throws(() => selectableCopilotModels({ object: "list" }), /contained no model list/);
});

test("fetchLiveCopilotModels validates the saved Codex token and queries its advertised endpoint", async () => {
  const home = tokenHome();
  const tokenPath = githubTokenPath(home);
  const tokenBefore = fs.readFileSync(tokenPath);
  const tokenMtimeBefore = fs.statSync(tokenPath).mtimeMs;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "https://api.github.com/user") {
      return Response.json({ login: "octocat", id: 1 });
    }
    if (url === "https://api.github.com/copilot_internal/v2/token") {
      return Response.json({
        token: "copilot-service-token",
        endpoints: { api: "https://api.enterprise.githubcopilot.com/regions/eu/" },
      });
    }
    return Response.json({ data: [model("gpt-5.6-sol", "OpenAI", ["/responses"])] });
  };

  const catalog = await fetchLiveCopilotModels({ home, fetchImpl, timeoutMs: 100 });

  assert.equal(catalog.profile, "codex");
  assert.equal(catalog.upstreamHost, "api.enterprise.githubcopilot.com");
  assert.deepEqual(catalog.models.map(({ id }) => id), ["gpt-5.6-sol"]);
  assert.equal(calls[2].url, "https://api.enterprise.githubcopilot.com/regions/eu/models");
  assert.equal(calls[2].init.redirect, "error");
  assert.equal(calls[2].init.headers.Authorization, "Bearer copilot-service-token");
  assert.deepEqual(fs.readFileSync(tokenPath), tokenBefore);
  assert.equal(fs.statSync(tokenPath).mtimeMs, tokenMtimeBefore);
  assert.equal(fs.existsSync(githubTokenMetadataPath(home)), false);
  assert.equal(fs.existsSync(path.join(home, ".local", "share", "codex-copilot-dx")), false);
});

test("fetchLiveCopilotModels rejects unsafe endpoints and stalled lookups", async (t) => {
  await t.test("unsafe advertised API endpoint", async () => {
    const home = tokenHome();
    const calls = [];
    await assert.rejects(fetchLiveCopilotModels({
      home,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.endsWith("/user")) return Response.json({ login: "octocat", id: 1 });
        return Response.json({
          token: "copilot-service-token",
          endpoints: { api: "http://unsafe.example.test?token=leak" },
        });
      },
    }), (error) => error.code === "CCDX_INVALID_COPILOT_API_ENDPOINT");
    assert.equal(calls.length, 2);
  });

  await t.test("timeout", async () => {
    const home = tokenHome();
    const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    await assert.rejects(
      fetchLiveCopilotModels({ home, fetchImpl, timeoutMs: 5 }),
      /timed out after 5ms/,
    );
  });
});

test("fetchLiveCopilotModels reports local and upstream failures", async (t) => {
  await t.test("missing token", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-models-missing-"));
    await assert.rejects(fetchLiveCopilotModels({ home }), /GitHub token not found/);
  });

  await t.test("invalid model JSON", async () => {
    const home = tokenHome();
    let call = 0;
    const fetchImpl = async () => {
      call += 1;
      if (call === 1) return Response.json({ login: "octocat" });
      if (call === 2) return Response.json({ token: "service-token" });
      return new Response("not-json", { status: 200 });
    };
    await assert.rejects(fetchLiveCopilotModels({ home, fetchImpl }), /returned invalid JSON/);
  });

  await t.test("authentication failure", async () => {
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
      if (call === 1) return Response.json({ login: "octocat" });
      if (call === 2) return Response.json({ token: "service-token" });
      return Response.json({ error: "policy denied" }, { status: 403 });
    };
    await assert.rejects(fetchLiveCopilotModels({ home, fetchImpl }), /HTTP 403.*policy denied/);
  });
});

test("formatLiveCopilotModels reports GPT totals and responsive output", () => {
  const catalog = {
    upstreamHost: "api.enterprise.githubcopilot.com",
    advertised: 33,
    models: [
      { id: "gpt-5.6-sol", vendor: "OpenAI", endpoints: ["responses"], preview: false },
      { id: "gpt-5.6-sol-fast", vendor: "OpenAI", endpoints: ["responses"], preview: true },
    ],
  };
  const output = formatLiveCopilotModels(catalog, { commandName: "codex-copilot-dx" });
  assert.match(output, /^codex-copilot-dx models/m);
  assert.match(output, /2 selectable GPT models of 33 advertised/);
  assert.match(output, /Responses: 2; Chat: 0/);
  assert.match(output, /gpt-5\.6-sol-fast \[responses, preview\]/);

  const table = formatLiveCopilotModels(catalog, {
    format: "auto",
    output: { isTTY: true, columns: 120 },
  });
  assert.match(table, /^VENDOR\s+MODEL\s+APIS\s+PREVIEW$/m);

  const narrow = formatLiveCopilotModels(catalog, {
    format: "auto",
    output: { isTTY: true, columns: 8 },
  });
  assert.match(narrow, /\nOpenAI:\n/);
  assert.doesNotMatch(narrow, /VENDOR\/MODEL/);
});
