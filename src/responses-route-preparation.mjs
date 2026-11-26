import { CODEX_AUTO_REVIEW_MODEL, resolveOpenAIModel } from "./models.mjs";
import { MAX_DECODED_BODY_BYTES } from "./http-transport.mjs";
import { applyResponseHistoryRoutePlan } from "./responses-request.mjs";

export function resolveRequestModel(model, openAIModelEnv, autoReviewModelResolver) {
  const preference = model === CODEX_AUTO_REVIEW_MODEL && typeof autoReviewModelResolver === "function"
    ? autoReviewModelResolver() : undefined;
  const resolved = resolveOpenAIModel(model, openAIModelEnv, {
    autoReviewModel: typeof preference === "string" ? preference : preference?.model,
  });
  return { ...resolved, reasoningEffort: preference?.model === resolved.upstreamModel
    ? preference.reasoningEffort : undefined };
}

export function applySelectedRoute(prepared, routePlan, options) {
  try { return applyResponseHistoryRoutePlan(prepared, routePlan); }
  catch (error) {
    if (error.code !== "ccdx_provider_history_rebuild_required") throw error;
    return recoverSelectedRoute(prepared, routePlan, error, options);
  }
}

async function recoverSelectedRoute(prepared, routePlan, error, { req, env, signal, assertActive, reserveHistory }) {
  try {
    const { recoverLocalCompaction } = await import("./local-compaction-recovery.mjs");
    const restored = await recoverLocalCompaction(prepared, { request: req, env, signal, assertActive, reserveHistory, maxBytes: MAX_DECODED_BODY_BYTES });
    return applyResponseHistoryRoutePlan(restored, routePlan);
  } catch (failure) {
    assertActive?.();
    error.jsonBody.error.recovery.local_status = /^[a-z][a-z_]{1,60}$/.test(failure.code || "") ? failure.code : "local_history_unavailable";
    throw error;
  }
}
