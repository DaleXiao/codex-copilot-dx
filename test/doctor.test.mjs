import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { githubTokenPath } from "../src/auth.mjs";
import { readAuthProfileCredentials, writeClaudeAuthProfile } from "../src/auth-profile.mjs";
import { claudeDesktopPaths } from "../src/claude-desktop-config.mjs";
import { saveModelCache } from "../src/model-cache.mjs";
import {
  collectDoctorChecks,
  inspectClaudeCodeConfig,
  inspectCodexConfig,
  inspectAdapterCompatibility,
  inspectAuthProfiles,
  inspectAuthProfilesOnline,
  inspectGitHubTokenOnline,
  runDoctor,
  selectCompatibilityModels,
} from "../src/doctor.mjs";

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeJson(filePath, data) {
  writeFile(filePath, JSON.stringify(data, null, 2) + "\n");
}

function configuredHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-doctor-"));
  writeFile(githubTokenPath(home), "ghu_test\n");
  writeFile(path.join(home, ".codex", "config.toml"), `openai_base_url = "http://127.0.0.1:2026/v1"

[shell_environment_policy]
inherit = "core"

[shell_environment_policy.set]
ANTHROPIC_AUTH_TOKEN = "dummy"
ANTHROPIC_BASE_URL = "http://127.0.0.1:2026"
OPENAI_BASE_URL = "http://127.0.0.1:2026/v1"
OPENAI_API_KEY = "dummy"
`);
  writeJson(path.join(home, ".claude", "settings.json"), {
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:2026",
      ANTHROPIC_AUTH_TOKEN: "dummy",
    },
  });

  const paths = claudeDesktopPaths(home, "darwin", {});
  writeJson(paths.normalConfigPath, { deploymentMode: "3p" });
  writeJson(paths.threepConfigPath, { deploymentMode: "3p" });
  writeJson(paths.metaPath, { appliedId: "profile-1", entries: [{ id: "profile-1", name: "Codex Copilot DX" }] });
  writeJson(path.join(paths.configLibraryPath, "profile-1.json"), {
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: "http://127.0.0.1:2026",
    inferenceGatewayApiKey: "ccdx_secret",
    inferenceGatewayAuthScheme: "bearer",
    inferenceModels: JSON.stringify(["claude-sonnet-4.6"]),
  });
  return home;
}

test("collectDoctorChecks: reports configured clients", async () => {
  const checks = await collectDoctorChecks({
    home: configuredHome(),
    platform: "darwin",
    env: {},
    checkAdapter: false,
  });

  assert.equal(checks.every((check) => check.kind === "ok"), true);
  assert.equal(checks.some((check) => /Codex authentication profile uses the legacy path/.test(check.message)), true);
  assert.equal(checks.some((check) => /Claude authentication profile is not isolated and inherits Codex/.test(check.message)), true);
  assert.equal(checks.some((check) => /Claude App gateway profile points/.test(check.message)), true);
});

test("collectDoctorChecks: reports missing config as warnings", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-doctor-missing-"));
  const checks = await collectDoctorChecks({
    home,
    platform: "darwin",
    env: {},
    checkAdapter: false,
  });

  assert.equal(checks.some((check) => check.kind === "warn" && /GitHub token not found/.test(check.message)), true);
  assert.equal(checks.some((check) => check.kind === "warn" && /Codex config not found/.test(check.message)), true);
  assert.equal(checks.some((check) => check.kind === "warn" && /Claude App gateway profile is not configured/.test(check.message)), true);
});

test("config doctor checks honor an IPv6 loopback adapter", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-doctor-ipv6-"));
  writeFile(path.join(home, ".codex", "config.toml"), `openai_base_url = "http://[::1]:2026/v1"

[shell_environment_policy.set]
ANTHROPIC_AUTH_TOKEN = "dummy"
ANTHROPIC_BASE_URL = "http://[::1]:2026"
OPENAI_BASE_URL = "http://[::1]:2026/v1"
OPENAI_API_KEY = "dummy"
`);
  writeJson(path.join(home, ".claude", "settings.json"), {
    env: { ANTHROPIC_BASE_URL: "http://[::1]:2026", ANTHROPIC_AUTH_TOKEN: "dummy" },
  });

  assert.equal(inspectCodexConfig({ home, host: "::1", port: 2026 }).every((check) => check.kind === "ok"), true);
  assert.equal(inspectClaudeCodeConfig({ home, host: "::1", port: 2026 }).every((check) => check.kind === "ok"), true);
});

