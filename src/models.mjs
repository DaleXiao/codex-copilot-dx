const DEFAULT_CLAUDE_DESKTOP_MODEL_DEFS = [
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

export function claudeDesktopModelDefs(env = process.env) {
  const custom = parseModelAliasEnv(env.CCDX_CLAUDE_MODEL_ALIASES);
  return custom.length ? custom : DEFAULT_CLAUDE_DESKTOP_MODEL_DEFS.map((model) => ({ ...model }));
}

export function claudeDesktopModelIds(env = process.env) {
  return claudeDesktopModelDefs(env).map((model) => model.id);
}

export function resolveAnthropicModel(model, env = process.env) {
  const requestedModel = String(model || "");
  const match = claudeDesktopModelDefs(env).find((entry) => entry.id === requestedModel);
  return {
    requestedModel,
    upstreamModel: match?.upstream || requestedModel,
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

export function claudeDesktopModelsResponse(env = process.env) {
  return {
    object: "list",
    data: claudeDesktopModelDefs(env).map(anthropicModelInfo),
  };
}
