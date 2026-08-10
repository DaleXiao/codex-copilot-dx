import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatPmStudioStatus,
  inspectPmStudioStatus,
} from "../src/pm-studio-status.mjs";
import { pmStudioPatchManifestPath } from "../src/pm-studio-setup.mjs";

const recipe = {
  id: "pm-studio-2.9.7",
  version: "2.9.7",
  build: "2090700",
  bundleIdentifier: "com.pm-studio.app",
  sourceAsarSha256: "source-asar-sha256",
  patchedAsarSha256: "patched-asar-sha256",
  patchedHeaderSha256: "patched-header-sha256",
};

const adapterHealth = Object.freeze({
  ok: true,
  name: "codex-copilot-dx",
  pid: 4321,
  version: "0.6.5",
  protocol_version: 2,
  capabilities: ["pm_studio_relay_v1"],
  instance_id: "adapter-fixture",
});

function runtimeData(overrides = {}) {
  return {
    ...adapterHealth,
    profiles: { claude: { mode: "isolated", profile_current: true } },
    routing: { responses: "codex", messages: "claude" },
    requests: {
      by_route: {
        pm_models: {},
        pm_chat_completions: {},
        pm_responses: {},
        pm_embeddings: {},
      },
    },
    ...overrides,
  };
}

function patchedInspection() {
  return {
    state: "patched",
    metadata: {
      version: recipe.version,
      build: recipe.build,
      bundleIdentifier: recipe.bundleIdentifier,
    },
    executableIntegrity: {
      executableSha256: "patched-main-sha256",
      frameworkSha256: "patched-framework-sha256",
    },
    codeSign: {
      identifier: "com.pm-studio.app",
      flags: "0x2(adhoc)",
      runtimeVersion: "14.0.0",
      entitlementsSha256: "entitlements-sha256",
    },
    issues: [],
  };
}

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
    inspectApp: patchedInspection,
    verifyPatchRecord: () => {},
    readClaudeCredentials: () => ({
      configured: true,
      valid: true,
      identity: { login: "personal" },
    }),
    checkRunningAdapterFn: async () => ({
      ok: true,
      baseUrl: "http://127.0.0.1:2026",
      data: adapterHealth,
    }),
    readAdapterStatusFn: async () => ({
      baseUrl: "http://127.0.0.1:2026",
      data: runtimeData(),
    }),
    ...overrides,
  };
}

test("inspectPmStudioStatus reports a fully operational exact patch", async () => {
  const result = await inspectPmStudioStatus(options());
  assert.equal(result.ok, true);
  assert.equal(result.app.state, "patched");
  assert.equal(result.app.recipe, recipe.id);
  assert.equal(result.app.patchRecord.valid, true);
  assert.equal(result.runtime.ok, true);
  assert.equal(result.claude.login, "personal");
  assert.match(formatPmStudioStatus(result), /PM GPT uses the PM Studio bearer/);
});

