import { isImageModel } from "./image-models.mjs";
import { autoReviewReasoningEfforts } from "./models.mjs";
import { modelDisplayName } from "./model-display.mjs";
// Public metadata only. Credentials and provider transport never enter this layer.
export const isProviderId = value => typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value)
  && !["constructor", "prototype"].includes(value);

export function modelReasoningEfforts(model) {
  const values = model?.capability ? model.capability.values.reasoning === false ? [] : model.capability.values.reasoning_efforts : model?.capabilities?.supports?.reasoning_effort;
  return Array.isArray(values) ? [...new Set(values.filter(value => typeof value === "string" && /^[a-z][a-z0-9_-]{0,15}$/.test(value)))].slice(0, 16) : null;
}

export function publicModelCatalog(models, { clients = () => [], selectable = () => false, maker = model => model.publisher || model.vendor || model.owned_by || "Unknown" } = {}) {
  return models.slice(0, 1000).filter(model => typeof model?.id === "string").map(model => ({
    id: model.id, ...(isImageModel(model) ? { kind: "image" } : {}), display_name: modelDisplayName(model), vendor: maker(model), ...(model.owned_by ? { owned_by: model.owned_by } : {}),
    endpoints: [["responses", ["/responses", "/v1/responses"]], ["chat", ["/chat/completions", "/v1/chat/completions"]],
      ["messages", ["/v1/messages"]], ["images", ["/images/generations", "/v1/images/generations"]], ["image_edits", ["/images/edits", "/v1/images/edits"]]].filter(([, paths]) => paths.some(path => model.supported_endpoints?.includes(path))).map(([label]) => label),
    preview: model.preview === true, selectable: selectable(model), clients: clients(model),
    reasoning_efforts: isImageModel(model) ? null : modelReasoningEfforts(model), auto_review_efforts: isImageModel(model) ? [] : model.capability ? modelReasoningEfforts(model) || [] : autoReviewReasoningEfforts(model),
    context_window: model.capability?.values.context_window ?? (Number.isSafeInteger(model.capabilities?.limits?.max_context_window_tokens)
      && model.capabilities.limits.max_context_window_tokens > 0 ? model.capabilities.limits.max_context_window_tokens : null),
    state: model.policy?.state && model.policy.state !== "enabled" ? "restricted" : model.model_picker_enabled === false && !isImageModel(model) ? "hidden" : "listed",
  }));
}
