import {
  isValidModelList,
  loadModelCacheEntry,
  saveModelCache,
} from "./model-cache.mjs";
import {
  codexAutoReviewModelStatus,
  gptModelIdsFromCopilotModels,
} from "./models.mjs";
import { initializeModelRegistry } from "./startup.mjs";
import { status } from "./status.mjs";

const DEFAULT_TIMEOUT_MS = 5000;

function defaultLog(kind, message) {
  console.log(status(kind, message));
}

function parsedCatalog(result) {
  if (result?.status < 200 || result?.status >= 300) {
    throw new Error(`Copilot models returned HTTP ${result?.status}`);
  }
  let models;
  try {
    models = JSON.parse(result.body);
  } catch {
    throw new Error("Copilot models response was not valid JSON");
  }
  if (!isValidModelList(models)) {
    throw new Error("Copilot models response contained no valid models");
  }
  return models;
}

function createModelRegistry() {
  return {
    models: undefined,
    source: "built-in",
    cacheState: "none",
    cacheSavedAtMs: null,
    lastError: null,
    lastErrorAtMs: null,
    refreshInFlight: false,
    generation: 0,
  };
}

function safeRefreshError(error, { timedOut = false, timeoutMs } = {}) {
  if (timedOut) return `Model refresh timed out after ${timeoutMs}ms`;
  const raw = String(error?.message || error?.name || "Model refresh failed")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b(?:github_pat_|gh[pousr]_|copilot_)[A-Za-z0-9._-]+\b/gi, "<redacted>")
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
    .trim();
  return (raw || "Model refresh failed").slice(0, 240);
}

export function createProfileModelRuntime({
  codexClient,
  codexCredentialFingerprint = "",
  home,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log = defaultLog,
  autoReviewModelResolver = () => undefined,
  commandName = "ccdx",
} = {}) {
  if (!codexClient) throw new Error("codexClient is required");

  const codexRegistry = createModelRegistry();
  const refreshTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TIMEOUT_MS;
  let refreshFlight = null;
  let refreshGeneration = 0;

  function emit(kind, message) {
    if (typeof log === "function") log(kind, message);
  }

  function applyCatalog(models, source) {
    if (!isValidModelList(models)) throw new Error("Copilot models response contained no valid models");
    codexClient.cacheModelEndpoints(models);
    codexRegistry.models = models;
    codexRegistry.source = source;
    return models;
  }

  function loadCached() {
    const cached = loadModelCacheEntry({
      home,
      profile: "codex",
      credentialFingerprint: String(codexCredentialFingerprint || "").trim(),
    });
    if (!cached) return false;
    try {
      applyCatalog(cached.models, "cache");
      codexRegistry.cacheState = cached.state;
      codexRegistry.cacheSavedAtMs = cached.savedAtMs;
      return { loaded: true, stale: cached.state === "stale" };
    } catch {
      return false;
    }
  }

  async function requestCatalog() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), refreshTimeoutMs);
    try {
      return parsedCatalog(await codexClient.listModels({ signal: controller.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  function checkCatalog(models) {
    const autoReview = codexAutoReviewModelStatus(models, env, {
      autoReviewModel: autoReviewModelResolver(),
    });
    if (!autoReview.available) {
      emit("warn", `Auto-review target ${autoReview.upstreamModel} is unavailable: ${autoReview.reason}. Run ${commandName} doctor --compat to verify the live path.`);
    }
    const gptModelIds = gptModelIdsFromCopilotModels(models);
    if (gptModelIds.length) {
      emit("ok", `Refreshed GPT models from GitHub Copilot: ${gptModelIds.join(", ")}`);
    } else {
      emit("warn", "Copilot models response contained no GPT models");
    }
  }

  function persist(models, generation) {
    try {
      const saved = saveModelCache(models, {
        home,
        profile: "codex",
        credentialFingerprint: String(codexCredentialFingerprint || "").trim(),
        isCurrent: () => refreshGeneration === generation,
      });
      if (saved) {
        codexRegistry.cacheState = "fresh";
        codexRegistry.cacheSavedAtMs = Date.now();
      }
    } catch (error) {
      emit("warn", `Could not persist the Copilot model cache (${error.message})`);
    }
  }

  async function performRefresh(generation) {
    try {
      const models = await requestCatalog();
      if (refreshGeneration !== generation) return codexRegistry.models;
      checkCatalog(models);
      applyCatalog(models, "live");
      persist(models, generation);
      codexRegistry.lastError = null;
      codexRegistry.lastErrorAtMs = null;
      return models;
    } catch (error) {
      if (refreshGeneration !== generation) return codexRegistry.models;
      const timedOut = error?.name === "AbortError" || error?.code === "ABORT_ERR";
      const diagnostic = safeRefreshError(error, { timedOut, timeoutMs: refreshTimeoutMs });
      codexRegistry.lastError = diagnostic;
      codexRegistry.lastErrorAtMs = Date.now();
      const fallback = isValidModelList(codexRegistry.models)
        ? `${codexRegistry.source} model list`
        : "no cached model list";
      emit("warn", timedOut
        ? `Model refresh timed out after ${refreshTimeoutMs}ms; using ${fallback}`
        : `Could not refresh model list; using ${fallback} (${diagnostic})`);
      return codexRegistry.models;
    }
  }

  function refreshCodex() {
    if (refreshFlight) return refreshFlight;
    const generation = refreshGeneration + 1;
    refreshGeneration = generation;
    codexRegistry.generation = generation;
    codexRegistry.refreshInFlight = true;
    const flight = performRefresh(generation).finally(() => {
      if (refreshFlight === flight) refreshFlight = null;
      if (refreshGeneration === generation) codexRegistry.refreshInFlight = false;
    });
    refreshFlight = flight;
    return flight;
  }

  async function initialize() {
    const initialized = await initializeModelRegistry({
      loadCached,
      currentModelDefs: () => codexRegistry.models,
      refresh: refreshCodex,
    });
    const { modelDefs: models, ...state } = initialized;
    return { codex: { ...state, models } };
  }

  async function refreshAll() {
    return { codex: await refreshCodex() };
  }

  return {
    codexRegistry,
    initialize,
    refreshAll,
    refreshCodex,
  };
}
