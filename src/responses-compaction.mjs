import { httpError } from "./http-transport.mjs";

const COMPACTION_TRIGGER_TYPE = "compaction_trigger";

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

export function createResponsesCompactionResult(_inputItems, generated) {
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
