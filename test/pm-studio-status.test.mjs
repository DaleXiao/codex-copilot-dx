import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatPmStudioStatus,
  inspectPmStudioStatus,
  probePmStudioRelay,
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
const recipe210 = {
  ...recipe,
  id: "pm-studio-2.9.10",
  version: "2.9.10",
  build: "2.9.10",
  sourceHeaderSha256: "source-header-sha256",
  sourceExecutableSha256: "source-main-sha256",
  sourceElectronFrameworkSha256: "source-framework-sha256",
  embeddedAsarIntegrity: "absent",
  sourceBundleContent: {
    scheme: "ccdx-bundle-content-v2",
    sha256: "source-bundle-sha256",
    entryCount: 10,
    regularFileCount: 6,
    regularBytes: 1_024,
    symlinkCount: 1,
    xattrCount: 2,
    ignoredXattrs: ["com.apple.quarantine"],
  },
  sourceArtifact: {
    releaseUrl: "https://example.test/releases/2.9.10",
    asset: "PM-Studio-2.9.10-mac-arm64.zip",
    sha256: "source-artifact-sha256",
  },
};
const compatibleRecipe = {
  ...recipe210,
  id: "pm-studio-compatible-status-fixture",
  compatibility: "exact-copilot-config-module-v1",
  version: "2.9.12",
  build: "2.9.12",
  sourceAsarSha256: "compatible-source-asar-sha256",
  sourceHeaderSha256: "compatible-source-header-sha256",
  patchedAsarSha256: "compatible-patched-asar-sha256",
  patchedHeaderSha256: "compatible-patched-header-sha256",
  sourceBundleContent: {
    ...recipe210.sourceBundleContent,
    sha256: "compatible-source-bundle-sha256",
  },
};

const adapterHealth = Object.freeze({
  ok: true,
  name: "codex-copilot-dx",
  pid: 4321,
  version: "0.6.5",
  protocol_version: 2,
  capabilities: ["pm_studio_split_origin_v1"],
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
    resolveCompatibleRecipe: () => recipe,
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
    probePmStudioRelayFn: async () => ({ status: 401, marker: "split-origin-v1" }),
    ...overrides,
  };
}

