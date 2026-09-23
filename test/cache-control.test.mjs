import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cacheRuntimeSnapshot,
  cleanRuntimeCaches,
  setHistoryCacheLimit,
} from "../src/cache-control.mjs";
import {
  acquireResponseHistorySnapshot,
  clearResponseHistoryForTests,
  configureResponseHistoryForTests,
  rememberResponseHistoryNode,
  responseHistoryStats,
} from "../src/response-history.mjs";

test("cache control applies larger history limits and rejects destructive shrinking", () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 64 * 1024 * 1024 });
  try {
    rememberResponseHistoryNode({ id: "resp_cache", inputItems: [{ type: "input_text", text: "x".repeat(17 * 1024 * 1024) }], outputItems: [] });
    assert.equal(setHistoryCacheLimit(128 * 1024 * 1024).response_history.maxBytes, 128 * 1024 * 1024);
    assert.throws(() => setHistoryCacheLimit(16 * 1024 * 1024 - 1), /16 to 1024 MiB/);
    assert.throws(() => setHistoryCacheLimit(16 * 1024 * 1024), /above the requested/);
    assert.equal(responseHistoryStats().entries, 1);
    assert.equal(responseHistoryStats().maxBytes, 128 * 1024 * 1024);
  } finally { clearResponseHistoryForTests(); }
});

test("cache cleanup leaves response history by default and requires idle history for explicit clearing", () => {
  clearResponseHistoryForTests();
  try {
    rememberResponseHistoryNode({ id: "resp_cache", inputItems: [], outputItems: [] });
    const defaultClean = cleanRuntimeCaches();
    assert.equal(defaultClean.response_history.entries, 1);
    assert.deepEqual(defaultClean.cleaned.image_optimization, { entries: 0, bytes: 0 });

    const snapshot = acquireResponseHistorySnapshot("resp_cache");
    assert.throws(() => cleanRuntimeCaches({ history: true }), /history is active/);
    snapshot.release();
    const explicit = cleanRuntimeCaches({ history: true });
    assert.equal(explicit.cleaned.response_history.entries, 1);
    assert.equal(explicit.response_history.entries, 0);
    assert.equal(cacheRuntimeSnapshot().response_history.maxBytes, 64 * 1024 * 1024);
  } finally { clearResponseHistoryForTests(); }
});
