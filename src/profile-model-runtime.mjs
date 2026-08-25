import {
  isValidModelList,
  loadModelCacheEntry,
  saveModelCache,
} from "./model-cache.mjs";
import {
  claudeDesktopModelDefsFromCopilotModels,
  codexAutoReviewModelStatus,
  gptModelIdsFromCopilotModels,
  parseModelAliasEnv,
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
    modelDefs: undefined,
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

function sameModelDefs(left, right) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return JSON.stringify(left) === JSON.stringify(right);
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
  claudeClient = codexClient,
  claudeMode = "inherited",
  codexCredentialFingerprint = "",
  claudeCredentialFingerprint = "",
  home,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log = defaultLog,
  onClaudeModelsChanged = () => {},
  autoReviewModelResolver = () => undefined,
  commandName = "ccdx",
} = {}) {
  if (!codexClient) throw new Error("codexClient is required");
  if (claudeMode !== "inherited" && claudeMode !== "isolated") {
    throw new Error(`Unsupported Claude model mode: ${claudeMode}`);
  }
  if (claudeMode === "isolated" && claudeClient === codexClient) {
    throw new Error("Isolated Claude models require an isolated Claude client");
  }

  const codexRegistry = createModelRegistry();
  const claudeRegistry = claudeMode === "inherited"
    ? codexRegistry
    : createModelRegistry();
  const customClaudeDefs = parseModelAliasEnv(env.CCDX_CLAUDE_MODEL_ALIASES);
  const refreshFlights = new Map();
  const refreshGenerations = new Map();
  const refreshTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TIMEOUT_MS;

  function emit(kind, message) {
    if (typeof log === "function") log(kind, message);
  }

  function notifyClaudeModels(modelDefs) {
    if (!Array.isArray(modelDefs) || !modelDefs.length) return;
    try {
      const pending = onClaudeModelsChanged(modelDefs);
      pending?.catch?.((error) => emit("warn", `Could not apply refreshed Claude models (${error.message})`));
    } catch (error) {
      emit("warn", `Could not apply refreshed Claude models (${error.message})`);
    }
  }

  function applyCatalog({ client, models, registry, source, ownsClaudeModels }) {
    if (!isValidModelList(models)) throw new Error("Copilot models response contained no valid models");
    client.cacheModelEndpoints(models);
    registry.models = models;
    registry.source = source;

    if (!ownsClaudeModels) return registry.modelDefs;
    const discovered = customClaudeDefs.length
      ? customClaudeDefs.map((model) => ({ ...model }))
      : claudeDesktopModelDefsFromCopilotModels(models);
    if (discovered.length) {
      const changed = !sameModelDefs(registry.modelDefs, discovered);
      registry.modelDefs = discovered;
      if (changed) notifyClaudeModels(discovered);
    }
    return registry.modelDefs;
  }

  function loadCached({ client, profile, registry, ownsClaudeModels }) {
    const credentialFingerprint = profile === "claude"
      ? String(claudeCredentialFingerprint || "").trim()
      : String(codexCredentialFingerprint || "").trim();
    if (profile === "claude" && !credentialFingerprint) return false;
    const cached = loadModelCacheEntry({ home, profile, credentialFingerprint });
    if (!cached) return false;
    try {
      applyCatalog({ client, models: cached.models, registry, source: "cache", ownsClaudeModels });
      registry.cacheState = cached.state;
      registry.cacheSavedAtMs = cached.savedAtMs;
      return { loaded: true, stale: cached.state === "stale" };
    } catch {
      return false;
    }
  }

  async function requestCatalog(client) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), refreshTimeoutMs);
    try {
      return parsedCatalog(await client.listModels({ signal: controller.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  function checkCodexCatalog(models) {
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

  function persist(models, profile, registry, generation) {
    const credentialFingerprint = profile === "claude"
      ? String(claudeCredentialFingerprint || "").trim()
      : String(codexCredentialFingerprint || "").trim();
    if (profile === "claude" && !credentialFingerprint) return;
    try {
      const saved = saveModelCache(models, {
        home,
        profile,
        credentialFingerprint,
        isCurrent: () => refreshGenerations.get(profile) === generation,
      });
      if (saved) {
        registry.cacheState = "fresh";
        registry.cacheSavedAtMs = Date.now();
      }
    } catch (error) {
      const label = profile === "codex" ? "Copilot" : "Claude Copilot";
      emit("warn", `Could not persist the ${label} model cache (${error.message})`);
    }
  }

  function logClaudeCatalog(modelDefs) {
    if (customClaudeDefs.length) {
      emit("info", "Using CCDX_CLAUDE_MODEL_ALIASES for Claude models");
    } else if (modelDefs?.length) {
      emit("ok", `Refreshed Claude models from GitHub Copilot: ${modelDefs.map((model) => model.id).join(", ")}`);
    } else {
      emit("warn", "Copilot models response contained no Claude models; using built-in Claude models");
    }
  }

  function fallbackLabel(registry, profile) {
    if (claudeMode === "inherited") {
      return registry.modelDefs?.length ? `${registry.source} model list` : "built-in model list";
    }
    if (isValidModelList(registry.models)) return `${registry.source} model list`;
    return profile === "claude" ? "built-in model list" : "no cached model list";
  }

  async function performRefresh({ client, profile, registry, ownsClaudeModels, checksCodex }, generation) {
    const controllerLabel = claudeMode === "inherited"
      ? ""
      : `${profile === "codex" ? "Codex" : "Claude"} `;
    try {
      const models = await requestCatalog(client);
      if (refreshGenerations.get(profile) !== generation) return registry.modelDefs;
      if (checksCodex) checkCodexCatalog(models);
      const modelDefs = applyCatalog({
        client,
        models,
        registry,
        source: "live",
        ownsClaudeModels,
      });
      persist(models, profile, registry, generation);
      registry.lastError = null;
      registry.lastErrorAtMs = null;
      if (ownsClaudeModels) logClaudeCatalog(modelDefs);
      return modelDefs;
    } catch (error) {
      if (refreshGenerations.get(profile) !== generation) return registry.modelDefs;
      const fallback = fallbackLabel(registry, profile);
      const timedOut = error?.name === "AbortError" || error?.code === "ABORT_ERR";
      const diagnostic = safeRefreshError(error, { timedOut, timeoutMs: refreshTimeoutMs });
      registry.lastError = diagnostic;
      registry.lastErrorAtMs = Date.now();
      const message = timedOut
        ? `${controllerLabel}model refresh timed out after ${refreshTimeoutMs}ms; using ${fallback}`
        : `Could not refresh ${controllerLabel.toLowerCase()}model list; using ${fallback} (${diagnostic})`;
      emit("warn", message[0].toUpperCase() + message.slice(1));
      return registry.modelDefs;
    }
  }

  function refreshProfile(options) {
    const { profile, registry } = options;
    const existing = refreshFlights.get(profile);
    if (existing) return existing.promise;

    const generation = (refreshGenerations.get(profile) || 0) + 1;
    refreshGenerations.set(profile, generation);
    registry.generation = generation;
    registry.refreshInFlight = true;
    const flight = { generation, promise: null };
    refreshFlights.set(profile, flight);
    flight.promise = performRefresh(options, generation).finally(() => {
      if (refreshFlights.get(profile) === flight) refreshFlights.delete(profile);
      if (refreshGenerations.get(profile) === generation) registry.refreshInFlight = false;
    });
    return flight.promise;
  }

  function refreshCodex() {
    return refreshProfile({
      client: codexClient,
      profile: "codex",
      registry: codexRegistry,
      ownsClaudeModels: claudeMode === "inherited",
      checksCodex: true,
    });
  }

  function refreshClaude() {
    if (claudeMode === "inherited") return refreshCodex();
    return refreshProfile({
      client: claudeClient,
      profile: "claude",
      registry: claudeRegistry,
      ownsClaudeModels: true,
      checksCodex: false,
    });
  }

  function initializeProfile({ client, profile, registry, ownsClaudeModels, refresh }) {
    return initializeModelRegistry({
      loadCached: () => loadCached({ client, profile, registry, ownsClaudeModels }),
      currentModelDefs: () => registry.modelDefs,
      refresh,
    });
  }

  async function initialize() {
    const codexInitialization = initializeProfile({
      client: codexClient,
      profile: "codex",
      registry: codexRegistry,
      ownsClaudeModels: claudeMode === "inherited",
      refresh: refreshCodex,
    });
    if (claudeMode === "inherited") {
      const shared = await codexInitialization;
      return { codex: shared, claude: shared };
    }
    const claudeInitialization = initializeProfile({
      client: claudeClient,
      profile: "claude",
      registry: claudeRegistry,
      ownsClaudeModels: true,
      refresh: refreshClaude,
    });
    const [codex, claude] = await Promise.all([codexInitialization, claudeInitialization]);
    return { codex, claude };
  }

  async function refreshAll() {
    if (claudeMode === "inherited") {
      const shared = await refreshCodex();
      return { codex: shared, claude: shared };
    }
    const [codex, claude] = await Promise.all([refreshCodex(), refreshClaude()]);
    return { codex, claude };
  }

  return {
    codexRegistry,
    claudeRegistry,
    initialize,
    refreshAll,
    refreshCodex,
    refreshClaude,
  };
}
