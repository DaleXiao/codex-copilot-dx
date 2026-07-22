import test from "node:test";
import assert from "node:assert/strict";
import {
  loadRuntimeConfig,
  parsePositiveInteger,
  RUNTIME_DEFAULTS,
} from "../src/runtime-config.mjs";

test("parsePositiveInteger: preserves established positive integer semantics", () => {
  assert.equal(parsePositiveInteger("12", 7), 12);
  assert.equal(parsePositiveInteger("12px", 7), 12);
  assert.equal(parsePositiveInteger("0", 7), 7);
  assert.equal(parsePositiveInteger("-1", 7), 7);
  assert.equal(parsePositiveInteger("invalid", 7), 7);
  assert.equal(parsePositiveInteger("99999999999999999999", 7), Number.parseInt("99999999999999999999", 10));
  assert.equal(parsePositiveInteger("100", 7, 20), 20);
});

test("loadRuntimeConfig: centralizes limits without mutating the environment", () => {
  const env = {
    CCDX_UPSTREAM_TIMEOUT_MS: "9000",
    CCDX_MAX_BODY_BYTES: "1234",
    CCDX_MAX_QUEUED_REQUESTS: "3",
    CCDX_RESPONSE_HISTORY_MAX_ENTRIES: "99",
  };
  const config = loadRuntimeConfig(env);
  assert.equal(config.upstreamTimeoutMs, 9000);
  assert.equal(config.maxBodyBytes, 1234);
  assert.equal(config.maxQueuedRequests, 3);
  assert.equal(config.responseHistoryMaxEntries, 99);
  assert.equal(config.streamIdleTimeoutMs, RUNTIME_DEFAULTS.streamIdleTimeoutMs);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(env.CCDX_UPSTREAM_TIMEOUT_MS, "9000");
});
