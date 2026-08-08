function catalogData(catalog) {
  if (Array.isArray(catalog)) return catalog;
  return Array.isArray(catalog?.data) ? catalog.data : [];
}

function isClaudeCatalogEntry(model) {
  const id = String(model?.id || "").trim();
  const vendor = String(model?.vendor || "").trim().toLowerCase();
  return Boolean(id) && (vendor === "anthropic" || id.toLowerCase().startsWith("claude-"));
}

function isAllowedClaudeModel(model) {
  return isClaudeCatalogEntry(model)
    && String(model?.vendor || "").trim().toLowerCase() === "anthropic"
    && model?.model_picker_enabled !== false
    && Array.isArray(model?.supported_endpoints)
    && model.supported_endpoints.includes("/chat/completions");
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
      if (!id || !isClaudeCatalogEntry(model)) continue;
      known.add(id);
      if (enabled && isAllowedClaudeModel(model) && !allowed.has(id)) allowed.set(id, model);
    }
    cachedCatalog = catalog;
    cachedEnabled = enabled;
    cachedAllowed = allowed;
    cachedKnown = known;
    rebuilds += 1;
    return { allowed, known };
  }

  return Object.freeze({
    classify(modelId) {
      const id = String(modelId || "").trim();
      const { allowed, known } = availability();
      if (allowed.has(id)) return "claude";
      if (known.has(id) || id.toLowerCase().startsWith("claude-")) return "unsupported_claude";
      return "enterprise";
    },
    allowedModels() {
      return [...availability().allowed.values()];
    },
    diagnostics() {
      return { rebuilds, allowed: cachedAllowed.size, known: cachedKnown.size };
    },
  });
}