test("probePmStudioRelay performs an exact credential-free models probe", async () => {
  const calls = [];
  const result = await probePmStudioRelay({
    baseUrl: "http://127.0.0.1:2026",
    fetchImpl: async (...args) => {
      calls.push(args);
      return new Response(JSON.stringify({ error: { code: "invalid_authorization" } }), {
        status: 401,
        headers: { "X-CCDX-PM-Relay": "split-origin-v1" },
      });
    },
  });

  assert.deepEqual(result, { status: 401, marker: "split-origin-v1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "http://127.0.0.1:2026/pm-ccdx/models");
  assert.equal(calls[0][1].method, "GET");
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(new Headers(calls[0][1].headers).has("authorization"), false);
});

test("inspectPmStudioStatus reports a fully operational exact patch", async () => {
  const probeCalls = [];
  const result = await inspectPmStudioStatus(options({
    probePmStudioRelayFn: async (probeOptions) => {
      probeCalls.push(probeOptions);
      return { status: 401, marker: "split-origin-v1" };
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.app.state, "patched");
  assert.equal(result.app.recipe, recipe.id);
  assert.equal(result.app.patchRecord.valid, true);
  assert.equal(result.runtime.ok, true);
  assert.deepEqual(result.runtime.relayProbe, { status: 401, marker: "split-origin-v1" });
  assert.deepEqual(probeCalls, [{ baseUrl: "http://127.0.0.1:2026" }]);
  assert.equal(result.claude.login, "personal");
  assert.match(formatPmStudioStatus(result), /PM GPT uses its native official GitHub Copilot path/);
});

test("inspectPmStudioStatus selects the exact 2.9.10 recipe", async () => {
  let selectedRecipe;
  let resolverCalls = 0;
  const result = await inspectPmStudioStatus(options({
    recipes: [recipe, recipe210],
    resolveCompatibleRecipe: ({ metadata }) => {
      resolverCalls += 1;
      assert.equal(metadata.version, recipe210.version);
      return recipe210;
    },
    operationOverrides: {
      readBundleMetadata: () => ({
        version: recipe210.version,
        build: recipe210.build,
        bundleIdentifier: recipe210.bundleIdentifier,
      }),
    },
    inspectApp: ({ recipe: selected }) => {
      selectedRecipe = selected;
      return {
        ...patchedInspection(),
        metadata: {
          version: selected.version,
          build: selected.build,
          bundleIdentifier: selected.bundleIdentifier,
        },
      };
    },
  }));
  assert.equal(resolverCalls, 1);
  assert.equal(selectedRecipe, recipe210);
  assert.equal(result.app.recipe, recipe210.id);
  assert.match(formatPmStudioStatus(result), /2\.9\.10 build 2\.9\.10/);
});

test("inspectPmStudioStatus reconstructs a compatible patched recipe and verifies its patch record", async () => {
  const resolverCalls = [];
  const verificationCalls = [];
  let inspectedRecipe;
  const result = await inspectPmStudioStatus(options({
    operationOverrides: {
      readBundleMetadata: () => ({
        version: compatibleRecipe.version,
        build: compatibleRecipe.build,
        bundleIdentifier: compatibleRecipe.bundleIdentifier,
      }),
    },
    resolveCompatibleRecipe: (resolverOptions) => {
      resolverCalls.push(resolverOptions);
      return compatibleRecipe;
    },
    inspectApp: ({ recipe: selected }) => {
      inspectedRecipe = selected;
      return {
        ...patchedInspection(),
        metadata: {
          version: selected.version,
          build: selected.build,
          bundleIdentifier: selected.bundleIdentifier,
        },
      };
    },
    verifyPatchRecord: (verification) => verificationCalls.push(verification),
  }));

  assert.equal(result.ok, true);
  assert.equal(result.app.state, "patched");
  assert.equal(result.app.recipe, compatibleRecipe.id);
  assert.equal(result.app.patchRecord.valid, true);
  assert.equal(inspectedRecipe, compatibleRecipe);
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0].metadata.version, compatibleRecipe.version);
  assert.equal(verificationCalls.length, 1);
  assert.equal(verificationCalls[0].recipe, compatibleRecipe);
  assert.match(verificationCalls[0].manifestPath, /pm-studio-compatible-status-fixture/);
});

test("inspectPmStudioStatus reports a local clean compatible structure as ready for setup", async () => {
  const result = await inspectPmStudioStatus(options({
    operationOverrides: {
      readBundleMetadata: () => ({
        version: compatibleRecipe.version,
        build: compatibleRecipe.build,
        bundleIdentifier: compatibleRecipe.bundleIdentifier,
      }),
    },
    resolveCompatibleRecipe: () => compatibleRecipe,
    inspectApp: ({ recipe: selected }) => ({
      state: "clean",
      metadata: {
        version: selected.version,
        build: selected.build,
        bundleIdentifier: selected.bundleIdentifier,
      },
      sourceVerification: "local-content",
      issues: [],
    }),
  }));

  assert.equal(result.ok, false);
  assert.equal(result.app.state, "clean");
  assert.equal(result.app.recipe, compatibleRecipe.id);
  assert.match(formatPmStudioStatus(result), /compatible local patch structure but is not patched; run ccdx pms setup/);
});

test("inspectPmStudioStatus downgrades an unverified compatible patch record to drift", async () => {
  const result = await inspectPmStudioStatus(options({
    operationOverrides: {
      readBundleMetadata: () => ({
        version: compatibleRecipe.version,
        build: compatibleRecipe.build,
        bundleIdentifier: compatibleRecipe.bundleIdentifier,
      }),
    },
    resolveCompatibleRecipe: () => compatibleRecipe,
    inspectApp: () => ({
      ...patchedInspection(),
      metadata: {
        version: compatibleRecipe.version,
        build: compatibleRecipe.build,
        bundleIdentifier: compatibleRecipe.bundleIdentifier,
      },
    }),
    verifyPatchRecord: () => { throw new Error("compatible manifest patch record is corrupt"); },
  }));

  assert.equal(result.ok, false);
  assert.equal(result.app.state, "drift");
  assert.equal(result.app.patchRecipeMatched, true);
  assert.match(result.app.patchRecord.reason, /compatible manifest patch record is corrupt/);
});

test("inspectPmStudioStatus validates local schema 2 source evidence and tolerates legacy provenance", async (t) => {
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-pms-status-schema2-"));
  t.after(() => fs.rmSync(backupRoot, { recursive: true, force: true }));
  const manifestPath = pmStudioPatchManifestPath({ backupRoot, recipe: recipe210 });
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const patchedBundleContent = {
    scheme: "ccdx-bundle-content-v2",
    sha256: "patched-bundle-sha256",
    entryCount: 10,
    regularFileCount: 6,
    regularBytes: 1_000,
    symlinkCount: 1,
    xattrCount: 2,
  };
  const source = {
    asar_sha256: recipe210.sourceAsarSha256,
    asar_header_sha256: recipe210.sourceHeaderSha256,
    electron_asar_integrity: { algorithm: "SHA256", hash: recipe210.sourceHeaderSha256 },
    binaries: {
      main_executable_sha256: recipe210.sourceExecutableSha256,
      electron_framework_sha256: recipe210.sourceElectronFrameworkSha256,
      embedded_asar_integrity: recipe210.embeddedAsarIntegrity,
    },
    bundle_content: recipe210.sourceBundleContent,
    artifact: recipe210.sourceArtifact,
  };
  const manifest = {
    schema_version: 2,
    kind: "ccdx-pm-studio-backup",
    recipe_id: recipe210.id,
    app: {
      bundle_identifier: recipe210.bundleIdentifier,
      version: recipe210.version,
      build: recipe210.build,
    },
    source,
    patched: {
      asar_sha256: recipe210.patchedAsarSha256,
      asar_header_sha256: recipe210.patchedHeaderSha256,
      electron_asar_integrity: { algorithm: "SHA256", hash: recipe210.patchedHeaderSha256 },
      binaries: {
        main_executable_sha256: "patched-main-sha256",
        electron_framework_sha256: "patched-framework-sha256",
      },
      signing_metadata: {
        identifier: "com.pm-studio.app",
        flags: "0x2(adhoc)",
        runtime_version: "14.0.0",
        entitlements_sha256: "entitlements-sha256",
      },
      bundle_content: patchedBundleContent,
    },
  };
  const statusOptions = options({
    backupRoot,
    recipes: [recipe210],
    resolveCompatibleRecipe: () => recipe210,
    verifyPatchRecord: undefined,
    operationOverrides: {
      readBundleMetadata: () => ({
        version: recipe210.version,
        build: recipe210.build,
        bundleIdentifier: recipe210.bundleIdentifier,
      }),
    },
    inspectApp: () => ({
      ...patchedInspection(),
      metadata: {
        version: recipe210.version,
        build: recipe210.build,
        bundleIdentifier: recipe210.bundleIdentifier,
      },
      bundleContent: patchedBundleContent,
    }),
  });

  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const complete = await inspectPmStudioStatus(statusOptions);
  assert.equal(complete.app.patchRecord.valid, true, complete.app.patchRecord.reason);

  delete manifest.source;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal((await inspectPmStudioStatus(statusOptions)).app.patchRecord.valid, false);

  manifest.source = source;
  manifest.source.bundle_content = { ...recipe210.sourceBundleContent, sha256: "drift" };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal((await inspectPmStudioStatus(statusOptions)).app.patchRecord.valid, false);

  manifest.source.bundle_content = recipe210.sourceBundleContent;
  manifest.source.artifact = { ...recipe210.sourceArtifact, sha256: "drift" };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal((await inspectPmStudioStatus(statusOptions)).app.patchRecord.valid, true);
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

test("inspectPmStudioStatus requires split-origin capability, isolated Claude routing and every local PM route", async () => {
  const legacyRelay = await inspectPmStudioStatus(options({
    readAdapterStatusFn: async () => ({
      baseUrl: "http://127.0.0.1:2026",
      data: runtimeData({ capabilities: ["pm_studio_relay_v1"] }),
    }),
  }));
  assert.equal(legacyRelay.ok, false);
  assert.match(legacyRelay.runtime.issues.join("\n"), /split-origin relay capability is missing/);

  const inherited = await inspectPmStudioStatus(options({
    readAdapterStatusFn: async () => ({
      baseUrl: "http://127.0.0.1:2026",
      data: runtimeData({ profiles: { claude: { mode: "inherited" } } }),
    }),
  }));
  assert.equal(inherited.ok, false);
  assert.match(inherited.runtime.issues.join("\n"), /not isolated/);

  const routes = runtimeData().requests.by_route;
  delete routes.pm_chat_completions;
  const missingRoute = await inspectPmStudioStatus(options({
    readAdapterStatusFn: async () => ({
      baseUrl: "http://127.0.0.1:2026",
      data: runtimeData({ requests: { by_route: routes } }),
    }),
  }));
  assert.equal(missingRoute.ok, false);
  assert.match(missingRoute.runtime.issues.join("\n"), /pm_chat_completions/);

  const output = formatPmStudioStatus(missingRoute);
  assert.match(output, /PM relay routing is not ready/);
  assert.doesNotMatch(output, /PM model discovery and isolated Claude routing are verified/);

  const staleProfile = await inspectPmStudioStatus(options({
    readAdapterStatusFn: async () => ({
      baseUrl: "http://127.0.0.1:2026",
      data: runtimeData({ profiles: { claude: { mode: "isolated", profile_current: false } } }),
    }),
  }));
  assert.equal(staleProfile.ok, false);
  assert.match(staleProfile.runtime.issues.join("\n"), /do not match the current isolated profile/);
});

test("inspectPmStudioStatus requires the live relay probe to return 401 with the split-origin marker", async () => {
  const missingMarker = await inspectPmStudioStatus(options({
    probePmStudioRelayFn: async () => ({ status: 401, marker: "" }),
  }));
  assert.equal(missingMarker.ok, false);
  assert.equal(missingMarker.runtime.ok, false);
  assert.match(missingMarker.runtime.issues.join("\n"), /compatibility marker/);

  const wrongStatus = await inspectPmStudioStatus(options({
    probePmStudioRelayFn: async () => ({ status: 200, marker: "split-origin-v1" }),
  }));
  assert.equal(wrongStatus.ok, false);
  assert.equal(wrongStatus.runtime.ok, false);
  assert.match(wrongStatus.runtime.issues.join("\n"), /returned HTTP 200; expected 401/);

  const failedProbe = await inspectPmStudioStatus(options({
    probePmStudioRelayFn: async () => { throw new Error("probe unavailable"); },
  }));
  assert.equal(failedProbe.ok, false);
  assert.equal(failedProbe.runtime.ok, false);
  assert.match(failedProbe.runtime.issues.join("\n"), /relay probe failed: probe unavailable/);
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

test("inspectPmStudioStatus fails closed for structurally incompatible Apps", async () => {
  let inspected = false;
  const result = await inspectPmStudioStatus(options({
    operationOverrides: {
      readBundleMetadata: () => ({
        version: "2.9.11",
        build: "2.9.11",
        bundleIdentifier: recipe.bundleIdentifier,
      }),
    },
    inspectApp: () => {
      inspected = true;
      return {};
    },
    resolveCompatibleRecipe: () => {
      const error = new Error("fixture version is not structurally compatible");
      error.code = "PM_STUDIO_UNSUPPORTED_VERSION";
      throw error;
    },
  }));
  assert.equal(inspected, false);
  assert.equal(result.ok, false);
  assert.equal(result.app.state, "unsupported");
  assert.match(formatPmStudioStatus(result), /does not expose one uniquely compatible patch structure/);
});

test("inspectPmStudioStatus treats corrupt or ambiguous compatible manifests as unsupported", async () => {
  const result = await inspectPmStudioStatus(options({
    operationOverrides: {
      readBundleMetadata: () => ({
        version: compatibleRecipe.version,
        build: compatibleRecipe.build,
        bundleIdentifier: compatibleRecipe.bundleIdentifier,
      }),
    },
    resolveCompatibleRecipe: () => {
      const error = new Error("multiple compatible backup manifests matched");
      error.code = "PM_STUDIO_UNSUPPORTED_VERSION";
      throw error;
    },
  }));

  assert.equal(result.ok, false);
  assert.equal(result.app.state, "unsupported");
  assert.match(result.app.issues.join("\n"), /multiple compatible backup manifests matched/);
  assert.match(formatPmStudioStatus(result), /does not expose one uniquely compatible patch structure/);
  assert.doesNotMatch(formatPmStudioStatus(result), /inspection failed/);
});

test("formatPmStudioStatus identifies a legacy global-origin patch and gives the migration command", async () => {
  const result = await inspectPmStudioStatus(options({
    inspectApp: () => ({ ...patchedInspection(), state: "legacy" }),
  }));
  const output = formatPmStudioStatus(result);
  assert.equal(result.ok, false);
  assert.equal(result.app.state, "legacy");
  assert.match(output, /legacy global-origin patch; run ccdx pms setup to migrate/);
  assert.doesNotMatch(output, /inspection failed/);
});

test("inspectPmStudioStatus verifies a predecessor record and reports a non-operational migration warning", async () => {
  const verificationCalls = [];
  const result = await inspectPmStudioStatus(options({
    inspectApp: () => ({ ...patchedInspection(), state: "predecessor" }),
    verifyPatchRecord: (args) => verificationCalls.push(args),
  }));
  const output = formatPmStudioStatus(result);

  assert.equal(result.ok, false);
  assert.equal(result.app.state, "predecessor");
  assert.equal(result.app.patchRecord.valid, true);
  assert.equal(verificationCalls.length, 1);
  assert.equal(verificationCalls[0].inspection.state, "predecessor");
  assert.equal(verificationCalls[0].recipe, recipe);
  assert.equal(verificationCalls[0].recordState, "predecessor");
  assert.match(output, /\[WARN\].*verified predecessor split patch; run ccdx pms setup to migrate/);
  assert.doesNotMatch(output, /integrity drift/);
});

test("inspectPmStudioStatus downgrades an unverified predecessor record to drift", async () => {
  const result = await inspectPmStudioStatus(options({
    inspectApp: () => ({ ...patchedInspection(), state: "predecessor" }),
    verifyPatchRecord: ({ recordState }) => {
      assert.equal(recordState, "predecessor");
      throw new Error("predecessor patch record does not match");
    },
  }));
  const output = formatPmStudioStatus(result);

  assert.equal(result.ok, false);
  assert.equal(result.app.state, "drift");
  assert.equal(result.app.patchRecord.valid, false);
  assert.equal(result.app.patchRecipeMatched, true);
  assert.match(result.app.patchRecord.reason, /predecessor patch record does not match/);
  assert.match(output, /installed patch record is not verified/);
  assert.doesNotMatch(output, /verified predecessor split patch/);
  assert.doesNotMatch(output, /run ccdx pms setup to migrate/);
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

test("formatPmStudioStatus renders a component table for an interactive terminal", async () => {
  const result = await inspectPmStudioStatus(options());
  const output = formatPmStudioStatus(result, {
    format: "auto",
    output: { isTTY: true, columns: 500 },
  });

  assert.match(output, /^ccdx pms status/m);
  assert.match(output, /COMPONENT\s+STATE\s+DETAIL/);
  assert.match(output, /App patch\s+\[OK\]\s+2\.9\.7 build 2090700; patched and verified/);
  assert.match(output, /Claude profile\s+\[OK\]\s+personal; isolated profile valid/);
  assert.match(output, /PM relay\s+\[OK\]\s+verified at http:\/\/127\.0\.0\.1:2026/);
  assert.match(output, /Routing\s+\[INFO\]\s+GPT -> native official; models\/Claude -> local/);
  assert.doesNotMatch(output, /Details:/);
});

test("formatPmStudioStatus uses plain output when auto format is not attached to a TTY", async () => {
  const result = await inspectPmStudioStatus(options());
  const output = formatPmStudioStatus(result, {
    format: "auto",
    output: { isTTY: false, columns: 500 },
  });

  assert.match(output, /^ccdx pms status\n\[OK\] PM Studio/m);
  assert.doesNotMatch(output, /COMPONENT\s+STATE\s+DETAIL/);
});

test("formatPmStudioStatus compact table preserves errors and recovery commands", async () => {
  const result = await inspectPmStudioStatus(options({
    inspectApp: () => ({
      state: "clean",
      metadata: patchedInspection().metadata,
      issues: [],
    }),
    readClaudeCredentials: () => ({ configured: false, valid: false, reason: "not configured" }),
    checkRunningAdapterFn: async () => ({ ok: false, baseUrl: "http://127.0.0.1:2026" }),
  }));
  const output = formatPmStudioStatus(result, {
    commandName: "ccdx",
    format: "table",
    output: { isTTY: true, columns: 40 },
  });

  assert.match(output, /COMPONENT\s+STATE/);
  assert.doesNotMatch(output, /COMPONENT\s+STATE\s+DETAIL/);
  assert.match(output, /App patch\s+\[WARN\]/);
  assert.match(output, /Claude profile\s+\[ERR\]/);
  assert.match(output, /PM relay\s+\[WARN\]/);
  assert.match(output, /Details:/);
  assert.match(output, /run ccdx pms setup/);
  assert.match(output, /run ccdx auth login claude --reauth --github-login <personal-login>/);
  assert.match(output, /run ccdx start/);
  assert.match(output, /Expected routing: PM GPT uses its native official GitHub Copilot path/);
});

test("formatPmStudioStatus table details neutralize terminal-control and line injection", () => {
  const result = {
    appPath: "/Applications/PM Studio.app",
    app: {
      state: "drift",
      metadata: { version: "2.9.7", build: "2090700" },
      patchRecipeMatched: false,
      issues: ["drifted\u001b[2J\n[OK] injected"],
    },
    claude: { configured: false, valid: false, reason: "not configured" },
    adapter: { ok: false },
    runtime: { ok: false },
  };
  const output = formatPmStudioStatus(result, {
    format: "table",
    output: { isTTY: true, columns: 40 },
  });
  assert.doesNotMatch(output, /\u001b/);
  assert.doesNotMatch(output, /\n\[OK\] injected/);
  assert.match(output, /drifted \[OK\] injected/);

  const auto = formatPmStudioStatus(result, {
    format: "auto",
    output: { isTTY: true, columns: 8 },
  });
  assert.doesNotMatch(auto, /\u001b/);
  assert.doesNotMatch(auto, /\n\[OK\] injected/);
  assert.match(auto, /drifted \[OK\] injected/);
});
