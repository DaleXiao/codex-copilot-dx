import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadModelCache,
  modelCachePath,
  saveModelCache,
} from "../src/model-cache.mjs";
import { createProfileModelRuntime } from "../src/profile-model-runtime.mjs";

const CLAUDE_CREDENTIAL_FINGERPRINT = "personal-fingerprint";
const CODEX_CREDENTIAL_FINGERPRINT = "enterprise-fingerprint";

function modelResult(models) {
  return { status: 200, body: JSON.stringify(models) };
}

function gptModel(id = "gpt-5.5") {
  return {
    id,
    model_picker_enabled: true,
    supported_endpoints: ["/responses"],
  };
}

function claudeModel(id) {
  return {
    id,
    name: id,
    vendor: "anthropic",
    model_picker_enabled: true,
    supported_endpoints: ["/chat/completions"],
  };
}

function clientWithList(listModels) {
  const endpointCatalogs = [];
  return {
    endpointCatalogs,
    listModels,
    cacheModelEndpoints(models) {
      endpointCatalogs.push(models);
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("profile model runtime: inherited mode shares registry/client work and refreshes once", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-model-runtime-inherited-"));
  const catalog = { data: [gptModel(), claudeModel("claude-personal")] };
  let listCalls = 0;
  const client = clientWithList(async () => {
    listCalls += 1;
    return modelResult(catalog);
  });
  const changes = [];
  const runtime = createProfileModelRuntime({
    codexClient: client,
    claudeClient: client,
    claudeMode: "inherited",
    home,
    env: { CCDX_CLAUDE_MODEL_ALIASES: "desktop-claude=claude-personal" },
    log: () => {},
    onClaudeModelsChanged: (models) => changes.push(models),
    autoReviewModelResolver: () => "gpt-5.5",
  });

  const initialized = await runtime.initialize();

  assert.equal(runtime.codexRegistry, runtime.claudeRegistry);
  assert.equal(initialized.codex, initialized.claude);
  assert.equal(listCalls, 1);
  assert.equal(runtime.codexRegistry.source, "live");
  assert.deepEqual(runtime.codexRegistry.models, catalog);
  assert.deepEqual(runtime.claudeRegistry.modelDefs.map(({ id, upstream }) => ({ id, upstream })), [
    { id: "desktop-claude", upstream: "claude-personal" },
  ]);
  assert.deepEqual(client.endpointCatalogs, [catalog]);
  assert.equal(changes.length, 1);
  assert.deepEqual(loadModelCache({ home, profile: "codex" }), catalog);
  assert.equal(fs.existsSync(modelCachePath(home, "claude")), false);

  const refreshed = await runtime.refreshAll();
  assert.equal(refreshed.codex, refreshed.claude);
  assert.equal(listCalls, 2);
  assert.deepEqual(client.endpointCatalogs, [catalog, catalog]);
});

test("profile model runtime: isolated initialization fetches concurrently into separate caches", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-model-runtime-isolated-"));
  const codexCatalog = {
    data: [gptModel("gpt-enterprise"), claudeModel("claude-enterprise-must-not-leak")],
  };
  const claudeCatalog = { data: [claudeModel("claude-personal")] };
  const codexPending = deferred();
  const claudePending = deferred();
  let codexCalls = 0;
  let claudeCalls = 0;
  const codexClient = clientWithList(() => {
    codexCalls += 1;
    return codexPending.promise;
  });
  const claudeClient = clientWithList(() => {
    claudeCalls += 1;
    return claudePending.promise;
  });
  const changes = [];
  const runtime = createProfileModelRuntime({
    codexClient,
    claudeClient,
    claudeMode: "isolated",
    claudeCredentialFingerprint: CLAUDE_CREDENTIAL_FINGERPRINT,
    home,
    env: {},
    log: () => {},
    onClaudeModelsChanged: (models) => changes.push(models),
    autoReviewModelResolver: () => "gpt-enterprise",
  });

  const initializing = runtime.initialize();
  assert.equal(codexCalls, 1);
  assert.equal(claudeCalls, 1);
  codexPending.resolve(modelResult(codexCatalog));
  claudePending.resolve(modelResult(claudeCatalog));
  await initializing;

  assert.notEqual(runtime.codexRegistry, runtime.claudeRegistry);
  assert.equal(runtime.codexRegistry.source, "live");
  assert.equal(runtime.claudeRegistry.source, "live");
  assert.deepEqual(runtime.codexRegistry.models, codexCatalog);
  assert.deepEqual(runtime.claudeRegistry.models, claudeCatalog);
  assert.equal(runtime.codexRegistry.modelDefs, undefined);
  assert.deepEqual(runtime.claudeRegistry.modelDefs.map(({ id }) => id), ["claude-personal"]);
  assert.deepEqual(codexClient.endpointCatalogs, [codexCatalog]);
  assert.deepEqual(claudeClient.endpointCatalogs, [claudeCatalog]);
  assert.deepEqual(changes.flatMap((models) => models.map(({ id }) => id)), ["claude-personal"]);
  assert.deepEqual(loadModelCache({ home, profile: "codex" }), codexCatalog);
  assert.deepEqual(loadModelCache({ home, profile: "claude" }), claudeCatalog);
  assert.notEqual(modelCachePath(home, "codex"), modelCachePath(home, "claude"));
});

test("profile model runtime: isolated refresh failure preserves one profile without blocking the other", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-model-runtime-failure-"));
  const oldCodex = { data: [gptModel("gpt-cached")] };
  const oldClaude = { data: [claudeModel("claude-cached")] };
  const newClaude = { data: [claudeModel("claude-live")] };
  saveModelCache(oldCodex, { home, profile: "codex" });
  saveModelCache(oldClaude, {
    home,
    profile: "claude",
    credentialFingerprint: CLAUDE_CREDENTIAL_FINGERPRINT,
  });
  let codexCalls = 0;
  let claudeCalls = 0;
  const codexClient = clientWithList(async () => {
    codexCalls += 1;
    throw new Error("codex offline");
  });
  const claudeClient = clientWithList(async () => {
    claudeCalls += 1;
    return modelResult(newClaude);
  });
  const runtime = createProfileModelRuntime({
    codexClient,
    claudeClient,
    claudeMode: "isolated",
    claudeCredentialFingerprint: CLAUDE_CREDENTIAL_FINGERPRINT,
    home,
    env: {},
    log: () => {},
  });

  await runtime.initialize();
  assert.equal(codexCalls, 0);
  assert.equal(claudeCalls, 0);
  await runtime.refreshAll();

  assert.equal(codexCalls, 1);
  assert.equal(claudeCalls, 1);
  assert.equal(runtime.codexRegistry.source, "cache");
  assert.equal(runtime.claudeRegistry.source, "live");
  assert.deepEqual(runtime.codexRegistry.models, oldCodex);
  assert.deepEqual(runtime.claudeRegistry.models, newClaude);
  assert.deepEqual(loadModelCache({ home, profile: "codex" }), oldCodex);
  assert.deepEqual(loadModelCache({ home, profile: "claude" }), newClaude);
  assert.deepEqual(codexClient.endpointCatalogs, [oldCodex]);
  assert.deepEqual(claudeClient.endpointCatalogs, [oldClaude, newClaude]);
});

