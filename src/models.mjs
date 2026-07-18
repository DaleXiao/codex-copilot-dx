const DEFAULT_CLAUDE_DESKTOP_MODEL_DEFS = [
  {
    id: "claude-sonnet-5",
    upstream: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    createdAt: "2026-06-30T00:00:00Z",
    maxInputTokens: 1000000,
    maxOutputTokens: 64000,
  },
  {
    id: "claude-sonnet-4.6",
    upstream: "claude-sonnet-4.6",
    displayName: "Claude Sonnet 4.6",
    createdAt: "2026-02-17T00:00:00Z",
    maxInputTokens: 200000,
    maxOutputTokens: 8192,
  },
  {
    id: "claude-opus-4.8",
    upstream: "claude-opus-4.8",
    displayName: "Claude Opus 4.8",
    createdAt: "2026-05-28T00:00:00Z",
    maxInputTokens: 200000,
    maxOutputTokens: 8192,
  },
  {
    id: "claude-haiku-4.5",
    upstream: "claude-haiku-4.5",
    displayName: "Claude Haiku 4.5",
    createdAt: "2025-10-01T00:00:00Z",
    maxInputTokens: 200000,
    maxOutputTokens: 8192,
  },
];

const DEFAULT_CLAUDE_MODEL_ALIAS_DEFS = [
  {
    id: "claude-sonnet-4-6",
    upstream: "claude-sonnet-4.6",
    displayName: "Claude Sonnet 4.6",
    createdAt: "2026-02-17T00:00:00Z",
    maxInputTokens: 200000,
    maxOutputTokens: 8192,
  },
  {
    id: "claude-opus-4-8",
    upstream: "claude-opus-4.8",
    displayName: "Claude Opus 4.8",
    createdAt: "2026-05-28T00:00:00Z",
    maxInputTokens: 200000,
    maxOutputTokens: 8192,
  },
  {
    id: "claude-haiku-4-5",
    upstream: "claude-haiku-4.5",
    displayName: "Claude Haiku 4.5",
    createdAt: "2025-10-01T00:00:00Z",
    maxInputTokens: 200000,
    maxOutputTokens: 8192,
  },
];

export const CODEX_AUTO_REVIEW_MODEL = "codex-auto-review";
export const DEFAULT_CODEX_AUTO_REVIEW_MODEL = "gpt-5.5";

function cleanList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseModelAliasEnv(value) {
  const aliases = [];
  for (const entry of cleanList(value)) {
    const [id, upstream] = entry.split("=", 2).map((part) => part?.trim());
    if (!id || !upstream) continue;
    aliases.push({
      id,
      upstream,
      displayName: id,
      createdAt: "2025-01-01T00:00:00Z",
      maxInputTokens: 200000,
      maxOutputTokens: 8192,
    });
  }
  return aliases;
}

function cloneModelDefs(modelDefs) {
  return modelDefs.map((model) => ({ ...model }));
}

