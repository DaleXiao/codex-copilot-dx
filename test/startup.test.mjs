import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeModelRegistry, runInBackground } from "../src/startup.mjs";

test("initializeModelRegistry: uses a valid cache without an eager refresh", async () => {
  let refreshCalls = 0;

  const result = await initializeModelRegistry({
    loadCached: () => true,
    currentModelDefs: () => [{ id: "cached" }],
    refresh: () => {
      refreshCalls += 1;
      return [{ id: "live" }];
    },
  });

  assert.deepEqual(result.modelDefs, [{ id: "cached" }]);
  assert.equal(result.source, "cache");
  assert.equal(result.backgroundRefresh, null);
  assert.equal(refreshCalls, 0);
});

test("initializeModelRegistry: waits for live models when no cache exists", async () => {
  let finishRefresh;
  const pendingRefresh = new Promise((resolve) => { finishRefresh = resolve; });
  let settled = false;
  const initializing = initializeModelRegistry({
    loadCached: () => false,
    currentModelDefs: () => undefined,
    refresh: () => pendingRefresh,
  }).then((result) => {
    settled = true;
    return result;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  finishRefresh([{ id: "live" }]);
  const result = await initializing;
  assert.deepEqual(result.modelDefs, [{ id: "live" }]);
  assert.equal(result.source, "live");
  assert.equal(result.backgroundRefresh, null);
});

test("runInBackground: isolates task failures", async () => {
  let error;
  await runInBackground(() => { throw new Error("offline"); }, (value) => { error = value; });
  assert.equal(error.message, "offline");
});
