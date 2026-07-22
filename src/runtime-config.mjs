export const RUNTIME_DEFAULTS = Object.freeze({
  upstreamTimeoutMs: 120 * 1000,
  streamHandshakeTimeoutMs: 120 * 1000,
  streamIdleTimeoutMs: 120 * 1000,
  maxSseBufferBytes: 8 * 1024 * 1024,
  maxBodyBytes: 64 * 1024 * 1024,
  maxDecodedBodyBytes: 128 * 1024 * 1024,
  maxInflightBodyBytes: 32 * 1024 * 1024,
  maxQueuedRequests: 16,
  requestQueueTimeoutMs: 120 * 1000,
  responseHistoryMaxBytes: 64 * 1024 * 1024,
  responseHistoryMaxEntries: 4096,
  tokenLockTimeoutMs: 10 * 60 * 1000,
  tokenLockStaleMs: 15 * 60 * 1000,
});

export function parsePositiveInteger(value, fallback, max = Number.POSITIVE_INFINITY) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

export function loadRuntimeConfig(env = process.env) {
  return Object.freeze({
    upstreamTimeoutMs: parsePositiveInteger(env.CCDX_UPSTREAM_TIMEOUT_MS, RUNTIME_DEFAULTS.upstreamTimeoutMs),
    streamHandshakeTimeoutMs: parsePositiveInteger(env.CCDX_STREAM_HANDSHAKE_TIMEOUT_MS, RUNTIME_DEFAULTS.streamHandshakeTimeoutMs),
    streamIdleTimeoutMs: parsePositiveInteger(env.CCDX_STREAM_IDLE_TIMEOUT_MS, RUNTIME_DEFAULTS.streamIdleTimeoutMs),
    maxSseBufferBytes: parsePositiveInteger(env.CCDX_MAX_SSE_BUFFER_BYTES, RUNTIME_DEFAULTS.maxSseBufferBytes),
    maxBodyBytes: parsePositiveInteger(env.CCDX_MAX_BODY_BYTES, RUNTIME_DEFAULTS.maxBodyBytes),
    maxDecodedBodyBytes: parsePositiveInteger(env.CCDX_MAX_DECODED_BODY_BYTES, RUNTIME_DEFAULTS.maxDecodedBodyBytes),
    maxInflightBodyBytes: parsePositiveInteger(env.CCDX_MAX_INFLIGHT_BODY_BYTES, RUNTIME_DEFAULTS.maxInflightBodyBytes),
    maxQueuedRequests: parsePositiveInteger(env.CCDX_MAX_QUEUED_REQUESTS, RUNTIME_DEFAULTS.maxQueuedRequests),
    requestQueueTimeoutMs: parsePositiveInteger(env.CCDX_REQUEST_QUEUE_TIMEOUT_MS, RUNTIME_DEFAULTS.requestQueueTimeoutMs),
    responseHistoryMaxBytes: parsePositiveInteger(env.CCDX_RESPONSE_HISTORY_MAX_BYTES, RUNTIME_DEFAULTS.responseHistoryMaxBytes),
    responseHistoryMaxEntries: parsePositiveInteger(env.CCDX_RESPONSE_HISTORY_MAX_ENTRIES, RUNTIME_DEFAULTS.responseHistoryMaxEntries),
    tokenLockTimeoutMs: parsePositiveInteger(env.CCDX_TOKEN_LOCK_TIMEOUT_MS, RUNTIME_DEFAULTS.tokenLockTimeoutMs),
    tokenLockStaleMs: parsePositiveInteger(env.CCDX_TOKEN_LOCK_STALE_MS, RUNTIME_DEFAULTS.tokenLockStaleMs),
  });
}
