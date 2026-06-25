import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { githubTokenPath } from "../src/auth.mjs";
import { claudeDesktopPaths } from "../src/claude-desktop-config.mjs";
import { collectDoctorChecks, runDoctor } from "../src/doctor.mjs";

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
