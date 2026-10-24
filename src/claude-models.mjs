import { modelReasoningEfforts } from "./provider-metadata.mjs";
import { createHash } from "node:crypto";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// M365's version separator differs from Anthropic's model ID spelling. Other
// aliases and unknown families are kept verbatim, never assigned another model.
export function claudeClientModelId(id) {
  return id.replace(/^(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)$/, "$1-$2");
}

function desktopModelId(id) {
  // Keep native Claude identities, including their family/capability detection.
  if (/^claude-(?:(?:opus|sonnet|haiku)-\d[\d.-]*|\d[\d.-]*-(?:opus|sonnet|haiku)(?:-\d{8})?)(?:-latest)?$/.test(id)) return claudeClientModelId(id);
  // Digits avoid accidentally embedding a vendor name in an opaque route ID.
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 24);
  return `ccdx/claude-compatible-${BigInt(`0x${digest}`).toString(10)}`;
}

export function claudeModelEntries(models, { desktopAliases = false } = {}) {
  const ids = new Set(), upstreamIds = new Set(models.map(model => model.id));
  return models.map(model => {
    const name = desktopAliases ? desktopModelId(model.id) : claudeClientModelId(model.id);
    if (ids.has(name) || name !== model.id && upstreamIds.has(name)) throw Object.assign(new Error("Claude model aliases collide; refresh the provider catalog"), { code: "claude_model_alias_collision", statusCode: 503 });
    ids.add(name);
    const advertised = modelReasoningEfforts(model);
    const maxEffort = EFFORTS.filter(value => advertised?.includes(value)).at(-1);
    return { name, ...(desktopAliases && name !== claudeClientModelId(model.id) ? { labelOverride: model.id } : {}), ...(maxEffort ? { maxEffort } : {}) };
  });
}

export function resolveClaudeModel(models, id, options) {
  const entries = claudeModelEntries(models, options); // Refuse ambiguous catalogs, including exact-ID collisions.
  return models.find((model, index) => model.id === id || entries[index].name === id);
}
