import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { githubTokenPath } from "../src/auth.mjs";
import {
  collectDoctorChecks,
  inspectAdapterCompatibility,
  inspectAuthProfiles,
  inspectAuthProfilesOnline,
  inspectCodexConfig,
  inspectGitHubTokenOnline,
  runDoctor,
  selectCompatibilityModels,
} from "../src/doctor.mjs";

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function configuredHome(host = "127.0.0.1") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-doctor-"));
  writeFile(githubTokenPath(home), "ghu_test\n");
  const urlHost = host.includes(":") ? `[${host}]` : host;
  writeFile(path.join(home, ".codex", "config.toml"), `openai_base_url = "http://${urlHost}:2026/v1"

[shell_environment_policy]
inherit = "core"

[shell_environment_policy.set]
OPENAI_BASE_URL = "http://${urlHost}:2026/v1"
OPENAI_API_KEY = "dummy"
`);
  return home;
}

test("collectDoctorChecks reports only configured Codex surfaces", async () => {
  const checks = await collectDoctorChecks({
    home: configuredHome(),
    checkAdapter: false,
  });

  assert.equal(checks.every((check) => check.kind === "ok"), true);
  assert.equal(checks.some((check) => /Codex authentication profile uses the legacy path/.test(check.message)), true);
  assert.equal(checks.some((check) => /Codex base URL points/.test(check.message)), true);
  assert.equal(checks.some((check) => /Claude|PM Studio/.test(check.message)), false);
});

test("doctor config checks report missing data and honor IPv6 loopback", async () => {
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-doctor-missing-"));
  const checks = await collectDoctorChecks({ home: missing, checkAdapter: false });
  assert.equal(checks.filter((check) => check.kind === "warn").length, 2);

  const home = configuredHome("::1");
  assert.deepEqual(inspectCodexConfig({ home, host: "::1", port: 2026 }), [
    { kind: "ok", message: "Codex base URL points to http://[::1]:2026/v1" },
    { kind: "ok", message: "Codex shell env local API keys are configured" },
  ]);
});

test("inspectAuthProfiles never exposes credential material", () => {
  const home = configuredHome();
  const checks = inspectAuthProfiles({ home });
  assert.equal(checks.every((check) => check.kind === "ok"), true);
  assert.equal(JSON.stringify(checks).includes("ghu_test"), false);
});

test("inspectGitHubTokenOnline validates Codex access and models without changing the token", async () => {
  const home = configuredHome();
  const before = fs.readFileSync(githubTokenPath(home));
  const calls = [];
  const checks = await inspectGitHubTokenOnline({
    home,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.endsWith("/user")) return Response.json({ login: "octocat", id: 1 });
      if (url.endsWith("/copilot_internal/v2/token")) {
        return Response.json({
          token: "service-token",
          endpoints: { api: "https://api.enterprise.githubcopilot.com" },
        });
      }
      return Response.json({ data: [{ id: "gpt-5.6-sol" }] });
    },
    timeoutMs: 100,
  });

  assert.deepEqual(checks.map(({ kind }) => kind), ["ok", "ok"]);
  assert.match(checks[0].message, /octocat/);
  assert.match(checks[1].message, /1 models/);
  assert.equal(calls[2].url, "https://api.enterprise.githubcopilot.com/models");
  assert.deepEqual(fs.readFileSync(githubTokenPath(home)), before);
});

test("inspectGitHubTokenOnline rejects an unsafe advertised API endpoint before catalog access", async () => {
  const home = configuredHome();
  const calls = [];
  const checks = await inspectGitHubTokenOnline({
    home,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith("/user")) return Response.json({ login: "octocat", id: 1 });
      if (url.endsWith("/copilot_internal/v2/token")) {
        return Response.json({
          token: "service-token",
          endpoints: { api: "https://user:secret@unsafe.example.test" },
        });
      }
      throw new Error(`catalog request must not start: ${url}`);
    },
    timeoutMs: 100,
  });

  assert.equal(calls.length, 2);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].kind, "warn");
  assert.match(checks[0].message, /CCDX_INVALID_COPILOT_API_ENDPOINT/);
});

