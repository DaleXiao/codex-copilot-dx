import { responses as copilotResponses } from "./copilot.mjs";
import {
  isEncryptedContentVerificationError,
  isImageNamespaceCollisionError,
  sanitizeImageNamespaceCollisionRequest,
} from "./copilot-responses-policy.mjs";
import {
  httpError,
  MAX_UPSTREAM_ERROR_BODY_BYTES,
  readBoundedResponseText,
} from "./http-transport.mjs";
import {
  finalizeEncryptedHistoryRebase,
  sanitizeEncryptedReasoningRequest,
} from "./responses-request.mjs";
import { status } from "./status.mjs";

// Ordered Copilot-only fallbacks. Each policy is single-use and must be gated
// by an exact upstream failure plus a request transformation that changes the
// payload. Generic Responses preparation does not decide whether to retry.
const RETRY_POLICIES = Object.freeze([
  Object.freeze({
    id: "image-namespace-collision",
    matches: isImageNamespaceCollisionError,
    apply: sanitizeImageNamespaceCollisionRequest,
    warning: "image_gen namespace rejected by upstream; retrying without the conflicting image tool",
  }),
  Object.freeze({
    id: "encrypted-replay-rejected",
    matches: isEncryptedContentVerificationError,
    apply: sanitizeEncryptedReasoningRequest,
    warning: "encrypted replay content rejected by upstream; retrying without unavailable encrypted content",
  }),
]);

export async function openCopilotResponse(reqContext, upstream = copilotResponses, options = {}) {
  const usedPolicies = new Set();
  let payloadPrepared = false;
  for (let attempt = 0; attempt <= RETRY_POLICIES.length; attempt += 1) {
    options.assertPrepareActive?.();
    const resp = await upstream(reqContext.body, {
      assertActive: options.assertPrepareActive,
      signal: options.signal,
      currentInputStart: reqContext.currentInputStart,
      onUpstreamStart: options.onUpstreamStart,
      payloadPrepared,
    });
    options.assertPrepareActive?.();
    payloadPrepared = true;
    if (resp.ok) {
      reqContext = finalizeEncryptedHistoryRebase(reqContext);
      return { resp, reqContext };
    }

    const errorText = await readBoundedResponseText(resp, {
      maxBytes: MAX_UPSTREAM_ERROR_BODY_BYTES,
      label: "Copilot Responses error body",
    });
    options.assertPrepareActive?.();
    let retryPolicy = null;
    let retryContext = null;
    for (const policy of RETRY_POLICIES) {
      if (usedPolicies.has(policy.id) || !policy.matches(resp.status, errorText)) continue;
      const candidate = policy.apply(reqContext);
      if (candidate) {
        retryPolicy = policy;
        retryContext = candidate;
        break;
      }
    }
    if (retryPolicy && retryContext) {
      usedPolicies.add(retryPolicy.id);
      reqContext = retryContext;
      console.warn(status("warn", retryPolicy.warning));
      continue;
    }
    return { resp, reqContext, errorText };
  }
  throw httpError("Responses compatibility retry limit exceeded", 502);
}
