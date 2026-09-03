import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadModelCache,
  MODEL_CACHE_SOFT_TTL_MS,
  saveModelCache,
} from "../src/model-cache.mjs";
import { createProfileModelRuntime } from "../src/profile-model-runtime.mjs";

const CREDENTIAL_FINGERPRINT = "enterprise-fingerprint";

function modelResult(models) {
  return { status: 200, body: JSON.stringify(models) };
}

function catalog(id = "gpt-5.5") {
  return {
    data: [{
      id,
      vendor: "openai",
      model_picker_enabled: true,
      supported_endpoints: ["/responses"],
    }],
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

test("Codex model runtime initializes from the live catalog and persists it", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-model-runtime-live-"));
  const models = catalog();
  let calls = 0;
  const client = clientWithList(async () => {
    calls += 1;
    return modelResult(models);
  });
  const runtime = createProfileModelRuntime({
    codexClient: client,
    codexCredentialFingerprint: CREDENTIAL_FINGERPRINT,
    home,
    log: () => {},
    autoReviewModelResolver: () => "gpt-5.5",
  });

  const initialized = await runtime.initialize();

  assert.deepEqual(Object.keys(runtime).sort(), ["codexRegistry", "initialize", "refreshAll", "refreshCodex"]);
  assert.equal(calls, 1);
  assert.equal(runtime.codexRegistry.source, "live");
  assert.deepEqual(initialized.codex.models, models);
  assert.deepEqual(client.endpointCatalogs, [models]);
  assert.deepEqual(loadModelCache({
    home,
    profile: "codex",
    credentialFingerprint: CREDENTIAL_FINGERPRINT,
  }), models);
});

test("Codex model runtime uses a fresh cache without a network refresh", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-model-runtime-cache-"));
  const models = catalog("gpt-cached");
  saveModelCache(models, { home, credentialFingerprint: CREDENTIAL_FINGERPRINT });
  let calls = 0;
  const client = clientWithList(async () => {
    calls += 1;
    return modelResult(catalog("gpt-live"));
  });
  const runtime = createProfileModelRuntime({
    codexClient: client,
    codexCredentialFingerprint: CREDENTIAL_FINGERPRINT,
    home,
    log: () => {},
  });

  await runtime.initialize();

  assert.equal(calls, 0);
  assert.equal(runtime.codexRegistry.source, "cache");
  assert.deepEqual(runtime.codexRegistry.models, models);
});

test("Codex model runtime refreshes a stale cache in the background", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-model-runtime-swr-"));
  const stale = catalog("gpt-cached");
  const live = catalog("gpt-live");
  saveModelCache(stale, {
    home,
    now: () => Date.now() - MODEL_CACHE_SOFT_TTL_MS - 1000,
  });
  const pending = deferred();
  let calls = 0;
  const client = clientWithList(() => {
    calls += 1;
    return pending.promise;
  });
  const runtime = createProfileModelRuntime({ codexClient: client, home, log: () => {} });

  const initialized = await runtime.initialize();

  assert.equal(calls, 1);
  assert.equal(runtime.codexRegistry.source, "cache");
  assert.equal(runtime.codexRegistry.refreshInFlight, true);
  assert.equal(initialized.codex.backgroundRefresh instanceof Promise, true);
  pending.resolve(modelResult(live));
  await initialized.codex.backgroundRefresh;
  assert.equal(runtime.codexRegistry.source, "live");
  assert.equal(runtime.codexRegistry.refreshInFlight, false);
  assert.deepEqual(runtime.codexRegistry.models, live);
});

test("Codex model runtime coalesces concurrent refreshes", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-model-runtime-singleflight-"));
  const pending = deferred();
  let calls = 0;
  const client = clientWithList(() => {
    calls += 1;
    return pending.promise;
  });
  const runtime = createProfileModelRuntime({ codexClient: client, home, log: () => {} });

  const first = runtime.refreshCodex();
  const second = runtime.refreshCodex();
  const all = runtime.refreshAll();
  assert.equal(calls, 1);
  pending.resolve(modelResult(catalog()));
  await Promise.all([first, second, all]);

  assert.equal(calls, 1);
  assert.equal(runtime.codexRegistry.generation, 1);
  assert.equal(runtime.codexRegistry.refreshInFlight, false);
});

test("Codex model runtime ignores another credential's cache and redacts refresh failures", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-model-runtime-credential-"));
  saveModelCache(catalog("gpt-old"), {
    home,
    credentialFingerprint: "old-fingerprint",
  });
  const client = clientWithList(async () => {
    throw new Error("offline Bearer ghp_must_not_leak");
  });
  const runtime = createProfileModelRuntime({
    codexClient: client,
    codexCredentialFingerprint: CREDENTIAL_FINGERPRINT,
    home,
    log: () => {},
  });

  await runtime.initialize();

  assert.equal(runtime.codexRegistry.models, undefined);
  assert.match(runtime.codexRegistry.lastError, /Bearer <redacted>/);
  assert.doesNotMatch(runtime.codexRegistry.lastError, /ghp_must_not_leak/);
});
