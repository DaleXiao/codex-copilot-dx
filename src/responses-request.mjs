import { applyCopilotResponsesRequestPolicies } from "./copilot-responses-policy.mjs";
import { debugLog } from "./log.mjs";
import {
  materializeResponseHistory,
  rememberResponseHistoryNode,
  responseHistoryRootId,
} from "./response-history.mjs";
import { isResponsesToolOutputItem, readResponsesToolOutputParts } from "./responses-content.mjs";
import { enforceResponsesImageLimit } from "./responses-image-limit.mjs";
import { routePlanAffinity, sameRoutePlanAffinity } from "./route-plan.mjs";

export {
  isEncryptedContentVerificationError,
  isImageNamespaceCollisionError,
  sanitizeImageNamespaceCollisionRequest,
} from "./copilot-responses-policy.mjs";

// Compatibility export for consumers that imported this helper before the
// Copilot retry boundary moved into its provider-owned module.
export async function openCopilotResponse(...args) {
  const compatibility = await import("./copilot-responses-compat.mjs");
  return compatibility.openCopilotResponse(...args);
}

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function responsesInputItems(input, { assertActive, clone = true } = {}) {
  if (input === undefined || input === null) return [];
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  }
  if (Array.isArray(input)) {
    assertActive?.();
    const items = clone ? cloneJson(input) : input;
    assertActive?.();
    return items;
  }
  assertActive?.();
  const item = clone ? cloneJson(input) : input;
  assertActive?.();
  return [item];
}

export function stripInternalResponsesInputFields(inputItems, { assertActive } = {}) {
  if (!Array.isArray(inputItems)) return inputItems;
  for (let index = 0; index < inputItems.length; index += 1) {
    if ((index & 63) === 0) assertActive?.();
    const item = inputItems[index];
    if (!item || typeof item !== "object") continue;
    for (const key of Object.keys(item)) {
      if (key.startsWith("internal_")) delete item[key];
    }
  }
  return inputItems;
}

function responsesOutputItems(output) {
  if (!Array.isArray(output)) return [];
  return output.filter((item) => item && typeof item === "object");
}

function isCompactedResponsesOutput(output) {
  return Array.isArray(output) && output.some((item) => item?.type === "compaction");
}

function isSuccessfulCompactionResponse(response) {
  if (!isCompactedResponsesOutput(response?.output)) return false;
  if (Object.prototype.hasOwnProperty.call(response, "status") && response.status !== "completed") {
    return false;
  }
  return response.object === "response.compaction" || response.status === "completed";
}

function replayableResponsesOutputItems(output) {
  return responsesOutputItems(output);
}

function isEncryptedContentPart(value) {
  return value && typeof value === "object" && value.type === "encrypted_content";
}

const OMIT_ENCRYPTED_CONTENT = Symbol("omit-encrypted-content");
const ENCRYPTED_HISTORY_REBASE = Symbol("encrypted-history-rebase");
const RELEASE_HISTORY_INPUT = Symbol("release-history-input");
const HISTORY_PRESSURE_ROOT = Symbol("history-pressure-root");
const ENCRYPTED_TOOL_OUTPUT_MARKER = "[CCDX: encrypted tool output omitted because upstream could not decrypt it.]";

function stripEncryptedReasoningValue(value, state) {
  if (isEncryptedContentPart(value)) {
    state.changed = true;
    return OMIT_ENCRYPTED_CONTENT;
  }

  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      const stripped = stripEncryptedReasoningValue(item, state);
      if (stripped !== OMIT_ENCRYPTED_CONTENT) out.push(stripped);
    }
    return out;
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "encrypted_content") {
      state.changed = true;
      return OMIT_ENCRYPTED_CONTENT;
    }
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "encrypted_content") {
        state.changed = true;
        continue;
      }
      const stripped = stripEncryptedReasoningValue(child, state);
      if (stripped !== OMIT_ENCRYPTED_CONTENT) out[key] = stripped;
    }
    return out;
  }

  return value;
}

function stripEncryptedReasoningInputValue(item, state) {
  if (!isResponsesToolOutputItem(item)) {
    const out = stripEncryptedReasoningValue(item, state);
    if (item?.type === "message"
      && Array.isArray(item.content)
      && item.content.length > 0
      && Array.isArray(out?.content)
      && out.content.length === 0) {
      return OMIT_ENCRYPTED_CONTENT;
    }
    return out;
  }
  const hasOutput = Object.prototype.hasOwnProperty.call(item, "output");
  const withoutOutput = { ...item };
  delete withoutOutput.output;
  const out = stripEncryptedReasoningValue(withoutOutput, state);
  if (!hasOutput) return out;
  if (isEncryptedContentPart(item.output)) {
    state.changed = true;
    out.output = ENCRYPTED_TOOL_OUTPUT_MARKER;
    return out;
  }
  out.output = typeof item.output === "string" ? item.output : cloneJson(item.output);
  if (typeof item.output === "string" && !item.output.includes("encrypted_content")) return out;
  const parsed = readResponsesToolOutputParts(out);
  if (parsed) {
    const outputState = { changed: false };
    const parts = stripEncryptedReasoningValue(parsed.parts, outputState);
    if (!outputState.changed) return out;
    state.changed = true;
    if (!parts.length) {
      out.output = ENCRYPTED_TOOL_OUTPUT_MARKER;
      return out;
    }
    parsed.parts.splice(0, parsed.parts.length, ...parts);
    parsed.commit?.();
    return out;
  }
  const output = stripEncryptedReasoningValue(out.output, state);
  out.output = output === OMIT_ENCRYPTED_CONTENT ? ENCRYPTED_TOOL_OUTPUT_MARKER : output;
  return out;
}

