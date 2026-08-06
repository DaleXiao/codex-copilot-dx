import {
  isValidModelList,
  loadModelCache,
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
  const models = JSON.parse(result.body);
  if (!isValidModelList(models)) {
    throw new Error("Copilot models response contained no valid models");
  }
  return models;
}

export function createProfileModelRuntime({
  codexClient,
  claudeClient = codexClient,
  claudeMode = "inherited",
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

  const codexRegistry = { modelDefs: undefined, models: undefined, source: "built-in" };
  const claudeRegistry = claudeMode === "inherited"
    ? codexRegistry
    : { modelDefs: undefined, models: undefined, source: "built-in" };
  const customClaudeDefs = parseModelAliasEnv(env.CCDX_CLAUDE_MODEL_ALIASES);
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
      registry.modelDefs = discovered;
      notifyClaudeModels(discovered);
    }
    return registry.modelDefs;
  }

  function loadCached({ client, profile, registry, ownsClaudeModels }) {
    const credentialFingerprint = profile === "claude"
      ? String(claudeCredentialFingerprint || "").trim()
      : "";
    if (profile === "claude" && !credentialFingerprint) return false;
    const cached = loadModelCache({ home, profile, credentialFingerprint });
    if (!cached) return false;
    try {
      applyCatalog({ client, models: cached, registry, source: "cache", ownsClaudeModels });
      return true;
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

  function persist(models, profile) {
    const credentialFingerprint = profile === "claude"
      ? String(claudeCredentialFingerprint || "").trim()
      : "";
    if (profile === "claude" && !credentialFingerprint) return;
    try {
      saveModelCache(models, { home, profile, credentialFingerprint });
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

  async function refreshProfile({ client, profile, registry, ownsClaudeModels, checksCodex }) {
    const controllerLabel = claudeMode === "inherited"
      ? ""
      : `${profile === "codex" ? "Codex" : "Claude"} `;
    try {
      const models = await requestCatalog(client);
      if (checksCodex) checkCodexCatalog(models);
      const modelDefs = applyCatalog({
        client,
        models,
        registry,
        source: "live",
        ownsClaudeModels,
      });
      persist(models, profile);
      if (ownsClaudeModels) logClaudeCatalog(modelDefs);
      return modelDefs;
    } catch (error) {
      const fallback = fallbackLabel(registry, profile);
      const timedOut = error?.name === "AbortError" || error?.code === "ABORT_ERR";
      const message = timedOut
        ? `${controllerLabel}model refresh timed out after ${refreshTimeoutMs}ms; using ${fallback}`
        : `Could not refresh ${controllerLabel.toLowerCase()}model list; using ${fallback} (${error.message})`;
      emit("warn", message[0].toUpperCase() + message.slice(1));
      return registry.modelDefs;
    }
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
