import { responses as copilotResponses } from "./copilot.mjs";
import { httpError } from "./http-transport.mjs";
import { debugLog } from "./log.mjs";
import {
  materializeResponseHistory,
  rememberResponseHistoryNode,
  responseHistoryRootId,
} from "./response-history.mjs";
import { isResponsesToolOutputItem, readResponsesToolOutputParts } from "./responses-content.mjs";
import { enforceResponsesImageLimit } from "./responses-image-limit.mjs";
import { status } from "./status.mjs";

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

export function sanitizeEncryptedReasoningRequest(reqContext) {
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
  } else {
    body = stripEncryptedReasoningValue(body, state);
  }
  if (!state.changed) return null;
  const historyInputItems = Array.isArray(reqContext.historyInputItems)
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
  };
}

function finalizeEncryptedHistoryRebase(reqContext) {
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

export function isEncryptedContentVerificationError(statusCode, text) {
  if (statusCode < 400 || !text) return false;
  const lower = String(text).toLowerCase();
  const reasoningFailure = lower.includes("encrypted content")
    && lower.includes("could not be verified")
    && (lower.includes("could not be decrypted") || lower.includes("could not be parsed"));
  const functionOutputFailure = lower.includes("encrypted function output content")
    && lower.includes("could not be decrypted or decoded");
  const missingEncryptedContent = statusCode < 500
    && /missing required parameter:\s*(['"]?)input\[\d+\](?:\.[a-z0-9_]+|\[\d+\])*\.encrypted_content\1(?=\.?(?:\s|$|["},\]]))/.test(lower);
  return reasoningFailure || functionOutputFailure || missingEncryptedContent;
}

export function isImageNamespaceCollisionError(statusCode, text) {
  if (statusCode < 400 || !text) return false;
  const lower = String(text).toLowerCase();
  return lower.includes("namespace")
    && lower.includes("image_gen")
    && lower.includes("collid");
}

function isImageNamespaceTool(tool, { collisionFallback = false } = {}) {
  if (!tool || typeof tool !== "object") return false;
  const type = String(tool.type || "").toLowerCase();
  const name = String(tool.name || tool.function?.name || "").toLowerCase();
  const namespace = String(tool.namespace || "").toLowerCase();
  if (["image_gen", "image_generation"].includes(type)) return true;
  if (["image_gen", "image_generation"].includes(name)) return true;
  if (namespace === "image_gen" || namespace === "image_generation") return true;
  return collisionFallback && [type, name, namespace].some((value) => value.startsWith("image_gen"));
}

export function sanitizeImageNamespaceCollisionRequest(reqContext) {
  if (!Array.isArray(reqContext?.body?.tools)) return null;
  const body = cloneJson(reqContext.body);
  const filtered = body.tools.filter((tool) => !isImageNamespaceTool(tool, { collisionFallback: true }));
  if (filtered.length === body.tools.length) return null;
  if (filtered.length) body.tools = filtered;
  else delete body.tools;
  return { ...reqContext, body };
}

export async function openCopilotResponse(reqContext, upstream = copilotResponses, options = {}) {
  let encryptedRetried = false;
  let imageNamespaceRetried = false;
  let payloadPrepared = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
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

    const errorText = await resp.text();
    options.assertPrepareActive?.();
    if (!imageNamespaceRetried && isImageNamespaceCollisionError(resp.status, errorText)) {
      const retryContext = sanitizeImageNamespaceCollisionRequest(reqContext);
      if (retryContext) {
        imageNamespaceRetried = true;
        reqContext = retryContext;
        console.warn(status("warn", "image_gen namespace rejected by upstream; retrying without the conflicting image tool"));
        continue;
      }
    }
    if (!encryptedRetried && isEncryptedContentVerificationError(resp.status, errorText)) {
      const retryContext = sanitizeEncryptedReasoningRequest(reqContext);
      if (retryContext) {
        encryptedRetried = true;
        reqContext = retryContext;
        console.warn(status("warn", "encrypted replay content rejected by upstream; retrying without unavailable encrypted content"));
        continue;
      }
    }
    return { resp, reqContext, errorText };
  }
  throw httpError("Responses compatibility retry limit exceeded", 502);
}

function isBuiltinImageTool(tool) {
  return isImageNamespaceTool(tool);
}

export function prepareResponsesRequest(reqBody, { assertActive, mutate = false } = {}) {
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

  if (previousId !== undefined && previousId !== null) {
    historyItems = materializeResponseHistory(previousId, { assertActive });
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
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.filter((tool) => !isBuiltinImageTool(tool));
    if (!body.tools.length) delete body.tools;
  }
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
    historyInputItems,
    takeHistoryOwnership: mutate,
  };
}

export function dropMaterializedResponseHistory(reqContext) {
  if (!reqContext?.historyParentId || !Array.isArray(reqContext.historyInputItems)) return false;
  reqContext.body = { ...reqContext.body, input: reqContext.historyInputItems };
  reqContext.inputItems = reqContext.historyInputItems;
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
    takeOwnership: reqContext.takeHistoryOwnership,
  });
}