function isEncryptedReasoningInputItem(item) {
  if (!item || typeof item !== "object") return false;
  if (["reasoning", "encrypted_content", "compaction"].includes(item.type)) return true;
  const keys = Object.keys(item);
  return keys.length === 1 && keys[0] === "encrypted_content";
}

function responseValueHasOpaqueState(value) {
  if (Array.isArray(value)) return value.some(responseValueHasOpaqueState);
  if (!value || typeof value !== "object") return false;
  if (isEncryptedReasoningInputItem(value)
    || Object.prototype.hasOwnProperty.call(value, "encrypted_content")) {
    return true;
  }
  if (isResponsesToolOutputItem(value) && typeof value.output === "string") {
    const parsed = readResponsesToolOutputParts(value);
    if (parsed?.parts.some(responseValueHasOpaqueState)) return true;
  }
  return Object.values(value).some(responseValueHasOpaqueState);
}

export function sanitizeEncryptedReasoningRequest(reqContext, { historicalOnly = false } = {}) {
  const state = { changed: false };
  let body = cloneJson(reqContext.body);
  let currentInputStart = reqContext.currentInputStart;
  let historicalInputChanged = false;
  if (Array.isArray(body.input)) {
    const input = [];
    let retainedBeforeCurrent = 0;
    for (let index = 0; index < body.input.length; index += 1) {
      const item = body.input[index];
      const historical = Number.isFinite(currentInputStart) && index < currentInputStart;
      if (historicalOnly && !historical) {
        input.push(item);
        continue;
      }
      if (isEncryptedReasoningInputItem(item)) {
        state.changed = true;
        if (historical) historicalInputChanged = true;
        continue;
      }
      const itemState = { changed: false };
      const stripped = stripEncryptedReasoningInputValue(item, itemState);
      if (stripped !== OMIT_ENCRYPTED_CONTENT) input.push(stripped);
      if (itemState.changed) {
        state.changed = true;
        if (historical) historicalInputChanged = true;
      }
      if (stripped !== OMIT_ENCRYPTED_CONTENT
        && Number.isFinite(currentInputStart)
        && index < currentInputStart) retainedBeforeCurrent += 1;
    }
    body.input = input;
    if (Number.isFinite(currentInputStart)) currentInputStart = retainedBeforeCurrent;
  } else if (!historicalOnly) {
    body = stripEncryptedReasoningValue(body, state);
  }
  if (!state.changed) return null;
  const historyInputItems = historicalOnly
    ? reqContext.historyInputItems
    : Array.isArray(reqContext.historyInputItems)
    ? reqContext.historyInputItems.flatMap((item) => {
      if (isEncryptedReasoningInputItem(item)) return [];
      const stripped = stripEncryptedReasoningInputValue(item, { changed: false });
      return stripped === OMIT_ENCRYPTED_CONTENT ? [] : [stripped];
    })
    : reqContext.historyInputItems;
  const shouldRebaseHistory = historicalInputChanged
    && Number.isFinite(reqContext.currentInputStart)
    && reqContext.historyParentId !== undefined
    && reqContext.historyParentId !== null;
  return {
    ...reqContext,
    ...(shouldRebaseHistory ? { [ENCRYPTED_HISTORY_REBASE]: true } : {}),
    body,
    currentInputStart,
    inputItems: Array.isArray(body.input) ? body.input : reqContext.inputItems,
    historyInputItems,
    [RELEASE_HISTORY_INPUT]: historicalOnly
      ? reqContext[RELEASE_HISTORY_INPUT]
      : historyInputItems,
  };
}

export function finalizeEncryptedHistoryRebase(reqContext) {
  if (!reqContext[ENCRYPTED_HISTORY_REBASE]) return reqContext;
  const finalized = {
    ...reqContext,
    historyParentId: null,
    historyRootId: null,
    historyInputItems: reqContext.body.input,
    inputItems: reqContext.body.input,
  };
  delete finalized[ENCRYPTED_HISTORY_REBASE];
  return finalized;
}