test("inspectPmStudioStatus reads the installed patch record and fails closed for missing or drifted evidence", async (t) => {
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-pms-status-record-"));
  t.after(() => fs.rmSync(backupRoot, { recursive: true, force: true }));
  const manifestPath = pmStudioPatchManifestPath({ backupRoot, recipe });
  const statusOptions = options({ backupRoot, verifyPatchRecord: undefined });

  const missing = await inspectPmStudioStatus(statusOptions);
  assert.equal(missing.ok, false);
  assert.equal(missing.app.state, "drift");
  assert.equal(missing.app.patchRecord.valid, false);
  assert.match(missing.app.patchRecord.reason, /missing or invalid/);
  assert.doesNotMatch(formatPmStudioStatus(missing), /is patched and verified/);

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const manifest = {
    schema_version: 1,
    kind: "ccdx-pm-studio-backup",
    recipe_id: recipe.id,
    app: {
      bundle_identifier: recipe.bundleIdentifier,
      version: recipe.version,
      build: recipe.build,
    },
    patched: {
      asar_sha256: recipe.patchedAsarSha256,
      asar_header_sha256: recipe.patchedHeaderSha256,
      electron_asar_integrity: { algorithm: "SHA256", hash: recipe.patchedHeaderSha256 },
      binaries: {
        main_executable_sha256: "wrong-main-sha256",
        electron_framework_sha256: "patched-framework-sha256",
      },
      signing_metadata: {
        identifier: "com.pm-studio.app",
        flags: "0x2(adhoc)",
        runtime_version: "14.0.0",
        entitlements_sha256: "entitlements-sha256",
      },
    },
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const drifted = await inspectPmStudioStatus(statusOptions);
  assert.equal(drifted.ok, false);
  assert.equal(drifted.app.state, "drift");
  assert.equal(drifted.app.patchRecord.valid, false);
  assert.match(drifted.app.patchRecord.reason, /differs from the installed patch record/);

  manifest.patched.binaries.main_executable_sha256 = "patched-main-sha256";
  manifest.patched.signing_metadata.flags = "different-flags";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const signingDrift = await inspectPmStudioStatus(statusOptions);
  assert.equal(signingDrift.ok, false);
  assert.equal(signingDrift.app.state, "drift");
  assert.match(signingDrift.app.patchRecord.reason, /signing metadata differs/);

  manifest.patched.signing_metadata.flags = "0x2(adhoc)";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const verified = await inspectPmStudioStatus(statusOptions);
  assert.equal(verified.ok, true);
  assert.equal(verified.app.patchRecord.valid, true);
  assert.match(formatPmStudioStatus(verified), /installed patch record/);
});

test("inspectPmStudioStatus requires isolated Claude routing and every PM relay route from the live adapter", async () => {
  const inherited = await inspectPmStudioStatus(options({
    readAdapterStatusFn: async () => ({
      baseUrl: "http://127.0.0.1:2026",
      data: runtimeData({ profiles: { claude: { mode: "inherited" } } }),
    }),
  }));
  assert.equal(inherited.ok, false);
  assert.match(inherited.runtime.issues.join("\n"), /not isolated/);

  const routes = runtimeData().requests.by_route;
  delete routes.pm_embeddings;
  const missingRoute = await inspectPmStudioStatus(options({
    readAdapterStatusFn: async () => ({
      baseUrl: "http://127.0.0.1:2026",
      data: runtimeData({ requests: { by_route: routes } }),
    }),
  }));
  assert.equal(missingRoute.ok, false);
  assert.match(missingRoute.runtime.issues.join("\n"), /pm_embeddings/);

  const output = formatPmStudioStatus(missingRoute);
  assert.match(output, /PM relay routing is not ready/);
  assert.doesNotMatch(output, /PM relay and isolated Claude routing are verified/);

  const staleProfile = await inspectPmStudioStatus(options({
    readAdapterStatusFn: async () => ({
      baseUrl: "http://127.0.0.1:2026",
      data: runtimeData({ profiles: { claude: { mode: "isolated", profile_current: false } } }),
    }),
  }));
  assert.equal(staleProfile.ok, false);
  assert.match(staleProfile.runtime.issues.join("\n"), /do not match the current isolated profile/);
});

test("inspectPmStudioStatus rejects stale or unreadable live runtime status", async () => {
  const stale = await inspectPmStudioStatus(options({
    readAdapterStatusFn: async () => ({
      baseUrl: "http://127.0.0.1:2026",
      data: runtimeData({ instance_id: "different-instance" }),
    }),
  }));
  assert.equal(stale.ok, false);
  assert.match(stale.runtime.issues.join("\n"), /same adapter instance/);

  const unreadable = await inspectPmStudioStatus(options({
    readAdapterStatusFn: async () => { throw new Error("status endpoint unavailable"); },
  }));
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.runtime.issues.join("\n"), /status endpoint unavailable/);
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
