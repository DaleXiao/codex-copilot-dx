import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  applyClaudeDesktopConfig,
  claudeDesktopPaths,
  computeClaudeDesktopMeta,
  computeClaudeDesktopProfile,
  computeDeploymentConfig,
  DEFAULT_CLAUDE_DESKTOP_PROFILE_ID,
  formatClaudeDesktopApplyResult,
  generatedClaudeDesktopApiKey,
  loadManagedClaudeDesktopApiKey,
  validateClaudeDesktopBaseUrl,
} from "../src/claude-desktop-config.mjs";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

test("computeClaudeDesktopProfile: writes flat gateway fields and preserves unrelated settings", () => {
  const profile = computeClaudeDesktopProfile({
    inferenceProvider: "anthropic",
    enterpriseConfig: { ignored: true },
    disableEssentialTelemetry: "true",
  }, {
    baseUrl: "http://127.0.0.1:2026",
    gatewayApiKey: "secret",
    modelIds: ["claude-sonnet-4.6"],
  });

  assert.equal(profile.inferenceProvider, "gateway");
  assert.equal(profile.inferenceGatewayBaseUrl, "http://127.0.0.1:2026");
  assert.equal(profile.inferenceGatewayApiKey, "secret");
  assert.equal(profile.inferenceGatewayAuthScheme, "bearer");
  assert.equal(profile.inferenceModels, '["claude-sonnet-4.6"]');
  assert.equal(profile.disableEssentialTelemetry, "true");
  assert.equal(profile.enterpriseConfig, undefined);
});

test("computeClaudeDesktopMeta: replaces the managed profile entry", () => {
  const meta = computeClaudeDesktopMeta({
    appliedId: "old",
    entries: [
      { id: DEFAULT_CLAUDE_DESKTOP_PROFILE_ID, name: "Old Managed" },
      { id: "keep", name: "Keep" },
    ],
  }, DEFAULT_CLAUDE_DESKTOP_PROFILE_ID, "Managed");

  assert.equal(meta.appliedId, DEFAULT_CLAUDE_DESKTOP_PROFILE_ID);
  assert.deepEqual(meta.entries, [
    { id: "keep", name: "Keep" },
    { id: DEFAULT_CLAUDE_DESKTOP_PROFILE_ID, name: "Managed" },
  ]);
});

test("computeDeploymentConfig: sets 3p deployment mode without dropping other fields", () => {
  assert.deepEqual(computeDeploymentConfig({ a: 1, deploymentMode: "1p" }), {
    a: 1,
    deploymentMode: "3p",
  });
});

test("validateClaudeDesktopBaseUrl: rejects /v1 paths and LAN http", () => {
  assert.doesNotThrow(() => validateClaudeDesktopBaseUrl("http://127.0.0.1:2026"));
  assert.doesNotThrow(() => validateClaudeDesktopBaseUrl("http://[::1]:2026"));
  assert.throws(() => validateClaudeDesktopBaseUrl("http://127.0.0.1:2026/v1"), /root URL/);
  assert.throws(() => validateClaudeDesktopBaseUrl("http://192.168.1.2:2026"), /http only for loopback/);
});

test("applyClaudeDesktopConfig: writes Claude Desktop 3P profile and redacts key in output", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-claude-desktop-"));
  const paths = claudeDesktopPaths(home, "darwin", {});
  writeJson(paths.normalConfigPath, { deploymentMode: "1p", normal: true });
  writeJson(paths.threepConfigPath, { deploymentMode: "1p", threep: true });
  writeJson(paths.metaPath, { appliedId: "old-profile", entries: [{ id: "old-profile", name: "Old" }] });
  writeJson(path.join(paths.configLibraryPath, "old-profile.json"), {
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: "http://127.0.0.1:9999",
    inferenceGatewayApiKey: "old",
    disableEssentialTelemetry: "true",
  });

  const result = applyClaudeDesktopConfig({
    home,
    platform: "darwin",
    env: {},
    port: 2026,
    gatewayApiKey: "secret-client-key",
    modelIds: ["claude-sonnet-4.6"],
  });

  assert.equal(readJson(paths.normalConfigPath).deploymentMode, "3p");
  assert.equal(readJson(paths.threepConfigPath).deploymentMode, "3p");
  assert.equal(readJson(paths.metaPath).appliedId, DEFAULT_CLAUDE_DESKTOP_PROFILE_ID);

  const profile = readJson(result.profilePath);
  assert.equal(profile.inferenceProvider, "gateway");
  assert.equal(profile.inferenceGatewayBaseUrl, "http://127.0.0.1:2026");
  assert.equal(profile.inferenceGatewayApiKey, "secret-client-key");
  assert.equal(profile.disableEssentialTelemetry, "true");
  assert.equal(profile.inferenceModels, '["claude-sonnet-4.6"]');

  const output = formatClaudeDesktopApplyResult(result);
  assert.match(output, /gateway api key: <redacted>/);
  assert.doesNotMatch(output, /secret-client-key/);
});

test("applyClaudeDesktopConfig: brackets IPv6 loopback base URLs", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-claude-desktop-ipv6-"));
  const result = applyClaudeDesktopConfig({
    home,
    platform: "darwin",
    env: {},
    host: "::1",
    port: 2026,
    gatewayApiKey: "secret-client-key",
    modelIds: ["claude-sonnet-4.6"],
  });

  assert.equal(readJson(result.profilePath).inferenceGatewayBaseUrl, "http://[::1]:2026");
  assert.equal(loadManagedClaudeDesktopApiKey({ home, platform: "darwin", env: {}, host: "::1", port: 2026 }), "secret-client-key");
});

test("loadManagedClaudeDesktopApiKey: restores only the active matching managed profile", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-claude-desktop-restore-"));
  const result = applyClaudeDesktopConfig({
    home,
    platform: "darwin",
    env: {},
    host: "127.0.0.1",
    port: 2026,
    gatewayApiKey: "persisted-client-key",
    modelIds: ["claude-sonnet-4.6"],
  });

  assert.equal(loadManagedClaudeDesktopApiKey({ home, platform: "darwin", env: {}, port: 2026 }), "persisted-client-key");
  assert.equal(loadManagedClaudeDesktopApiKey({ home, platform: "darwin", env: {}, port: 2027 }), "");

  const paths = claudeDesktopPaths(home, "darwin", {});
  writeJson(paths.metaPath, { appliedId: "another-profile" });
  assert.equal(loadManagedClaudeDesktopApiKey({ home, platform: "darwin", env: {}, port: 2026 }), "");

  writeJson(paths.metaPath, { appliedId: DEFAULT_CLAUDE_DESKTOP_PROFILE_ID });
  fs.writeFileSync(result.profilePath, "not json");
  assert.equal(loadManagedClaudeDesktopApiKey({ home, platform: "darwin", env: {}, port: 2026 }), "");
});

test("generatedClaudeDesktopApiKey: creates a local gateway key prefix", () => {
  assert.match(generatedClaudeDesktopApiKey(), /^ccdx_[a-f0-9]{32}$/);
});