export function applyResponseHistoryRoutePlan(reqContext, routePlan) {
  const next = reqContext;
  next.routePlan = routePlan;
  if (!next.historyParentId) return next;
  const currentAffinity = routePlanAffinity(routePlan);
  const historyMetadata = next.historyRouteMetadata;
  if (!currentAffinity
    || !Array.isArray(historyMetadata)
    || historyMetadata.length === 0
    || historyMetadata.some((metadata) => metadata.affinity === null)) {
    return next;
  }
  const hasMismatchedOpaqueState = historyMetadata.some((metadata) => (
    metadata.hasOpaque && !sameRoutePlanAffinity(metadata.affinity, currentAffinity)
  ));
  if (!hasMismatchedOpaqueState) {
    return next;
  }

  const sanitized = sanitizeEncryptedReasoningRequest(next, { historicalOnly: true });
  if (!sanitized) return next;
  sanitized.routePlan = routePlan;
  const historyRootId = next.historyRootId;
  const rebased = finalizeEncryptedHistoryRebase(sanitized);
  if (historyRootId) rebased[HISTORY_PRESSURE_ROOT] = historyRootId;
  return rebased;
}

export function responseHistoryPressureRootId(reqContext) {
  return reqContext?.[HISTORY_PRESSURE_ROOT] || reqContext?.historyRootId || null;
}

export function prepareResponsesRequest(reqBody, {
  assertActive,
  copilotBoundary = true,
  mutate = false,
} = {}) {
  assertActive?.();
  const body = mutate ? reqBody : cloneJson(reqBody);
  assertActive?.();
  const currentInputItems = responsesInputItems(body.input, { assertActive, clone: !mutate });
  const currentInputRefs = new Set(
    currentInputItems.filter((item) => item && typeof item === "object"),
  );
  const previousId = body.previous_response_id;
  let historyItems = [];
  let historyRootId = null;
  const historyRouteMetadata = [];

  if (previousId !== undefined && previousId !== null) {
    historyItems = materializeResponseHistory(previousId, {
      assertActive,
      routeMetadata: historyRouteMetadata,
    });
    historyRootId = responseHistoryRootId(previousId);
    body.input = [...historyItems, ...currentInputItems];
  } else {
    body.input = currentInputItems;
  }

  let historyInputItems = currentInputItems;
  const imageLimit = enforceResponsesImageLimit(body.input, {
    assertActive,
    currentInputStart: historyItems.length,
    beforeMutate: ({ currentOmitted }) => {
      if (currentOmitted > 0) historyInputItems = cloneJson(currentInputItems);
    },
  });
  if (imageLimit.omitted > 0) {
    debugLog(`responses image window total=${imageLimit.total} kept=${imageLimit.kept} omitted=${imageLimit.omitted} duplicates=${imageLimit.duplicates} historical=${imageLimit.historicalOmitted} current=${imageLimit.currentOmitted}`);
  }

  delete body.previous_response_id;
  delete body.store;
  // Preserve the historical helper contract for embedders. Runtime handlers
  // pass copilotBoundary:false and apply the policy only after selecting a
  // concrete Copilot RoutePlan.
  if (copilotBoundary) applyCopilotResponsesRequestPolicies(body);
  stripInternalResponsesInputFields(body.input, { assertActive });
  stripInternalResponsesInputFields(historyInputItems, { assertActive });
  assertActive?.();
  const retainedCurrentInputStart = body.input.findIndex((item) => currentInputRefs.has(item));

  return {
    body,
    inputItems: body.input,
    currentInputStart: retainedCurrentInputStart < 0 ? body.input.length : retainedCurrentInputStart,
    historyParentId: previousId ?? null,
    historyRootId,
    historyRouteMetadata,
    historyInputItems,
    ...(previousId !== undefined && previousId !== null
      ? { [RELEASE_HISTORY_INPUT]: historyInputItems }
      : {}),
    takeHistoryOwnership: mutate,
  };
}

export function dropMaterializedResponseHistory(reqContext) {
  const releaseInput = reqContext?.[RELEASE_HISTORY_INPUT];
  if (!Array.isArray(releaseInput)) return false;
  reqContext.body = { ...reqContext.body, input: releaseInput };
  reqContext.inputItems = releaseInput;
  delete reqContext[RELEASE_HISTORY_INPUT];
  reqContext.currentInputStart = 0;
  return true;
}

export function rememberResponseHistory(reqContext, responseJson) {
  if (!responseJson?.id || !Array.isArray(reqContext?.historyInputItems || reqContext?.inputItems)) return;
  const compacted = isSuccessfulCompactionResponse(responseJson);
  const sourceInputItems = compacted ? [] : reqContext.historyInputItems || reqContext.inputItems;
  const sourceOutputItems = compacted
    ? replayableResponsesOutputItems(responseJson.output)
    : responsesOutputItems(responseJson.output);
  rememberResponseHistoryNode({
    id: responseJson.id,
    parentId: compacted ? null : reqContext.historyParentId,
    inputItems: sourceInputItems,
    outputItems: sourceOutputItems,
    hasOpaque: responseValueHasOpaqueState([sourceInputItems, sourceOutputItems]),
    routeAffinity: routePlanAffinity(reqContext.routePlan),
    takeOwnership: reqContext.takeHistoryOwnership,
  });
}
