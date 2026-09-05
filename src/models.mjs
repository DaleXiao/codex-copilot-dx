export const CODEX_AUTO_REVIEW_MODEL = "codex-auto-review";
export const DEFAULT_CODEX_AUTO_REVIEW_MODEL = "gpt-5.5";
export const CODEX_GPT6_MODEL = "gpt-6-astra";

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

export function resolveCopilotPriorityTierModel(model, serviceTier, models) {
  const baseModel = String(model || "").trim();
  if (baseModel !== "gpt-5.6-sol" || serviceTier !== "priority") return null;
  const fastModelId = "gpt-5.6-sol-fast";
  const fastModel = copilotModelData(models)
    .find((entry) => String(entry?.id || "").trim() === fastModelId);
  const vendor = String(fastModel?.vendor || fastModel?.owned_by || "").trim().toLowerCase();
  const policy = String(fastModel?.policy?.state || "").trim().toLowerCase();
  if (vendor !== "openai"
    || policy !== "enabled"
    || fastModel?.model_picker_enabled !== true
    || !modelIsResponsesOnly(fastModel)) {
    return null;
  }
  return fastModelId;
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

export function gptModelIdsFromCopilotModels(models) {
  return uniqueIds(copilotModelData(models), (model) => {
    const id = String(model?.id || "").trim();
    return id.startsWith("gpt-")
      && model?.model_picker_enabled !== false
      && hasOpenAIEndpoint(model);
  });
}

export function responsesModelIdsFromCopilotModels(models) {
  return uniqueIds(copilotModelData(models), (model) => {
    const id = String(model?.id || "").trim();
    const endpoints = modelEndpoints(model);
    return id !== CODEX_AUTO_REVIEW_MODEL
      && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id)
      && model?.model_picker_enabled !== false
      && (endpoints.includes("/responses") || endpoints.includes("/v1/responses"));
  });
}

export function resolveOpenAIModel(model, env = process.env, options = {}) {
  const requestedModel = String(model || "");
  if (requestedModel !== CODEX_AUTO_REVIEW_MODEL) {
    return { requestedModel, upstreamModel: requestedModel };
  }

  const configuredModel = String(env.CCDX_AUTO_REVIEW_MODEL || options.autoReviewModel || "").trim();
  return {
    requestedModel,
    upstreamModel: configuredModel || DEFAULT_CODEX_AUTO_REVIEW_MODEL,
  };
}

export function codexAutoReviewModelStatus(models, env = process.env, options = {}) {
  const { upstreamModel } = resolveOpenAIModel(CODEX_AUTO_REVIEW_MODEL, env, options);
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