function numericLimit(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function hasMessagesEndpoint(model) {
  const endpoints = Array.isArray(model?.supported_endpoints) ? model.supported_endpoints : [];
  return endpoints.includes("/v1/messages") || endpoints.includes("/chat/completions");
}

function hasOpenAIEndpoint(model) {
  const endpoints = Array.isArray(model?.supported_endpoints) ? model.supported_endpoints : [];
  return endpoints.includes("/responses") || endpoints.includes("/v1/responses") || endpoints.includes("/chat/completions");
}

// Endpoint-based routing helpers. A model is "responses-only" when it exposes a
// /responses endpoint but does NOT accept /chat/completions. These read the real
// model metadata so new models (e.g. gpt-5.6-*) route correctly without a hardcoded list.
export function modelEndpoints(model) {
  return Array.isArray(model?.supported_endpoints) ? model.supported_endpoints : [];
}

export function modelSupportsChatCompletions(model) {
  return modelEndpoints(model).includes("/chat/completions");
}

export function modelIsResponsesOnly(model) {
  const endpoints = modelEndpoints(model);
  const hasResponses = endpoints.includes("/responses") || endpoints.includes("/v1/responses");
  return hasResponses && !endpoints.includes("/chat/completions");
}

function copilotModelData(models) {
  const data = Array.isArray(models) ? models : models?.data;
  return Array.isArray(data) ? data : [];
}

function uniqueIds(models, predicate) {
  const ids = [];
  const seen = new Set();
  for (const model of models) {
    if (!predicate(model)) continue;
    const id = String(model.id || "").trim();
    if (!id || seen.has(id)) continue;
    ids.push(id);
    seen.add(id);
  }
  return ids;
}

function isClaudeCopilotModel(model) {
  const id = String(model?.id || "").trim();
  const vendor = String(model?.vendor || "").toLowerCase();
  return id
    && (id.startsWith("claude-") || vendor === "anthropic")
    && model?.model_picker_enabled !== false
    && hasMessagesEndpoint(model);
}

export function gptModelIdsFromCopilotModels(models) {
  return uniqueIds(copilotModelData(models), (model) => {
    const id = String(model?.id || "").trim();
    return id.startsWith("gpt-")
      && model?.model_picker_enabled !== false
      && hasOpenAIEndpoint(model);
  });
}

export function claudeDesktopModelDefsFromCopilotModels(models) {
  const data = copilotModelData(models);

  const defs = [];
  const seen = new Set();
  for (const model of data) {
    if (!isClaudeCopilotModel(model)) continue;
    const id = String(model.id || "").trim();
    if (seen.has(id)) continue;
    seen.add(id);

    const limits = model.capabilities?.limits || {};
    defs.push({
      id,
      upstream: id,
      displayName: String(model.name || id),
      createdAt: "2025-01-01T00:00:00Z",
      maxInputTokens: numericLimit(limits.max_context_window_tokens, numericLimit(limits.max_prompt_tokens, 200000)),
      maxOutputTokens: numericLimit(limits.max_output_tokens, 8192),
    });
  }

  return defs;
}

export function claudeDesktopModelDefs(env = process.env, options = {}) {
  const custom = parseModelAliasEnv(env.CCDX_CLAUDE_MODEL_ALIASES);
  if (custom.length) return custom;
  if (Array.isArray(options.modelDefs) && options.modelDefs.length) return cloneModelDefs(options.modelDefs);
  return cloneModelDefs(DEFAULT_CLAUDE_DESKTOP_MODEL_DEFS);
}

export function claudeDesktopModelIds(env = process.env, options = {}) {
  return claudeDesktopModelDefs(env, options).map((model) => model.id);
}

function claudeModelResolutionDefs(env = process.env, options = {}) {
  const defs = claudeDesktopModelDefs(env, options);
  if (parseModelAliasEnv(env.CCDX_CLAUDE_MODEL_ALIASES).length) return defs;

  const upstreamIds = new Set(defs.map((model) => model.upstream));
  const aliases = DEFAULT_CLAUDE_MODEL_ALIAS_DEFS.filter((alias) => upstreamIds.has(alias.upstream));
  return [...defs, ...aliases];
}

export function resolveAnthropicModel(model, env = process.env, options = {}) {
  const requestedModel = String(model || "");
  const match = claudeModelResolutionDefs(env, options).find((entry) => entry.id === requestedModel);
  return {
    requestedModel,
    upstreamModel: match?.upstream || requestedModel,
  };
}

export function resolveOpenAIModel(model, env = process.env) {
  const requestedModel = String(model || "");
  if (requestedModel !== CODEX_AUTO_REVIEW_MODEL) {
    return { requestedModel, upstreamModel: requestedModel };
  }

  const configuredModel = String(env.CCDX_AUTO_REVIEW_MODEL || "").trim();
  return {
    requestedModel,
    upstreamModel: configuredModel || DEFAULT_CODEX_AUTO_REVIEW_MODEL,
  };
}

export function codexAutoReviewModelStatus(models, env = process.env) {
  const { upstreamModel } = resolveOpenAIModel(CODEX_AUTO_REVIEW_MODEL, env);
  const model = copilotModelData(models).find((entry) => String(entry?.id || "").trim() === upstreamModel);
  if (!model) return { available: false, upstreamModel, reason: "model is not advertised" };
  const endpoints = modelEndpoints(model);
  const available = endpoints.includes("/responses") || endpoints.includes("/v1/responses");
  return {
    available,
    upstreamModel,
    reason: available ? "" : "model does not advertise a Responses endpoint",
  };
}

export function anthropicModelInfo(model) {
  return {
    id: model.id,
    type: "model",
    display_name: model.displayName || model.id,
    created_at: model.createdAt || "2025-01-01T00:00:00Z",
    max_input_tokens: model.maxInputTokens || 200000,
    max_tokens: model.maxOutputTokens || 8192,
  };
}

export function claudeDesktopModelsResponse(env = process.env, options = {}) {
  return {
    object: "list",
    data: claudeDesktopModelDefs(env, options).map(anthropicModelInfo),
  };
}