test("runDoctor: prints status lines", async () => {
  const lines = [];
  await runDoctor({
    home: configuredHome(),
    platform: "darwin",
    env: {},
    checkAdapter: false,
    log: (line) => lines.push(line),
  });

  assert.equal(lines[0], "ccdx doctor");
  assert.equal(lines.some((line) => line.startsWith("[OK] GitHub token found")), true);
  assert.equal(lines.at(-1).startsWith("[OK] Summary:"), true);
});

test("collectDoctorChecks: includes PM Studio health only when installed", async () => {
  const base = {
    home: configuredHome(),
    platform: "darwin",
    env: {},
    checkAdapter: false,
    checkPmStudio: true,
  };
  const missing = await collectDoctorChecks({
    ...base,
    inspectPmStudioHealthFn: async () => ({ app: { state: "not_installed", metadata: null, issues: [] } }),
  });
  assert.equal(missing.some((check) => /PM Studio/.test(check.message)), false);

  const clean = await collectDoctorChecks({
    ...base,
    inspectPmStudioHealthFn: async () => ({
      app: {
        state: "clean",
        metadata: { version: "2.9.7", build: "2090700" },
        issues: [],
      },
      claude: { valid: true },
      adapter: { ok: true },
    }),
  });
  assert.equal(clean.some((check) => check.fix === "ccdx pms setup"), true);
});

test("collectDoctorChecks: reports a verified predecessor PM Studio patch for migration", async () => {
  const checks = await collectDoctorChecks({
    home: configuredHome(),
    platform: "darwin",
    env: {},
    checkAdapter: false,
    checkPmStudio: true,
    inspectPmStudioHealthFn: async () => ({
      app: {
        state: "predecessor",
        metadata: { version: "2.9.10", build: "2.9.10" },
        issues: [],
      },
      claude: { valid: true },
      adapter: { ok: true },
    }),
  });

  assert.deepEqual(checks.filter((check) => /PM Studio/.test(check.message)), [{
    kind: "warn",
    message: "PM Studio 2.9.10 build 2.9.10 has a verified predecessor split patch",
    fix: "ccdx pms setup",
  }]);
});

test("collectDoctorChecks: offers setup for a clean structurally compatible PM Studio version", async () => {
  const checks = await collectDoctorChecks({
    home: configuredHome(),
    platform: "darwin",
    env: {},
    checkAdapter: false,
    checkPmStudio: true,
    inspectPmStudioHealthFn: async () => ({
      app: {
        state: "clean",
        recipe: "pm-studio-compatible-status-fixture",
        metadata: { version: "2.9.12", build: "2.9.12" },
        issues: [],
      },
      claude: { valid: true },
      adapter: { ok: true },
    }),
  });

  assert.deepEqual(checks.filter((check) => /PM Studio/.test(check.message)), [{
    kind: "warn",
    message: "PM Studio 2.9.12 build 2.9.12 is supported but not patched",
    fix: "ccdx pms setup",
  }]);
});

test("collectDoctorChecks: fails closed when PM Studio compatibility cannot be safely verified", async () => {
  const checks = await collectDoctorChecks({
    home: configuredHome(),
    platform: "darwin",
    env: {},
    checkAdapter: false,
    checkPmStudio: true,
    inspectPmStudioHealthFn: async () => ({
      app: {
        state: "unsupported",
        metadata: { version: "2.9.13", build: "2.9.13" },
        issues: ["multiple compatible backup manifests matched"],
      },
      claude: { valid: true },
      adapter: { ok: true },
    }),
  });

  assert.deepEqual(checks.filter((check) => /PM Studio/.test(check.message)), [{
    kind: "warn",
    message: "PM Studio 2.9.13 build 2.9.13 compatibility cannot be safely verified; no files will be changed",
  }]);
});

