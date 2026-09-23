import {
  MIB,
  RESPONSE_HISTORY_MAX_MIB,
  RESPONSE_HISTORY_MIN_MIB,
} from "./cache-limits.mjs";
import {
  clearResponseHistory,
  responseHistoryStats,
  setResponseHistoryMaxBytes,
} from "./response-history.mjs";
import {
  clearImageOptimizationCache,
  imageOptimizationStats,
} from "./image-optimization.mjs";

export const ADAPTER_CACHE_PATH = "/_ccdx/cache";

export function cacheRuntimeSnapshot() {
  return {
    response_history: responseHistoryStats(),
    image_optimization: imageOptimizationStats(),
  };
}

export function setHistoryCacheLimit(maxBytes) {
  const mib = Number(maxBytes) / MIB;
  if (!Number.isSafeInteger(mib)
    || mib < RESPONSE_HISTORY_MIN_MIB
    || mib > RESPONSE_HISTORY_MAX_MIB) {
    const error = new Error(`History cache limit must be an integer from ${RESPONSE_HISTORY_MIN_MIB} to ${RESPONSE_HISTORY_MAX_MIB} MiB`);
    error.code = "ccdx_cache_limit_invalid";
    throw error;
  }
  return { changed: setResponseHistoryMaxBytes(maxBytes).previousMaxBytes !== maxBytes, ...cacheRuntimeSnapshot() };
}

export function cleanRuntimeCaches({ history = false } = {}) {
  const imageStats = imageOptimizationStats();
  if (imageStats.active > 0 || imageStats.queued > 0 || imageStats.cache_inflight > 0) {
    const error = new Error("Image optimization is active; retry cache cleanup after current requests finish");
    error.code = "ccdx_cache_busy";
    throw error;
  }
  const historyStats = responseHistoryStats();
  if (history && historyStats.pinnedTrees > 0) {
    const error = new Error("Response history is active; retry cleanup after current requests finish");
    error.code = "ccdx_cache_busy";
    throw error;
  }
  const imageOptimization = clearImageOptimizationCache();
  const responseHistory = history ? clearResponseHistory() : null;
  return {
    cleaned: {
      image_optimization: imageOptimization,
      ...(responseHistory ? { response_history: responseHistory } : {}),
    },
    ...cacheRuntimeSnapshot(),
  };
}
