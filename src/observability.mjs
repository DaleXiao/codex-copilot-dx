import { isIP } from "node:net";
import { adapterHealthPayload } from "./running-adapter.mjs";
import { copilotRuntimeStatus } from "./copilot.mjs";
import { imageOptimizationStats } from "./image-optimization.mjs";
import { responseHistoryStats } from "./response-history.mjs";
import { loadRuntimeConfig } from "./runtime-config.mjs";

export const ADAPTER_STATUS_PATH = "/_ccdx/status";
const OBSERVABILITY_RUNTIME_CONFIG = loadRuntimeConfig();

const ROUTE_NAMES = Object.freeze([
  "responses",
  "responses_compact",
  "models",
  "messages",
  "messages_count_tokens",
  "not_found",
]);

function emptyCounter() {
  return {
    total: 0,
    active: 0,
    completed: 0,
    errors: 0,
    aborted: 0,
    duration_ms_total: 0,
    duration_ms_max: 0,
    status_2xx: 0,
    status_3xx: 0,
    status_4xx: 0,
    status_5xx: 0,
  };
}

function statusBucket(statusCode) {
  if (statusCode >= 200 && statusCode < 300) return "status_2xx";
  if (statusCode >= 300 && statusCode < 400) return "status_3xx";
  if (statusCode >= 400 && statusCode < 500) return "status_4xx";
  if (statusCode >= 500) return "status_5xx";
  return null;
}

function counterSnapshot(counter) {
  return {
    ...counter,
    duration_ms_avg: counter.completed > 0
      ? Number((counter.duration_ms_total / counter.completed).toFixed(1))
      : 0,
  };
}

export function createRequestMetrics({ now = Date.now } = {}) {
  const total = emptyCounter();
  const routes = Object.fromEntries(ROUTE_NAMES.map((name) => [name, emptyCounter()]));

  const begin = (routeName) => {
    const route = routes[routeName] || routes.not_found;
    const startedAt = now();
    total.total += 1;
    total.active += 1;
    route.total += 1;
    route.active += 1;
    let completed = false;

    return ({ statusCode = 0, aborted = false } = {}) => {
      if (completed) return;
      completed = true;
      const durationMs = Math.max(0, now() - startedAt);
      for (const counter of [total, route]) {
        counter.active = Math.max(0, counter.active - 1);
        counter.completed += 1;
        counter.duration_ms_total += durationMs;
        counter.duration_ms_max = Math.max(counter.duration_ms_max, durationMs);
        if (aborted) counter.aborted += 1;
        if (statusCode >= 400) counter.errors += 1;
        const bucket = statusBucket(statusCode);
        if (bucket) counter[bucket] += 1;
      }
    };
  };

  return {
    begin,
    snapshot() {
      return {
        ...counterSnapshot(total),
        by_route: Object.fromEntries(ROUTE_NAMES.map((name) => [name, counterSnapshot(routes[name])])),
      };
    },
  };
}

export function classifyAdapterRoute(method, pathname) {
  if (method === "POST" && pathname === "/v1/responses") return "responses";
  if (method === "POST" && pathname === "/v1/responses/compact") return "responses_compact";
  if (method === "GET" && pathname === "/v1/models") return "models";
  if (method === "POST" && pathname === "/v1/messages") return "messages";
  if (method === "POST" && pathname === "/v1/messages/count_tokens") return "messages_count_tokens";
  return "not_found";
}

export function isLoopbackAddress(address) {
  const normalized = String(address || "").trim().toLowerCase();
  if (normalized === "::1" || normalized === "[::1]") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  return isIP(ipv4) === 4 && ipv4.startsWith("127.");
}

function modelRegistryStatus(modelRegistry) {
  const modelData = Array.isArray(modelRegistry?.models)
    ? modelRegistry.models
    : modelRegistry?.models?.data;
  return {
    source: String(modelRegistry?.source || "built-in"),
    models: Array.isArray(modelData) ? modelData.length : 0,
    claude_models: Array.isArray(modelRegistry?.modelDefs) ? modelRegistry.modelDefs.length : 0,
  };
}

export function runtimeStatusPayload({ metrics, admission, modelRegistry } = {}) {
  const memory = process.memoryUsage();
  return {
    ...adapterHealthPayload(),
    uptime_ms: Math.round(process.uptime() * 1000),
    process: {
      rss_bytes: memory.rss,
      heap_used_bytes: memory.heapUsed,
      heap_total_bytes: memory.heapTotal,
      external_bytes: memory.external,
      array_buffers_bytes: memory.arrayBuffers,
    },
    requests: metrics?.snapshot?.() || createRequestMetrics().snapshot(),
    admission: admission?.diagnostics?.() || admission?.stats?.() || null,
    response_history: responseHistoryStats(),
    image_optimization: imageOptimizationStats(),
    copilot: copilotRuntimeStatus(),
    models: modelRegistryStatus(modelRegistry),
    limits: {
      max_body_bytes: OBSERVABILITY_RUNTIME_CONFIG.maxBodyBytes,
      max_decoded_body_bytes: OBSERVABILITY_RUNTIME_CONFIG.maxDecodedBodyBytes,
      max_sse_buffer_bytes: OBSERVABILITY_RUNTIME_CONFIG.maxSseBufferBytes,
      response_history_max_bytes: OBSERVABILITY_RUNTIME_CONFIG.responseHistoryMaxBytes,
      response_history_max_entries: OBSERVABILITY_RUNTIME_CONFIG.responseHistoryMaxEntries,
    },
  };
}