test("collectDoctorChecks: reports a running PM relay whose isolated routing is not ready", async () => {
  const checks = await collectDoctorChecks({
    home: configuredHome(),
    platform: "darwin",
    env: {},
    checkAdapter: false,
    checkPmStudio: true,
    inspectPmStudioHealthFn: async () => ({
      app: {
        state: "patched",
        metadata: { version: "2.9.7", build: "2090700" },
        issues: [],
      },
      claude: { valid: true },
      adapter: { ok: true },
      runtime: { ok: false, issues: ["routing mismatch"] },
    }),
  });

  assert.equal(checks.some((check) => check.kind === "ok" && /patch is verified/.test(check.message)), true);
  const routingWarning = checks.find((check) => check.kind === "warn" && /isolated routing is not ready/.test(check.message));
  assert.equal(routingWarning?.fix, "stop the running adapter, then run ccdx start");
});

test("inspectAuthProfiles: reports an isolated Claude account without exposing credentials", () => {
  const home = configuredHome();
  writeClaudeAuthProfile("ghu_personal_secret", { login: "personal", id: 2 }, { home });

  const checks = inspectAuthProfiles({ home });
  const output = JSON.stringify(checks);
  assert.equal(checks.some((check) => /Claude isolated authentication profile is configured for personal/.test(check.message)), true);
  assert.doesNotMatch(output, /ghu_personal_secret/);
  assert.doesNotMatch(output, /token_fingerprint/);
  assert.doesNotMatch(output, /profiles\/claude/);
});

test("inspectGitHubTokenOnline: validates Copilot access and models without changing token", async () => {
  const home = configuredHome();
  const tokenPath = githubTokenPath(home);
  const before = fs.readFileSync(tokenPath, "utf8");
  const calls = [];

  const checks = await inspectGitHubTokenOnline({
    home,
    fetchImpl: async (url, options) => {
      calls.push([url, options.headers.Authorization]);
      if (url.endsWith("/user")) return new Response(JSON.stringify({ login: "dingxiao", id: 42 }), { status: 200 });
      if (url.endsWith("/copilot_internal/v2/token")) {
        return new Response(JSON.stringify({
          token: "copilot_short",
          endpoints: { api: "https://api.enterprise.githubcopilot.com" },
        }), { status: 200 });
      }
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }), { status: 200 });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(checks.every((check) => check.kind === "ok"), true);
  assert.equal(checks.some((check) => /returned 1 models/.test(check.message)), true);
  assert.equal(fs.readFileSync(tokenPath, "utf8"), before);
  assert.deepEqual(calls.map(([url]) => url), [
    "https://api.github.com/user",
    "https://api.github.com/copilot_internal/v2/token",
    "https://api.enterprise.githubcopilot.com/models",
  ]);
});