test("inspectAuthProfilesOnline is Codex-only", async () => {
  const home = configuredHome();
  const checks = await inspectAuthProfilesOnline({
    home,
    fetchImpl: async () => new Response("forbidden", { status: 403 }),
  });
  assert.equal(checks.length, 1);
  assert.match(checks[0].message, /GitHub Copilot authentication failed/);
  await assert.rejects(
    inspectAuthProfilesOnline({ home, profile: "claude" }),
    /Doctor profile must be codex/,
  );
});

test("selectCompatibilityModels prefers a Responses-only GPT model", () => {
  assert.deepEqual(selectCompatibilityModels({ data: [
    { id: "gpt-chat", supported_endpoints: ["/responses", "/chat/completions"] },
    { id: "claude-sonnet", supported_endpoints: ["/chat/completions"] },
    { id: "gpt-responses", supported_endpoints: ["/v1/responses"] },
  ] }), { responsesModel: "gpt-responses" });
});

test("inspectAdapterCompatibility checks auto-review, native Responses, history stream, and compact", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "gpt-responses", supported_endpoints: ["/responses"] }] });
    }
    if (url.endsWith("/v1/responses/compact")) {
      return Response.json({
        id: "compact-1",
        object: "response.compaction",
        output: [{ type: "compaction", encrypted_content: "opaque" }],
      });
    }
    if (body?.stream) {
      return new Response("event: response.completed\ndata: {}\n\n", { status: 200 });
    }
    return Response.json({ id: `resp-${calls.length}`, output: [] });
  };

  const checks = await inspectAdapterCompatibility({ fetchImpl, timeoutMs: 100 });

  assert.deepEqual(checks.map(({ kind }) => kind), ["ok", "ok", "ok", "ok", "ok"]);
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
    "/v1/models",
    "/v1/responses",
    "/v1/responses",
    "/v1/responses",
    "/v1/responses/compact",
  ]);
  assert.equal(calls[1].body.model, "codex-auto-review");
  assert.equal(calls[3].body.previous_response_id, "resp-3");
});

test("inspectAdapterCompatibility isolates an Auto-review failure from native Responses checks", async () => {
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "gpt-responses", supported_endpoints: ["/responses"] }] });
    }
    if (body?.model === "codex-auto-review") {
      return Response.json({ error: "model_not_supported" }, { status: 400 });
    }
    if (url.endsWith("/v1/responses/compact")) {
      return Response.json({
        id: "compact-1",
        object: "response.compaction",
        output: [{ type: "compaction", encrypted_content: "opaque" }],
      });
    }
    if (body?.stream) {
      return new Response("event: response.completed\ndata: {}\n\n", { status: 200 });
    }
    return Response.json({ id: "resp-native", output: [] });
  };

  const checks = await inspectAdapterCompatibility({ fetchImpl, timeoutMs: 100 });

  assert.equal(checks.some((check) => check.kind === "err" && /Codex Auto-review failed/.test(check.message)), true);
  assert.equal(checks.some((check) => check.kind === "ok" && /Native Responses/.test(check.message)), true);
  assert.equal(checks.some((check) => check.kind === "ok" && /Responses stream and history compatibility/.test(check.message)), true);
  assert.equal(checks.some((check) => check.kind === "ok" && /Responses compact/.test(check.message)), true);
});

test("collectDoctorChecks requires a compatible running adapter for compatibility probes", async () => {
  const checks = await collectDoctorChecks({
    home: configuredHome(),
    checkAdapter: false,
    compat: true,
    checkRunningAdapterFn: async () => ({ ok: false }),
  });
  assert.equal(checks.some((check) => check.kind === "err" && /require a running/.test(check.message)), true);
});

test("runDoctor prints a bounded Codex-only summary", async () => {
  const lines = [];
  const checks = await runDoctor({
    home: configuredHome(),
    checkAdapter: false,
    commandName: "ccdx",
    log: (line) => lines.push(line),
  });

  assert.equal(checks.every((check) => check.kind === "ok"), true);
  assert.equal(lines[0], "ccdx doctor");
  assert.match(lines.at(-1), /Summary: 4 passed, 0 warning\(s\), 0 error\(s\)/);
  assert.equal(lines.some((line) => /Claude|PM Studio/.test(line)), false);
});
