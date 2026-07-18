import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { githubTokenPath } from "../src/auth.mjs";
import { claudeDesktopPaths } from "../src/claude-desktop-config.mjs";
import {
  collectDoctorChecks,
  inspectClaudeCodeConfig,
  inspectCodexConfig,
  inspectAdapterCompatibility,
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

  assert.equal(lines[0], "codex-copilot-dx doctor");
  assert.equal(lines.some((line) => line.startsWith("[OK] GitHub token found")), true);
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

test("selectCompatibilityModels: prefers a Responses-only GPT model and finds Claude chat", () => {
  assert.deepEqual(selectCompatibilityModels({ data: [
    { id: "gpt-chat", supported_endpoints: ["/responses", "/chat/completions"] },
    { id: "gpt-native", supported_endpoints: ["/responses"] },
    { id: "claude-test", supported_endpoints: ["/chat/completions"] },
  ] }), {
    responsesModel: "gpt-native",
    claudeModel: "claude-test",
  });
});

test("inspectAdapterCompatibility: checks native Responses, history stream, compact, and Anthropic stream", async () => {
  const requests = [];
  const checks = await inspectAdapterCompatibility({
    port: 2026,
    timeoutMs: 1000,
    fetchImpl: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, body });
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [
          { id: "gpt-native", supported_endpoints: ["/responses"] },
          { id: "claude-test", supported_endpoints: ["/chat/completions"] },
        ] }), { status: 200 });
      }
      if (url.endsWith("/v1/responses/compact")) {
        return new Response(JSON.stringify({ id: "resp_compact", output: [] }), { status: 200 });
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
        return new Response(JSON.stringify({ id: "resp_compact", output: [] }), { status: 200 });
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