test("inspectAuthProfilesOnline: all validates isolated profiles independently", async () => {
  const home = configuredHome();
  writeClaudeAuthProfile("ghu_personal", { login: "personal", id: 2 }, { home });
  const calls = [];

  const checks = await inspectAuthProfilesOnline({
    home,
    profile: "all",
    fetchImpl: async (url, options = {}) => {
      const authorization = options.headers?.Authorization || "";
      calls.push([url, authorization]);
      if (url.endsWith("/user")) {
        if (authorization.endsWith("ghu_test")) return new Response("{}", { status: 401 });
        return new Response(JSON.stringify({ login: "personal", id: 2 }), { status: 200 });
      }
      if (url.endsWith("/copilot_internal/v2/token")) {
        return new Response(JSON.stringify({
          token: "copilot_personal",
          endpoints: { api: "https://api.personal.githubcopilot.com" },
        }), { status: 200 });
      }
      if (url === "https://api.personal.githubcopilot.com/models") {
        return new Response(JSON.stringify({ data: [{ id: "claude-test" }] }), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(checks.some((check) => check.kind === "err" && /github_token_invalid/.test(check.message)), true);
  assert.equal(checks.some((check) => check.kind === "ok" && /Claude profile: GitHub Copilot access verified for personal/.test(check.message)), true);
  assert.equal(checks.some((check) => /ghu_|copilot_personal|token_fingerprint/.test(check.message)), false);
  assert.equal(calls.some(([url]) => url.includes("/login/device")), false);
});

test("inspectAuthProfilesOnline: unconfigured Claude validates inherited Codex without writes", async () => {
  const home = configuredHome();
  const tokenPath = githubTokenPath(home);
  const before = fs.readFileSync(tokenPath, "utf8");

  const checks = await inspectAuthProfilesOnline({
    home,
    profile: "claude",
    fetchImpl: async (url) => {
      if (url.endsWith("/user")) return new Response(JSON.stringify({ login: "enterprise", id: 1 }), { status: 200 });
      if (url.endsWith("/copilot_internal/v2/token")) {
        return new Response(JSON.stringify({
          token: "copilot_enterprise",
          endpoints: { api: "https://api.enterprise.githubcopilot.com" },
        }), { status: 200 });
      }
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-test" }] }), { status: 200 });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(checks.some((check) => /inherits Codex authentication/.test(check.message)), true);
  assert.equal(checks.some((check) => /Claude inherited Codex: GitHub Copilot access verified/.test(check.message)), true);
  assert.equal(fs.readFileSync(tokenPath, "utf8"), before);
  assert.equal(fs.existsSync(path.join(home, ".local", "share", "copilot-api", "profiles", "claude")), false);
});

test("runDoctor: includes a non-default profile in the title without changing compat behavior", async () => {
  const lines = [];
  await runDoctor({
    home: configuredHome(),
    platform: "darwin",
    env: {},
    profile: "claude",
    checkAdapter: false,
    log: (line) => lines.push(line),
  });

  assert.equal(lines[0], "ccdx doctor --profile claude");
});

test("selectCompatibilityModels: prefers a Responses-only GPT model and finds Claude chat", () => {
  assert.deepEqual(selectCompatibilityModels({ data: [
    { id: "gpt-chat", supported_endpoints: ["/responses", "/chat/completions"] },
    { id: "gpt-native", supported_endpoints: ["/responses"] },
    { id: "claude-test", supported_endpoints: ["/chat/completions"] },
  ] }), {
    responsesModel: "gpt-native",
    claudeModel: "claude-test",
  });

  assert.deepEqual(selectCompatibilityModels({ data: [
    { id: "gpt-enterprise", supported_endpoints: ["/responses"] },
  ] }, { claudeModels: { data: [
    { id: "claude-personal", supported_endpoints: ["/chat/completions"] },
  ] } }), {
    responsesModel: "gpt-enterprise",
    claudeModel: "claude-personal",
  });
});

test("inspectAdapterCompatibility: checks native Responses, history stream, compact, and Anthropic stream", async () => {
  const requests = [];
  const checks = await inspectAdapterCompatibility({
    port: 2026,
    timeoutMs: 1000,
    claudeMode: "isolated",
    claudeModels: { data: [
      { id: "claude-personal", supported_endpoints: ["/chat/completions"] },
    ] },
    fetchImpl: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, body });
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [
          { id: "gpt-native", supported_endpoints: ["/responses"] },
        ] }), { status: 200 });
      }
      if (url.endsWith("/v1/responses/compact")) {
        return new Response(JSON.stringify({
          id: "resp_compact",
          object: "response.compaction",
          output: [{ type: "compaction", encrypted_content: "state" }],
        }), { status: 200 });
      }
      if (url.endsWith("/v1/responses") && body?.stream) {
        return new Response("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n", { status: 200 });
      }
      if (url.endsWith("/v1/responses")) {
        return new Response(JSON.stringify({ id: "resp_first", output: [] }), { status: 200 });
      }
      if (url.endsWith("/v1/messages")) {
        return new Response("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(checks.every((check) => check.kind === "ok"), true);
  assert.equal(checks.length, 6);
  assert.equal(requests.some((request) => request.body?.model === "codex-auto-review"), true);
  const historyRequest = requests.find((request) => request.body?.previous_response_id);
  assert.equal(historyRequest.body.previous_response_id, "resp_first");
  assert.deepEqual(historyRequest.body.tools, [{ type: "image_generation" }]);
  assert.equal(requests.some((request) => request.url.endsWith("/v1/messages")
    && request.body?.model === "claude-personal"), true);
});

test("inspectAdapterCompatibility: never borrows a Codex Claude model for an isolated profile without a catalog", async () => {
  let messagesRequests = 0;
  const checks = await inspectAdapterCompatibility({
    timeoutMs: 1000,
    claudeMode: "isolated",
    fetchImpl: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [
          { id: "gpt-native", supported_endpoints: ["/responses"] },
          { id: "claude-enterprise", supported_endpoints: ["/chat/completions"] },
        ] }), { status: 200 });
      }
      if (url.endsWith("/v1/messages")) messagesRequests += 1;
      if (url.endsWith("/v1/responses/compact")) {
        return Response.json({
          id: "resp_compact",
          object: "response.compaction",
          output: [{ type: "compaction", encrypted_content: "state" }],
        });
      }
      if (body?.stream) return new Response("event: response.completed\ndata: {}\n\n");
      return Response.json({ id: "resp_native", output: [] });
    },
  });

  assert.equal(messagesRequests, 0);
  assert.equal(checks.some((check) => check.kind === "warn"
    && /isolated Claude model cache is unavailable/.test(check.message)), true);
});

test("inspectAdapterCompatibility: reports Auto-review failure independently", async () => {
  const checks = await inspectAdapterCompatibility({
    timeoutMs: 1000,
    fetchImpl: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [
          { id: "gpt-native", supported_endpoints: ["/responses"] },
        ] }), { status: 200 });
      }
      if (body?.model === "codex-auto-review") {
        return new Response(JSON.stringify({ error: "model_not_supported" }), { status: 400 });
      }
      if (url.endsWith("/v1/responses/compact")) {
        return new Response(JSON.stringify({
          id: "resp_compact",
          object: "response.compaction",
          output: [{ type: "compaction", encrypted_content: "state" }],
        }), { status: 200 });
      }
      if (body?.stream) {
        return new Response("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n", { status: 200 });
      }
      return new Response(JSON.stringify({ id: "resp_native", output: [] }), { status: 200 });
    },
  });

  assert.equal(checks.some((check) => check.kind === "err" && /Codex Auto-review failed/.test(check.message)), true);
  assert.equal(checks.some((check) => check.kind === "ok" && /Native Responses/.test(check.message)), true);
});

