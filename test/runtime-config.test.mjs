import test from "node:test";
import assert from "node:assert/strict";
import {
  loadRuntimeConfig,
  MAX_TIMER_DELAY_MS,
  parsePositiveInteger,
  parseSafePositiveInteger,
  parseTimerMs,
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

test("parseTimerMs: enforces safe integer syntax and the Node timer ceiling", () => {
  assert.equal(parseTimerMs("12000", 7), 12000);
  assert.equal(parseTimerMs(String(MAX_TIMER_DELAY_MS + 1), 7), MAX_TIMER_DELAY_MS);
  assert.equal(parseTimerMs(String(Number.MAX_SAFE_INTEGER + 1), 7), 7);
  assert.equal(parseTimerMs("12ms", 7), 7);
  assert.equal(parseTimerMs("1.5", 7), 7);
});

test("parseSafePositiveInteger: validates long durations without a timer ceiling", () => {
  assert.equal(parseSafePositiveInteger(String(MAX_TIMER_DELAY_MS + 1), 7), MAX_TIMER_DELAY_MS + 1);
  assert.equal(parseSafePositiveInteger(String(Number.MAX_SAFE_INTEGER + 1), 7), 7);
});

test("loadRuntimeConfig: centralizes limits without mutating the environment", () => {
  const env = {
    CCDX_UPSTREAM_TIMEOUT_MS: "9000",
    CCDX_REQUEST_BODY_TIMEOUT_MS: "8000",
    CCDX_MAX_BODY_BYTES: "1234",
    CCDX_MAX_UPSTREAM_CHAT_RESPONSE_BYTES: "5678",
    CCDX_MAX_UPSTREAM_RESPONSES_RESPONSE_BYTES: "9012",
    CCDX_MAX_QUEUED_REQUESTS: "3",
    CCDX_RESPONSE_HISTORY_MAX_ENTRIES: "99",
  };
  const config = loadRuntimeConfig(env);
  assert.equal(config.upstreamTimeoutMs, 9000);
  assert.equal(config.requestBodyTimeoutMs, 8000);
  assert.equal(config.maxBodyBytes, 1234);
  assert.equal(config.maxUpstreamChatResponseBytes, 5678);
  assert.equal(config.maxUpstreamResponsesResponseBytes, 9012);
  assert.equal(config.maxQueuedRequests, 3);
  assert.equal(config.responseHistoryMaxEntries, 99);
  assert.equal(config.streamIdleTimeoutMs, RUNTIME_DEFAULTS.streamIdleTimeoutMs);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(env.CCDX_UPSTREAM_TIMEOUT_MS, "9000");
});

test("loadRuntimeConfig: caps only timer fields without imposing low resource ceilings", () => {
  const largeBytes = "9000000000000";
  const config = loadRuntimeConfig({
    CCDX_UPSTREAM_TIMEOUT_MS: String(MAX_TIMER_DELAY_MS + 1),
    CCDX_STREAM_IDLE_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER + 1),
    CCDX_REQUEST_QUEUE_TIMEOUT_MS: "12ms",
    CCDX_TOKEN_LOCK_TIMEOUT_MS: String(MAX_TIMER_DELAY_MS + 1),
    CCDX_MAX_BODY_BYTES: largeBytes,
    CCDX_RESPONSE_HISTORY_MAX_BYTES: largeBytes,
  });

  assert.equal(config.upstreamTimeoutMs, MAX_TIMER_DELAY_MS);
  assert.equal(config.streamIdleTimeoutMs, RUNTIME_DEFAULTS.streamIdleTimeoutMs);
  assert.equal(config.requestQueueTimeoutMs, RUNTIME_DEFAULTS.requestQueueTimeoutMs);
  assert.equal(config.tokenLockTimeoutMs, MAX_TIMER_DELAY_MS + 1);
  assert.equal(config.maxBodyBytes, Number(largeBytes));
  assert.equal(config.responseHistoryMaxBytes, Number(largeBytes));
});
