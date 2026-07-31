const DEFAULT_BLANK_TOOL_ARGUMENT_LIMIT = 20;

function streamProtocolError(message, code) {
  const error = new Error(message);
  error.statusCode = 502;
  error.code = code;
  error.jsonBody = {
    error: {
      message,
      type: "upstream_protocol_error",
      code,
    },
  };
  return error;
}

export function invalidUpstreamStream(message, code = "upstream_stream_invalid") {
  return streamProtocolError(message, code);
}

export function withChatStreamUsage(request) {
  const streamOptions = request?.stream_options && typeof request.stream_options === "object"
    ? request.stream_options
    : {};
  if (request?.stream === true && streamOptions.include_usage === true) return request;
  return {
    ...request,
    stream: true,
    stream_options: { ...streamOptions, include_usage: true },
  };
}

export async function requireUpstreamEventStream(response) {
  let error = null;
  if (!response?.body) {
    error = streamProtocolError(
      "Upstream returned a successful streaming response without a body",
      "upstream_stream_body_missing",
    );
  } else {
    const contentType = response.headers?.get?.("content-type") || "";
    const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "text/event-stream") {
      error = streamProtocolError(
        "Upstream returned a successful streaming response with a non-SSE Content-Type",
        "upstream_stream_content_type_invalid",
      );
    }
  }

  if (!error) return;
  await response?.body?.cancel?.().catch(() => {});
  throw error;
}

export function incompleteUpstreamStream(expectedTerminator) {
  return streamProtocolError(
    `Upstream stream ended before ${expectedTerminator}`,
    "upstream_stream_incomplete",
  );
}

export function upstreamChatStreamError(event) {
  const payload = event?.error;
  if (!payload || typeof payload !== "object") return null;
  const type = typeof payload.type === "string" && payload.type ? `${payload.type}: ` : "";
  const message = typeof payload.message === "string" && payload.message
    ? payload.message.slice(0, 500)
    : "Upstream stream error";
  return streamProtocolError(
    `Upstream Chat Completions SSE error: ${type}${message}`,
    "upstream_chat_stream_error",
  );
}

export class ToolArgumentDeltaGuard {
  constructor(limit = DEFAULT_BLANK_TOOL_ARGUMENT_LIMIT) {
    this.limit = limit;
    this.whitespaceRuns = new Map();
  }

  observe(callIndex, delta) {
    if (typeof delta !== "string") return;
    const key = callIndex ?? "unknown";
    let count = this.whitespaceRuns.get(key) || 0;
    for (const character of delta) {
      if (character === "\r" || character === "\n" || character === "\t") {
        count += 1;
        if (count > this.limit) {
          this.whitespaceRuns.set(key, count);
          throw streamProtocolError(
            `Upstream sent more than ${this.limit} consecutive line-break or tab characters in tool arguments`,
            "upstream_tool_arguments_stalled",
          );
        }
      } else if (character !== " ") {
        count = 0;
      }
    }
    this.whitespaceRuns.set(key, count);
  }
}