test("collectDoctorChecks: compatibility checks require a running compatible adapter", async () => {
  const checks = await collectDoctorChecks({
    home: configuredHome(),
    platform: "darwin",
    env: {},
    checkAdapter: false,
    compat: true,
    checkRunningAdapterFn: async () => ({ ok: false }),
  });

  assert.equal(checks.some((check) => check.kind === "err" && /require a running/.test(check.message)), true);
});

test("collectDoctorChecks: supplies the isolated Claude cache to compatibility checks", async () => {
  const home = configuredHome();
  writeClaudeAuthProfile("ghu_personal", { login: "personal", id: 2 }, { home });
  const claudeCatalog = { data: [
    { id: "claude-personal", supported_endpoints: ["/chat/completions"] },
  ] };
  const claudeCredentials = readAuthProfileCredentials("claude", { home });
  saveModelCache(claudeCatalog, {
    home,
    profile: "claude",
    credentialFingerprint: claudeCredentials.metadata.token_fingerprint,
  });
  let compatibilityOptions;

  await collectDoctorChecks({
    home,
    platform: "darwin",
    env: {},
    checkAdapter: false,
    compat: true,
    checkRunningAdapterFn: async () => ({ ok: true }),
    inspectAdapterCompatibilityFn: async (options) => {
      compatibilityOptions = options;
      return [];
    },
  });

  assert.equal(compatibilityOptions.claudeMode, "isolated");
  assert.deepEqual(compatibilityOptions.claudeModels, claudeCatalog);
});