test("profile model runtime: isolated Claude ignores a cache from another credential", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-model-runtime-account-cache-"));
  const oldClaude = { data: [claudeModel("claude-old-account")] };
  const newClaude = { data: [claudeModel("claude-new-account")] };
  saveModelCache(oldClaude, {
    home,
    profile: "claude",
    credentialFingerprint: "old-account-fingerprint",
  });
  let claudeCalls = 0;
  const codexClient = clientWithList(async () => modelResult({ data: [gptModel()] }));
  const claudeClient = clientWithList(async () => {
    claudeCalls += 1;
    return modelResult(newClaude);
  });
  const runtime = createProfileModelRuntime({
    codexClient,
    claudeClient,
    claudeMode: "isolated",
    claudeCredentialFingerprint: "new-account-fingerprint",
    home,
    env: {},
    log: () => {},
  });

  await runtime.initialize();

  assert.equal(claudeCalls, 1);
  assert.equal(runtime.claudeRegistry.source, "live");
  assert.deepEqual(runtime.claudeRegistry.models, newClaude);
  assert.deepEqual(loadModelCache({
    home,
    profile: "claude",
    credentialFingerprint: "new-account-fingerprint",
  }), newClaude);
});

test("profile model runtime: Codex ignores a cache from another credential", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-model-runtime-codex-account-cache-"));
  const oldCatalog = { data: [gptModel("gpt-old-account")] };
  const newCatalog = { data: [gptModel("gpt-new-account")] };
  saveModelCache(oldCatalog, {
    home,
    profile: "codex",
    credentialFingerprint: "old-enterprise-fingerprint",
  });
  let calls = 0;
  const client = clientWithList(async () => {
    calls += 1;
    return modelResult(newCatalog);
  });
  const runtime = createProfileModelRuntime({
    codexClient: client,
    codexCredentialFingerprint: CODEX_CREDENTIAL_FINGERPRINT,
    home,
    env: {},
    log: () => {},
  });

  await runtime.initialize();

  assert.equal(calls, 1);
  assert.equal(runtime.codexRegistry.source, "live");
  assert.deepEqual(runtime.codexRegistry.models, newCatalog);
  assert.deepEqual(loadModelCache({
    home,
    profile: "codex",
    credentialFingerprint: CODEX_CREDENTIAL_FINGERPRINT,
  }), newCatalog);
});
