import { errorEvidenceText } from "./operation-error.mjs";
import { removeNativeImageTools as applyCopilotResponsesRequestPolicies } from "./responses-image-tools.mjs";
export { removeNativeImageTools as applyCopilotResponsesRequestPolicies, isNativeImageTool as isCopilotImageNamespaceTool } from "./responses-image-tools.mjs";

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function stripUnsupportedGpt6ServiceTier(body, requestedModel, upstreamModel, priorityTierModel) {
  if (requestedModel.startsWith("gpt-6-")
    && upstreamModel === requestedModel
    && !priorityTierModel
    && body.service_tier === "priority") {
    delete body.service_tier;
  }
}

export function isConnectionOwnedInputError(statusCode, text) {
  if (statusCode !== 400 || !text) return false;
  try {
    const error = JSON.parse(text)?.error;
    return typeof error?.message === "string"
      && error.message.trim().toLowerCase() === "input item does not belong to this connection";
  } catch { return false; }
}

export function isEncryptedContentVerificationError(statusCode, text) {
  if (statusCode < 400 || !text) return false;
  const lower = errorEvidenceText(text).toLowerCase();
  const reasoningFailure = lower.includes("encrypted content")
    && lower.includes("could not be verified")
    && (lower.includes("could not be decrypted") || lower.includes("could not be parsed"));
  const functionOutputFailure = lower.includes("encrypted function output content")
    && lower.includes("could not be decrypted or decoded");
  const missingEncryptedContent = statusCode < 500
    && /missing required parameter:\s*(['"]?)input\[\d+\](?:\.[a-z0-9_]+|\[\d+\])*\.encrypted_content\1(?=\.?(?:\s|$|["},\]]))/.test(lower);
  return reasoningFailure || functionOutputFailure || missingEncryptedContent || isConnectionOwnedInputError(statusCode, text);
}

export function isImageNamespaceCollisionError(statusCode, text) {
  if (statusCode < 400 || !text) return false;
  const lower = errorEvidenceText(text).toLowerCase();
  return lower.includes("namespace")
    && lower.includes("image_gen")
    && lower.includes("collid");
}

export function sanitizeImageNamespaceCollisionRequest(reqContext) {
  if (!Array.isArray(reqContext?.body?.tools)) return null;
  const body = cloneJson(reqContext.body);
  if (!applyCopilotResponsesRequestPolicies(body, { collisionFallback: true })) return null;
  return { ...reqContext, body };
}
