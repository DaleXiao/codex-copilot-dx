import { prepareResponsesPayload } from "./image-optimization.mjs";
import {
  enforceResponsesPayloadByteBudget,
  trimResponsesHistoryToByteBudget,
} from "./responses-byte-budget.mjs";
import { responsesToChat } from "./responses-bridge.mjs";
import { readResponsesImagePart, readResponsesToolOutputParts } from "./responses-content.mjs";

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

function jsonPayload(value) {
  const bodyText = JSON.stringify(value);
  return { bodyText, bodyBytes: Buffer.byteLength(bodyText) };
}

function chatRequest(responsesBody, stream) {
  const chatReq = responsesToChat(responsesBody);
  chatReq.stream = Boolean(stream);
  delete chatReq.max_tokens;
  return chatReq;
}

function adjustedResponsesTarget(limit, responsesBytes, chatBytes) {
  return Math.max(1, limit - (chatBytes - responsesBytes));
}

function partsHaveInlineImage(parts) {
  return Array.isArray(parts) && parts.some((part) => Boolean(readResponsesImagePart(part)?.identity));
}

function bodyHasInlineImage(body) {
  if (!Array.isArray(body?.input)) return false;
  for (const item of body.input) {
    if (readResponsesImagePart(item)?.identity) return true;
    if (item?.type === "message" && partsHaveInlineImage(item.content)) return true;
    const toolOutput = readResponsesToolOutputParts(item);
    if (toolOutput && partsHaveInlineImage(toolOutput.parts)) return true;
  }
  return false;
}

function checkedChatPayload(chatReq, payload, limit, stage, adapted) {
  enforceResponsesPayloadByteBudget(chatReq, {
    ...payload,
    adapted,
    currentInputStart: 0,
    overBudget: payload.bodyBytes > limit,
    stage: stage === "chat" ? stage : `${stage}+chat`,
    targetBytes: limit,
  });
  return { chatReq, ...payload, adapted, stage };
}

export async function prepareResponsesChatPayload(reqContext, {
  payloadOptions = {},
  signal,
  stream = false,
} = {}) {
  const limit = configuredBodyLimit(payloadOptions);
  let finalChatReq = chatRequest(reqContext.body, stream);
  let finalChat = jsonPayload(finalChatReq);
  const hasInlineImage = bodyHasInlineImage(reqContext.body);
  if (!hasInlineImage && (finalChat.bodyBytes <= limit || !(reqContext.currentInputStart > 0))) {
    return checkedChatPayload(finalChatReq, finalChat, limit, "chat", false);
  }

  let responsesPayload = jsonPayload(reqContext.body);
  let adapted = false;
  let stage = "chat";
  if (hasInlineImage) {
    const prepared = await prepareResponsesPayload(reqContext.body, {
      ...payloadOptions,
      currentInputStart: reqContext.currentInputStart,
      maxBytes: adjustedResponsesTarget(limit, responsesPayload.bodyBytes, finalChat.bodyBytes),
      signal,
    });
    responsesPayload = { bodyText: prepared.bodyText, bodyBytes: prepared.bodyBytes };
    adapted = prepared.adapted;
    stage = prepared.stage;
    finalChatReq = chatRequest(reqContext.body, stream);
    finalChat = jsonPayload(finalChatReq);
  }

  while (finalChat.bodyBytes > limit) {
    if (!(reqContext.currentInputStart > 0)) break;
    const targetBytes = adjustedResponsesTarget(
      limit,
      responsesPayload.bodyBytes,
      finalChat.bodyBytes,
    );
    const bodyBeforeTrim = structuredClone(reqContext.body);
    const responsesBeforeTrim = responsesPayload;
    const trimmed = trimResponsesHistoryToByteBudget(reqContext.body, {
      currentInputStart: reqContext.currentInputStart,
      targetBytes,
      initialBodyText: responsesPayload.bodyText,
      initialBodyBytes: responsesPayload.bodyBytes,
    });
    if (!trimmed.adapted) break;
    const candidateChatReq = chatRequest(reqContext.body, stream);
    const candidateChat = jsonPayload(candidateChatReq);
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

  return checkedChatPayload(finalChatReq, finalChat, limit, stage, adapted);
}
