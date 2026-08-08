import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatPmStudioStatus,
  inspectPmStudioStatus,
} from "../src/pm-studio-status.mjs";

const recipe = {
  id: "pm-studio-2.9.7",
  version: "2.9.7",
  build: "2090700",
  bundleIdentifier: "com.pm-studio.app",
};

function options(overrides = {}) {
  return {
    appPath: "/Applications/PM Studio.app",
    recipes: [recipe],
    existsSync: () => true,
    operationOverrides: {
      readBundleMetadata: () => ({
        version: recipe.version,
        build: recipe.build,
        bundleIdentifier: recipe.bundleIdentifier,
      }),
    },
    inspectApp: () => ({
      state: "patched",
      metadata: {
        version: recipe.version,
        build: recipe.build,
        bundleIdentifier: recipe.bundleIdentifier,
      },
      issues: [],
    }),
    readClaudeCredentials: () => ({
      configured: true,
      valid: true,
      identity: { login: "personal" },
    }),
    checkRunningAdapterFn: async () => ({
      ok: true,
      baseUrl: "http://127.0.0.1:2026",
      data: { version: "0.6.2" },
    }),
    ...overrides,
  };
}

test("inspectPmStudioStatus reports a fully operational exact patch", async () => {
  const result = await inspectPmStudioStatus(options());
  assert.equal(result.ok, true);
  assert.equal(result.app.state, "patched");
  assert.equal(result.app.recipe, recipe.id);
  assert.equal(result.claude.login, "personal");
  assert.match(formatPmStudioStatus(result), /PM GPT uses the PM Studio bearer/);
});

test("inspectPmStudioStatus fails closed for unsupported versions", async () => {
  let inspected = false;
  const result = await inspectPmStudioStatus(options({
    operationOverrides: {
      readBundleMetadata: () => ({
        version: "3.0.0",
        build: "3000000",
        bundleIdentifier: recipe.bundleIdentifier,
      }),
    },
    inspectApp: () => {
      inspected = true;
      return {};
    },
  }));
  assert.equal(inspected, false);
  assert.equal(result.ok, false);
  assert.equal(result.app.state, "unsupported");
  assert.match(formatPmStudioStatus(result), /no exact patch recipe/);
});

test("inspectPmStudioStatus reports missing optional dependencies without throwing", async () => {
  const result = await inspectPmStudioStatus(options({
    existsSync: () => false,
    readClaudeCredentials: () => ({ configured: false, valid: false, reason: "not configured" }),
    checkRunningAdapterFn: async () => ({ ok: false, baseUrl: "http://127.0.0.1:2026" }),
  }));
  const output = formatPmStudioStatus(result, { commandName: "codex-copilot-dx" });
  assert.equal(result.ok, false);
  assert.match(output, /PM Studio is not installed/);
  assert.match(output, /auth login claude/);
  assert.match(output, /codex-copilot-dx start/);
});
