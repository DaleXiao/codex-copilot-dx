import { defaultCopilotClient } from "../copilot.mjs";
import { applyCopilotResponsesRequestPolicies, stripUnsupportedGpt6ServiceTier } from "../copilot-responses-policy.mjs";
import { hasCopilotResponseRetryPolicy, openCopilotResponse, selectCopilotResponseRetryWithHistory } from "../copilot-responses-compat.mjs";
import { CODEX_AUTO_REVIEW_MODEL, modelIsResponsesOnly, modelSupportsChatCompletions, resolveCopilotPriorityTierModel } from "../models.mjs";
import { responsesBodyUsesCustomTools } from "../responses-bridge.mjs";
import { createRoutePlan } from "../route-plan.mjs";

const RESPONSES_ONLY_FALLBACK = new Set([
  "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "gpt-5.4",
  "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2-codex",
]);

function isResponsesOnly(model, endpoints) {
  if (endpoints) {
    const entry = { supported_endpoints: endpoints };
    if (modelSupportsChatCompletions(entry)) return false;
    if (modelIsResponsesOnly(entry)) return true;
  }
  return RESPONSES_ONLY_FALLBACK.has(model);
}

export function createGithubProvider({ client = defaultCopilotClient, profileId = "codex" } = {}) {
  const profile = typeof profileId === "function" ? profileId : () => profileId;
  return Object.freeze({
    id: "github",
    client,
    profileId: profile,
    selectModel(body, { requestedModel, upstreamModel }, models) {
      const priorityTierModel = requestedModel === upstreamModel
        ? resolveCopilotPriorityTierModel(upstreamModel, body.service_tier, models) : null;
      if (priorityTierModel) {
        upstreamModel = priorityTierModel;
        delete body.service_tier;
      }
      stripUnsupportedGpt6ServiceTier(body, requestedModel, upstreamModel, priorityTierModel);
      return { upstreamModel, forceResponses: Boolean(priorityTierModel) };
    },
    route(body, { requestedModel, upstreamModel, forceResponses, surface, getCachedModelEndpoints = client.getCachedModelEndpoints }) {
      let protocol = "openai-responses";
      if (surface === "responses") {
        const customTools = responsesBodyUsesCustomTools(body);
        const endpoints = getCachedModelEndpoints(upstreamModel);
        const native = forceResponses || requestedModel === CODEX_AUTO_REVIEW_MODEL
          || isResponsesOnly(upstreamModel, endpoints)
          || (customTools && Array.isArray(endpoints) && (endpoints.includes("/responses") || endpoints.includes("/v1/responses")));
        if (customTools && !native) {
          const message = `Model ${upstreamModel} has custom tool items that cannot be represented by Chat Completions, and cached endpoint metadata does not confirm Responses support`;
          throw Object.assign(new Error(message), { statusCode: 400, code: "ccdx_custom_tools_require_responses",
            jsonBody: { error: { message, type: "invalid_request_error", code: "ccdx_custom_tools_require_responses", model: upstreamModel } } });
        }
        protocol = native ? "openai-responses" : "openai-chat-completions";
      }
      // Preserve the established GitHub replay identity across the extraction.
      return createRoutePlan({ disposition: "relay", origin: "ccdx", profile: profile(), protocol, model: upstreamModel, surface });
    },
    applyRequestPolicies: applyCopilotResponsesRequestPolicies,
    compatibility: Object.freeze({ openResponse: openCopilotResponse,
      hasRetry: hasCopilotResponseRetryPolicy, selectRetry: selectCopilotResponseRetryWithHistory }),
  });
}

export const defaultGithubProvider = createGithubProvider();
