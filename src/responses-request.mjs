import { responses as copilotResponses } from "./copilot.mjs";
import { httpError } from "./http-transport.mjs";
import { materializeResponseHistory, rememberResponseHistoryNode } from "./response-history.mjs";
import { status } from "./status.mjs";

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function responsesInputItems(input, { clone = true } = {}) {
  if (input === undefined || input === null) return [];
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  }
  if (Array.isArray(input)) return clone ? cloneJson(input) : input;
  return [clone ? cloneJson(input) : input];
}

export function stripInternalResponsesInputFields(inputItems) {
  if (!Array.isArray(inputItems)) return inputItems;
  for (const item of inputItems) {
    if (!item || typeof item !== "object") continue;
    for (const key of Object.keys(item)) {
      if (key.startsWith("internal_")) delete item[key];
    }
  }
  return inputItems;
}

function responsesOutputItems(output) {
  if (!Array.isArray(output)) return [];
  return output.filter((item) => item?.type === "message" || item?.type === "function_call");
}

function stripEncryptedReasoningValue(value, state) {
  if (Array.isArray(value)) {
    return value.map((item) => stripEncryptedReasoningValue(item, state));
  }

  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "encrypted_content") {
        state.changed = true;
        continue;
      }
      out[key] = stripEncryptedReasoningValue(child, state);
    }
    return out;
  }

  return value;
}

function isEncryptedReasoningInputItem(item) {
  return item && typeof item === "object"
    && (item.type === "reasoning" || Object.prototype.hasOwnProperty.call(item, "encrypted_content"));
}

export function sanitizeEncryptedReasoningRequest(reqContext) {
  const state = { changed: false };
  let body = cloneJson(reqContext.body);
  if (Array.isArray(body.input)) {
    const input = [];
    for (const item of body.input) {
      if (isEncryptedReasoningInputItem(item)) {
        state.changed = true;
        continue;
      }
      input.push(stripEncryptedReasoningValue(item, state));
    }
    body.input = input;
  } else {
    body = stripEncryptedReasoningValue(body, state);
  }
  if (!state.changed) return null;
  const historyInputItems = Array.isArray(reqContext.historyInputItems)
    ? reqContext.historyInputItems
      .filter((item) => !isEncryptedReasoningInputItem(item))
      .map((item) => stripEncryptedReasoningValue(item, { changed: false }))
    : reqContext.historyInputItems;
  return {
    ...reqContext,
    body,
    inputItems: Array.isArray(body.input) ? body.input : reqContext.inputItems,
    historyInputItems,
  };
}

export function isEncryptedContentVerificationError(statusCode, text) {
  if (statusCode < 400 || !text) return false;
  const lower = String(text).toLowerCase();
  return lower.includes("encrypted content")
    && lower.includes("could not be verified")
    && (lower.includes("could not be decrypted") || lower.includes("could not be parsed"));
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resp = await upstream(reqContext.body, { signal: options.signal });
    if (resp.ok) return { resp, reqContext };

    const errorText = await resp.text();
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
        console.warn(status("warn", "encrypted reasoning rejected by upstream; retrying without encrypted reasoning"));
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

export function prepareResponsesRequest(reqBody, { mutate = false } = {}) {
  const body = mutate ? reqBody : cloneJson(reqBody);
  const currentInputItems = responsesInputItems(body.input, { clone: !mutate });
  const previousId = body.previous_response_id;

  if (previousId !== undefined && previousId !== null) {
    body.input = [...materializeResponseHistory(previousId), ...currentInputItems];
  } else {
    body.input = currentInputItems;
  }

  delete body.previous_response_id;
  delete body.store;
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.filter((tool) => !isBuiltinImageTool(tool));
    if (!body.tools.length) delete body.tools;
  }
  stripInternalResponsesInputFields(body.input);
  stripInternalResponsesInputFields(currentInputItems);

  return {
    body,
    inputItems: body.input,
    historyParentId: previousId ?? null,
    historyInputItems: currentInputItems,
    takeHistoryOwnership: mutate,
  };
}

export function rememberResponseHistory(reqContext, responseJson) {
  if (!responseJson?.id || !Array.isArray(reqContext?.historyInputItems || reqContext?.inputItems)) return;
  const sourceInputItems = reqContext.historyInputItems || reqContext.inputItems;
  const sourceOutputItems = responsesOutputItems(responseJson.output);
  rememberResponseHistoryNode({
    id: responseJson.id,
    parentId: reqContext.historyParentId,
    inputItems: sourceInputItems,
    outputItems: sourceOutputItems,
    takeOwnership: reqContext.takeHistoryOwnership,
  });
}
