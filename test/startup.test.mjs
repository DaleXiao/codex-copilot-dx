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

test("initializeModelRegistry: serves stale cache while refresh runs in the background", async () => {
  let finishRefresh;
  let refreshCalls = 0;
  const pendingRefresh = new Promise((resolve) => { finishRefresh = resolve; });

  const result = await initializeModelRegistry({
    loadCached: () => ({ loaded: true, stale: true }),
    currentModelDefs: () => [{ id: "stale" }],
    refresh: () => {
      refreshCalls += 1;
      return pendingRefresh;
    },
  });

  assert.deepEqual(result.modelDefs, [{ id: "stale" }]);
  assert.equal(result.source, "cache");
  assert.equal(refreshCalls, 1);
  assert.equal(result.backgroundRefresh instanceof Promise, true);
  finishRefresh([{ id: "live" }]);
  assert.deepEqual(await result.backgroundRefresh, [{ id: "live" }]);
});

test("runInBackground: isolates task failures", async () => {
  let error;
  await runInBackground(() => { throw new Error("offline"); }, (value) => { error = value; });
  assert.equal(error.message, "offline");
});
