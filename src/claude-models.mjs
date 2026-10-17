import { modelReasoningEfforts } from "./provider-metadata.mjs";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// M365's version separator differs from Anthropic's model ID spelling. Other
// aliases and unknown families are kept verbatim, never assigned another model.
export function claudeClientModelId(id) {
  return id.replace(/^(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)$/, "$1-$2");
}

export function claudeModelEntries(models) {
  const ids = new Set();
  return models.map(model => {
    const name = claudeClientModelId(model.id);
    if (ids.has(name)) throw Object.assign(new Error("Claude model aliases collide; refresh the provider catalog"), { code: "claude_model_alias_collision", statusCode: 503 });
    ids.add(name);
    const advertised = modelReasoningEfforts(model);
    const maxEffort = EFFORTS.filter(value => advertised?.includes(value)).at(-1);
    return { name, ...(maxEffort ? { maxEffort } : {}) };
  });
}

export function resolveClaudeModel(models, id) {
  claudeModelEntries(models); // Refuse ambiguous catalogs, including exact-ID collisions.
  return models.find(model => model.id === id || claudeClientModelId(model.id) === id);
}
