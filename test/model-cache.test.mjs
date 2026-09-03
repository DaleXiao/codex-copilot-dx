import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isValidModelList,
  loadModelCache,
  loadModelCacheEntry,
  MODEL_CACHE_HARD_TTL_MS,
  MODEL_CACHE_SOFT_TTL_MS,
  modelCachePath,
  saveModelCache,
} from "../src/model-cache.mjs";

test("Codex model cache round-trips a valid last-known-good model list at the legacy path", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-model-cache-"));
  const models = { data: [{ id: "gpt-5.6-sol", supported_endpoints: ["/responses"] }] };

  assert.equal(modelCachePath(home), path.join(home, ".local", "share", "codex-copilot-dx", "models.json"));
  assert.equal(saveModelCache(models, { home }), true);
  assert.deepEqual(loadModelCache({ home }), models);
  assert.equal(fs.statSync(modelCachePath(home)).mode & 0o777, 0o600);
});

test("model cache ignores stale and malformed data", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-model-cache-stale-"));
  const filePath = modelCachePath(home);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    saved_at: "2020-01-01T00:00:00.000Z",
    models: { data: [{ id: "old" }] },
  }));

  assert.equal(loadModelCache({ home, maxAgeMs: 1000, now: () => Date.parse("2020-01-02T00:00:00.000Z") }), null);
  fs.writeFileSync(filePath, "not json");
  assert.equal(loadModelCache({ home }), null);
});

test("model cache has a fixed 2h soft TTL and preserves the legacy 7d hard TTL", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-model-cache-ttl-"));
  const savedAtMs = Date.parse("2026-08-25T00:00:00.000Z");
  const models = { data: [{ id: "gpt-current" }] };

  assert.equal(MODEL_CACHE_SOFT_TTL_MS, 2 * 60 * 60 * 1000);
  assert.equal(MODEL_CACHE_HARD_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(saveModelCache(models, { home, now: () => savedAtMs }), true);
  assert.equal(loadModelCacheEntry({
    home,
    now: () => savedAtMs + MODEL_CACHE_SOFT_TTL_MS,
  }).state, "fresh");
  assert.deepEqual(loadModelCacheEntry({
    home,
    now: () => savedAtMs + MODEL_CACHE_SOFT_TTL_MS + 1,
  }), {
    models,
    savedAtMs,
    ageMs: MODEL_CACHE_SOFT_TTL_MS + 1,
    state: "stale",
  });
  assert.deepEqual(loadModelCache({
    home,
    now: () => savedAtMs + MODEL_CACHE_HARD_TTL_MS,
  }), models);
  assert.equal(loadModelCache({
    home,
    now: () => savedAtMs + MODEL_CACHE_HARD_TTL_MS + 1,
  }), null);
});

test("model cache generation guard cannot replace last-known-good data", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-model-cache-generation-"));
  const oldModels = { data: [{ id: "gpt-newer" }] };
  const staleModels = { data: [{ id: "gpt-stale-flight" }] };
  assert.equal(saveModelCache(oldModels, { home }), true);
  let checks = 0;

  assert.equal(saveModelCache(staleModels, {
    home,
    isCurrent: () => {
      checks += 1;
      return checks === 1;
    },
  }), false);
  assert.equal(checks, 2);
  assert.deepEqual(loadModelCache({ home }), oldModels);
  assert.deepEqual(
    fs.readdirSync(path.dirname(modelCachePath(home))).sort(),
    [path.basename(modelCachePath(home))],
  );
});

test("model cache accepts only non-empty lists with a model id", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-model-cache-valid-"));

  assert.equal(isValidModelList({ data: [] }), false);
  assert.equal(isValidModelList({ data: [{}] }), false);
  assert.equal(saveModelCache({ data: [] }, { home }), false);
  assert.equal(saveModelCache({ data: [{ id: "gpt-test" }] }, { home }), true);
});
