import { randomUUID } from "node:crypto";
import { httpError } from "./http-transport.mjs";

const COMPACTION_TRIGGER_TYPE = "compaction_trigger";
const RETAINED_MESSAGE_ROLES = new Set(["user", "assistant", "developer", "system"]);
const RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;
const APPROX_BYTES_PER_TOKEN = 4;

function compactionError(message) {
  const error = httpError(message, 502);
  error.code = "ccdx_invalid_compaction_response";
  error.jsonBody = {
    error: {
      message,
      type: "upstream_error",
      code: error.code,
    },
  };
  return error;
}

function normalizeMessageContent(content) {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((part) => {
    if (!part || typeof part !== "object") return part;
    return part.type === "output_text"
      ? { ...part, type: "input_text" }
      : structuredClone(part);
  });
}

function approximateTextTokens(content) {
  return content.reduce((total, part) => {
    if (part?.type !== "input_text" || typeof part.text !== "string") return total;
    return total + Math.ceil(Buffer.byteLength(part.text) / APPROX_BYTES_PER_TOKEN);
  }, 0);
}

function retainedMessages(inputItems) {
  const kept = [];
  let usedTokens = 0;
  for (let index = inputItems.length - 1; index >= 0; index -= 1) {
    const item = inputItems[index];
    if (item?.type !== "message" || !RETAINED_MESSAGE_ROLES.has(item.role)) continue;

    const content = normalizeMessageContent(item.content);
    usedTokens += Math.max(approximateTextTokens(content), 1);
    if (usedTokens > RETAINED_MESSAGE_TOKEN_BUDGET && kept.length > 0) break;

    kept.push({
      type: "message",
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      status: item.status ?? "completed",
      role: item.role,
      content,
      ...(item.phase !== undefined ? { phase: structuredClone(item.phase) } : {}),
    });
  }
  return kept.reverse();
}

export function prepareResponsesCompactionRequest(reqContext) {
  const input = Array.isArray(reqContext?.body?.input) ? reqContext.body.input : [];
  const compactionInputItems = compactionInputWithoutTrigger(input);
  reqContext.body.input = [...compactionInputItems, { type: COMPACTION_TRIGGER_TYPE }];
  reqContext.body.stream = false;
  return reqContext;
}

export function compactionInputWithoutTrigger(input) {
  return Array.isArray(input)
    ? input.filter((item) => item?.type !== COMPACTION_TRIGGER_TYPE)
    : [];
}

export function createResponsesCompactionResult(inputItems, generated) {
  if (!generated || typeof generated !== "object" || !generated.id || !Array.isArray(generated.output)) {
    throw compactionError("Copilot compaction returned an invalid response envelope");
  }
  if (Object.prototype.hasOwnProperty.call(generated, "status") && generated.status !== "completed") {
    throw compactionError(`Copilot compaction returned status ${generated.status}`);
  }

  const compactionItems = generated.output.filter((item) => item?.type === "compaction");
  if (!compactionItems.length) {
    throw compactionError("Copilot compaction returned no compaction output item");
  }
  if (compactionItems.some((item) => (
    typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0
  ))) {
    throw compactionError("Copilot compaction returned an invalid compaction output item");
  }

  return {
    ...generated,
    object: "response.compaction",
    output: [
      ...retainedMessages(Array.isArray(inputItems) ? inputItems : []),
      ...compactionItems,
    ],
  };
}

export function parseResponsesCompactionResult(inputItems, text) {
  let generated;
  try {
    generated = JSON.parse(text);
  } catch {
    throw compactionError("Copilot compaction returned invalid JSON");
  }
  return createResponsesCompactionResult(inputItems, generated);
}
