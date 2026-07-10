import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadModelCache, modelCachePath, saveModelCache } from "../src/model-cache.mjs";

test("model cache round-trips a valid last-known-good model list", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-model-cache-"));
  const models = { data: [{ id: "gpt-5.6-sol", supported_endpoints: ["/responses"] }] };

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
