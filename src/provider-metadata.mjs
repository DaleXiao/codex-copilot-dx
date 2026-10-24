import { autoReviewReasoningEfforts } from "./models.mjs";
// Public metadata only. Credentials and provider transport never enter this layer.
export const isProviderId = value => typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value)
  && !["constructor", "prototype"].includes(value);

export function modelReasoningEfforts(model) {
  const values = model?.capability ? model.capability.values.reasoning === false ? [] : model.capability.values.reasoning_efforts : model?.capabilities?.supports?.reasoning_effort;
  return Array.isArray(values) ? [...new Set(values.filter(value => typeof value === "string" && /^[a-z][a-z0-9_-]{0,15}$/.test(value)))].slice(0, 16) : null;
}

export function publicModelCatalog(models, { clients = () => [], selectable = () => false } = {}) {
  return models.slice(0, 1000).filter(model => typeof model?.id === "string").map(model => ({
    id: model.id, vendor: model.publisher || model.vendor || model.owned_by || "Unknown",
    endpoints: [["responses", ["/responses", "/v1/responses"]], ["chat", ["/chat/completions", "/v1/chat/completions"]],
      ["messages", ["/v1/messages"]]].filter(([, paths]) => paths.some(path => model.supported_endpoints?.includes(path))).map(([label]) => label),
    preview: model.preview === true, selectable: selectable(model), clients: clients(model),
    reasoning_efforts: modelReasoningEfforts(model), auto_review_efforts: model.capability ? modelReasoningEfforts(model) || [] : autoReviewReasoningEfforts(model),
    context_window: model.capability?.values.context_window ?? (Number.isSafeInteger(model.capabilities?.limits?.max_context_window_tokens)
      && model.capabilities.limits.max_context_window_tokens > 0 ? model.capabilities.limits.max_context_window_tokens : null),
    state: model.policy?.state && model.policy.state !== "enabled" ? "restricted" : model.model_picker_enabled === false ? "hidden" : "listed",
  }));
}
