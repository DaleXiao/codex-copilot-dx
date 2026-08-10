import { prepareResponsesPayload } from "./image-optimization.mjs";
import {
  enforceResponsesPayloadByteBudget,
  trimResponsesHistoryToByteBudget,
} from "./responses-byte-budget.mjs";
import { responsesToChat } from "./responses-bridge.mjs";
import { readResponsesImagePart, readResponsesToolOutputParts } from "./responses-content.mjs";
import { withChatStreamUsage } from "./stream-contract.mjs";

const DEFAULT_MAX_UPSTREAM_BODY_BYTES = 30 * 1024 * 1024;

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, Number.MAX_SAFE_INTEGER) : fallback;
}

function configuredBodyLimit(payloadOptions) {
  const environmentLimit = positiveInt(
    process.env.CCDX_MAX_UPSTREAM_BODY_BYTES,
    DEFAULT_MAX_UPSTREAM_BODY_BYTES,
  );
  return positiveInt(payloadOptions?.maxBytes, environmentLimit);
}

function jsonPayload(value, assertActive) {
  assertActive?.();
  const bodyText = JSON.stringify(value);
  assertActive?.();
  return { bodyText, bodyBytes: Buffer.byteLength(bodyText) };
}

function chatRequest(responsesBody, stream) {
  const chatReq = responsesToChat(responsesBody);
  chatReq.stream = Boolean(stream);
  delete chatReq.max_tokens;
  return stream ? withChatStreamUsage(chatReq) : chatReq;
}

function adjustedResponsesTarget(limit, responsesBytes, chatBytes) {
  return Math.max(1, limit - (chatBytes - responsesBytes));
}

function partsHaveInlineImage(parts, assertActive) {
  if (!Array.isArray(parts)) return false;
  for (let index = 0; index < parts.length; index += 1) {
    if ((index & 63) === 0) assertActive?.();
    if (readResponsesImagePart(parts[index])?.identity) return true;
  }
  return false;
}

function bodyHasInlineImage(body, assertActive) {
  if (!Array.isArray(body?.input)) return false;
  for (let index = 0; index < body.input.length; index += 1) {
    if ((index & 63) === 0) assertActive?.();
    const item = body.input[index];
    if (readResponsesImagePart(item)?.identity) return true;
    if (item?.type === "message" && partsHaveInlineImage(item.content, assertActive)) return true;
    const toolOutput = readResponsesToolOutputParts(item);
    if (toolOutput && partsHaveInlineImage(toolOutput.parts, assertActive)) return true;
  }
  return false;
}

function checkedChatPayload(chatReq, payload, limit, stage, adapted, assertActive) {
  enforceResponsesPayloadByteBudget(chatReq, {
    ...payload,
    adapted,
    currentInputStart: 0,
    overBudget: payload.bodyBytes > limit,
    stage: stage === "chat" ? stage : `${stage}+chat`,
    targetBytes: limit,
  }, { assertActive });
  return { chatReq, ...payload, adapted, stage };
}

export async function prepareResponsesChatPayload(reqContext, {
  assertActive,
  payloadOptions = {},
  signal,
  stream = false,
} = {}) {
  assertActive?.();
  const limit = configuredBodyLimit(payloadOptions);
  let finalChatReq = chatRequest(reqContext.body, stream);
  assertActive?.();
  let finalChat = jsonPayload(finalChatReq, assertActive);
  const hasInlineImage = bodyHasInlineImage(reqContext.body, assertActive);
  if (!hasInlineImage && (finalChat.bodyBytes <= limit || !(reqContext.currentInputStart > 0))) {
    return checkedChatPayload(finalChatReq, finalChat, limit, "chat", false, assertActive);
  }

  let responsesPayload = jsonPayload(reqContext.body, assertActive);
  let adapted = false;
  let stage = "chat";
  if (hasInlineImage) {
    const prepared = await prepareResponsesPayload(reqContext.body, {
      ...payloadOptions,
      assertActive,
      currentInputStart: reqContext.currentInputStart,
      maxBytes: adjustedResponsesTarget(limit, responsesPayload.bodyBytes, finalChat.bodyBytes),
      signal,
    });
    responsesPayload = { bodyText: prepared.bodyText, bodyBytes: prepared.bodyBytes };
    adapted = prepared.adapted;
    stage = prepared.stage;
    finalChatReq = chatRequest(reqContext.body, stream);
    assertActive?.();
    finalChat = jsonPayload(finalChatReq, assertActive);
  }

  while (finalChat.bodyBytes > limit) {
    assertActive?.();
    if (!(reqContext.currentInputStart > 0)) break;
    const targetBytes = adjustedResponsesTarget(
      limit,
      responsesPayload.bodyBytes,
      finalChat.bodyBytes,
    );
    const bodyBeforeTrim = structuredClone(reqContext.body);
    assertActive?.();
    const responsesBeforeTrim = responsesPayload;
    const trimmed = trimResponsesHistoryToByteBudget(reqContext.body, {
      assertActive,
      currentInputStart: reqContext.currentInputStart,
      targetBytes,
      initialBodyText: responsesPayload.bodyText,
      initialBodyBytes: responsesPayload.bodyBytes,
    });
    if (!trimmed.adapted) break;
    const candidateChatReq = chatRequest(reqContext.body, stream);
    assertActive?.();
    const candidateChat = jsonPayload(candidateChatReq, assertActive);
    if (candidateChat.bodyBytes >= finalChat.bodyBytes) {
      reqContext.body = bodyBeforeTrim;
      responsesPayload = responsesBeforeTrim;
      break;
    }
    responsesPayload = trimmed;
    finalChatReq = candidateChatReq;
    finalChat = candidateChat;
    adapted = true;
    if (!stage.endsWith("+history")) stage += "+history";
  }

  assertActive?.();
  return checkedChatPayload(finalChatReq, finalChat, limit, stage, adapted, assertActive);
}
