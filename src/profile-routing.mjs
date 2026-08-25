import {
  isClaudeCopilotCatalogEntry,
  isClaudeCopilotModel,
} from "./models.mjs";
import { createRoutePlan } from "./route-plan.mjs";

function catalogData(catalog) {
  if (Array.isArray(catalog)) return catalog;
  return Array.isArray(catalog?.data) ? catalog.data : [];
}

export function profileRouting({ claudeMode = "inherited", claudeConfigured = false } = {}) {
  const isolated = claudeMode === "isolated" || claudeConfigured === true;
  return Object.freeze({ responses: "codex", messages: isolated ? "claude" : "codex" });
}

export function createPmStudioModelRouter({ getCatalog, isClaudeEnabled } = {}) {
  if (typeof getCatalog !== "function") throw new Error("getCatalog is required");
  if (typeof isClaudeEnabled !== "function") throw new Error("isClaudeEnabled is required");

  const unset = Symbol("unset");
  let cachedCatalog = unset;
  let cachedEnabled = false;
  let cachedAllowed = new Map();
  let cachedKnown = new Set();
  let rebuilds = 0;

  function availability() {
    const catalog = getCatalog();
    const enabled = isClaudeEnabled() === true;
    if (catalog === cachedCatalog && enabled === cachedEnabled) {
      return { allowed: cachedAllowed, known: cachedKnown };
    }

    const allowed = new Map();
    const known = new Set();
    for (const model of catalogData(catalog)) {
      const id = String(model?.id || "").trim();
      if (!id || !isClaudeCopilotCatalogEntry(model)) continue;
      known.add(id);
      if (enabled && isClaudeCopilotModel(model) && !allowed.has(id)) allowed.set(id, model);
    }
    cachedCatalog = catalog;
    cachedEnabled = enabled;
    cachedAllowed = allowed;
    cachedKnown = known;
    rebuilds += 1;
    return { allowed, known };
  }

  function classify(modelId) {
    const id = String(modelId || "").trim();
    const { allowed, known } = availability();
    if (allowed.has(id)) return "claude";
    if (known.has(id) || id.toLowerCase().startsWith("claude-")) return "unsupported_claude";
    return "enterprise";
  }

  function plan(modelId) {
    const id = String(modelId || "").trim();
    const modelType = classify(id);
    const protocol = "openai-chat-completions";
    if (modelType === "claude") {
      return createRoutePlan({
        disposition: "relay",
        origin: "ccdx",
        profile: "claude",
        protocol,
        model: id,
        surface: "pm-studio",
      });
    }
    if (modelType === "unsupported_claude") {
      return createRoutePlan({
        disposition: "reject",
        origin: "ccdx",
        profile: "claude",
        protocol,
        model: id || "unknown",
        surface: "pm-studio",
      });
    }
    return createRoutePlan({
      disposition: "native",
      origin: "pm-studio-native",
      profile: "enterprise",
      protocol,
      model: id || "unknown",
      surface: "pm-studio",
    });
  }

  return Object.freeze({
    plan,
    classify,
    allowedModels() {
      return [...availability().allowed.values()];
    },
    diagnostics() {
      return { rebuilds, allowed: cachedAllowed.size, known: cachedKnown.size };
    },
  });
}
