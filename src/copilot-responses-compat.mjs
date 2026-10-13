import { responses as copilotResponses } from "./copilot.mjs";
import {
  isEncryptedContentVerificationError,
  isConnectionOwnedInputError,
  isImageNamespaceCollisionError,
  sanitizeImageNamespaceCollisionRequest,
} from "./copilot-responses-policy.mjs";
import {
  MAX_UPSTREAM_ERROR_BODY_BYTES,
  readBoundedResponseText,
} from "./http-transport.mjs";
import { httpError } from "./http-errors.mjs";
import {
  finalizeEncryptedHistoryRebase,
  sanitizeEncryptedReasoningRequest,
  sanitizeConnectionOwnedReasoningRequest,
} from "./responses-request.mjs";
import { responseFailureDetails } from "./response-failures.mjs";
import { status } from "./status.mjs";
import { markUpstreamHeaders } from "./stream-performance.mjs";

// Ordered Copilot-only fallbacks. Each policy is single-use and must be gated
// by an exact upstream failure plus a request transformation that changes the
// payload. Generic Responses preparation does not decide whether to retry.
const RETRY_POLICIES = Object.freeze([
  Object.freeze({
    id: "encrypted-connection-rejected",
    matches: isConnectionOwnedInputError,
    apply: sanitizeConnectionOwnedReasoningRequest,
    warning: "saved reasoning belongs to an unavailable connection; retrying once with visible history preserved",
  }),
  Object.freeze({
    id: "image-namespace-collision",
    matches: isImageNamespaceCollisionError,
    apply: sanitizeImageNamespaceCollisionRequest,
    warning: "image_gen namespace rejected by upstream; retrying without the conflicting image tool",
  }),
  Object.freeze({
    id: "encrypted-replay-rejected",
    matches: (statusCode, text) => !isConnectionOwnedInputError(statusCode, text) && isEncryptedContentVerificationError(statusCode, text),
    apply: sanitizeEncryptedReasoningRequest,
    warning: "encrypted replay content rejected by upstream; retrying without unavailable encrypted content",
  }),
]);

export function hasCopilotResponseRetryPolicy(statusCode, errorText, usedPolicies = new Set()) {
  return RETRY_POLICIES.some((policy) => !usedPolicies.has(policy.id) && policy.matches(statusCode, errorText));
}

export function selectCopilotResponseRetry(
  reqContext,
  statusCode,
  errorText,
  usedPolicies = new Set(),
) {
  for (const policy of RETRY_POLICIES) {
    if (usedPolicies.has(policy.id) || !policy.matches(statusCode, errorText)) continue;
    const candidate = policy.apply(reqContext);
    if (!candidate) continue;
    usedPolicies.add(policy.id);
    return {
      reqContext: candidate,
      policyId: policy.id,
      warning: policy.warning,
      usedPolicies,
      ...(policy.id === "encrypted-connection-rejected" ? { recovery: {
        reasoning_items_removed: reqContext.body.input.length - candidate.body.input.length,
        compaction_items_removed: 0,
      } } : {}),
    };
  }
  return null;
}

// Preserve the synchronous selector contract; disk recovery is an explicitly
// injected, asynchronous capability at the HTTP boundary, never a blanket retry.
export async function selectCopilotResponseRetryWithHistory(reqContext, statusCode, errorText, usedPolicies = new Set(), options = {}) {
  try { return selectCopilotResponseRetry(reqContext, statusCode, errorText, usedPolicies); }
  catch (error) {
    if (error.code !== "ccdx_history_rebuild_required" || !options.restorePlaintextHistory) throw error;
    let restored;
    try { restored = await options.restorePlaintextHistory(reqContext, { reserveHistory: options.reserveHistory }); }
    catch (failure) {
      options.assertPrepareActive?.();
      if (options.signal?.aborted) throw options.signal.reason || failure;
      const reason = /^[a-z][a-z_]{1,60}$/.test(failure.code || "") ? failure.code : "local_history_unavailable";
      error.jsonBody.error.recovery.local_status = reason;
      throw error;
    }
    usedPolicies.add("encrypted-connection-rejected");
    return { ...restored, policyId: "encrypted-connection-rejected", usedPolicies,
      warning: "saved compaction rejected; retrying once with verified complete local plaintext history" };
  }
}

export async function openCopilotResponse(reqContext, upstream = copilotResponses, options = {}) {
  const usedPolicies = options.usedRetryPolicies || new Set();
  let payloadPrepared = false;
  let releaseRecovery;
  try {
    for (let attempt = 0; attempt <= RETRY_POLICIES.length; attempt += 1) {
      let resp;
      try {
        options.assertPrepareActive?.();
        resp = await upstream(reqContext.body, {
          assertActive: options.assertPrepareActive,
          signal: options.signal,
          currentInputStart: reqContext.currentInputStart,
          onUpstreamStart: options.onUpstreamStart,
          payloadPrepared,
        });
      } finally { releaseRecovery?.();releaseRecovery = null; }
      markUpstreamHeaders();
      options.assertPrepareActive?.();
      payloadPrepared = true;
      if (resp.ok) {
        reqContext = finalizeEncryptedHistoryRebase(reqContext);
        return { resp, reqContext, usedRetryPolicies: usedPolicies };
      }

      const errorText = await readBoundedResponseText(resp, {
        maxBytes: MAX_UPSTREAM_ERROR_BODY_BYTES,
        label: "Copilot Responses error body",
      });
      options.assertPrepareActive?.();
      let retry;
      try { retry = await selectCopilotResponseRetryWithHistory(reqContext, resp.status, errorText, usedPolicies, options); }
      catch (error) {
        if (error.code === "ccdx_history_rebuild_required") {
          const details = responseFailureDetails({ error: error.jsonBody.error }, "upstream.http_error", {
            model: reqContext.body.model, headers: resp.headers, retrySkipped: error.code });
          error.jsonBody.error.upstream_request_id = details.upstream_request_id;
          options.responseFailures?.record?.({ ...details, recovery: error.jsonBody.error.recovery });
        }
        throw error;
      }
      releaseRecovery = retry?.releasePreparation;
      if (retry?.policyId === "encrypted-connection-rejected") {
        options.responseFailures?.record?.({ ...responseFailureDetails(JSON.parse(errorText), "upstream.http_error", {
          model: reqContext.body.model, headers: resp.headers, retried: true, retryPolicy: retry.policyId }),
          recovery: retry.recovery });
      }
      if (retry) {
        reqContext = retry.reqContext;
        if (retry.recovery?.source === "local_codex_rollout") payloadPrepared = false;
        console.warn(status("warn", retry.warning));
        continue;
      }
      return { resp, reqContext, errorText, usedRetryPolicies: usedPolicies };
    }
    throw httpError("Responses compatibility retry limit exceeded", 502);
  } finally { releaseRecovery?.(); }
}
