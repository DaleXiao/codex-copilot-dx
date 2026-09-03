import { responses as copilotResponses } from "./copilot.mjs";
import {
  httpError,
  logRequestFailure,
  MAX_UPSTREAM_ERROR_BODY_BYTES,
  MAX_UPSTREAM_RESPONSES_SUCCESS_BODY_BYTES,
  readBoundedResponseText,
  sendUpstreamError,
  writeOrDrain,
} from "./http-transport.mjs";
import { openCopilotResponse } from "./copilot-responses-compat.mjs";
import { rememberResponseHistory } from "./responses-request.mjs";
import {
  compactionInputWithoutTrigger,
  parseResponsesCompactionResult,
} from "./responses-compaction.mjs";
import { loadRuntimeConfig } from "./runtime-config.mjs";
import { endStreamWithError } from "./stream-errors.mjs";
import {
  incompleteUpstreamStream,
  invalidUpstreamStream,
  requireUpstreamEventStream,
  ToolArgumentDeltaGuard,
} from "./stream-contract.mjs";
import {
  isResponsesOutputEvent,
  markFirstOutput,
  markOutputTokens,
  markStreamFailure,
} from "./stream-performance.mjs";
import { safeUpstreamResponseHeaders } from "./upstream-headers.mjs";
import { recordResponsesUsage } from "./usage.mjs";

const MAX_SSE_BUFFER_BYTES = loadRuntimeConfig().maxSseBufferBytes;
const RESPONSES_TERMINAL_EVENT_TYPES = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
  "error",
]);

function inspectResponseSseEvent(state, eventName, data) {
  if (!data || state.sawTerminal) return;
  if (data === "[DONE]") {
    throw invalidUpstreamStream(
      "Upstream sent [DONE] before a terminal Responses event",
      "upstream_stream_terminal_missing",
    );
  }
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    throw invalidUpstreamStream(
      "Upstream Responses SSE event contained invalid JSON",
      "upstream_stream_json_invalid",
    );
  }
  const eventType = event.type || eventName;
  const outputTokens = event.response?.usage?.output_tokens ?? event.usage?.output_tokens;
  if (outputTokens !== undefined) markOutputTokens(outputTokens);
  if (!state.sawOutput && isResponsesOutputEvent(event, eventType)) {
    state.sawOutput = true;
    markFirstOutput();
  }
  if (["response.function_call_arguments.delta", "response.custom_tool_call_input.delta"].includes(eventType)) {
    state.toolArgumentGuard.observe(event.output_index ?? event.item_id ?? event.call_id, event.delta);
  }
  if (!RESPONSES_TERMINAL_EVENT_TYPES.has(eventType)) return;
  const expectedStatus = {
    "response.completed": "completed",
    "response.incomplete": "incomplete",
    "response.failed": "failed",
  }[eventType];
  if (expectedStatus && (!event.response?.id || event.response.status !== expectedStatus)) {
    throw invalidUpstreamStream(
      `Upstream ${eventType} event contained an invalid response resource`,
      "upstream_stream_terminal_invalid",
    );
  }
  state.sawTerminal = true;
  if (eventType === "response.failed" || eventType === "error") markStreamFailure();
  if (eventType !== "response.completed") return;
  const response = event.response;
  state.completed = { response, event };
}

function createResponseSseInspector(state) {
  let eventBuffer = Buffer.allocUnsafe(Math.min(4096, MAX_SSE_BUFFER_BYTES + 4));
  let eventLength = 0;
  let previous1 = -1;
  let previous2 = -1;
  let previous3 = -1;

  const ensureCapacity = (required) => {
    if (required > MAX_SSE_BUFFER_BYTES + 4) {
      throw httpError(`Upstream SSE buffer exceeds ${MAX_SSE_BUFFER_BYTES} bytes`, 502);
    }
    if (required <= eventBuffer.length) return;
    let capacity = eventBuffer.length;
    while (capacity < required) capacity = Math.min(MAX_SSE_BUFFER_BYTES + 4, Math.max(capacity * 2, required));
    const next = Buffer.allocUnsafe(capacity);
    eventBuffer.copy(next, 0, 0, eventLength);
    eventBuffer = next;
  };

  const append = (bytes) => {
    if (!bytes.byteLength) return;
    ensureCapacity(eventLength + bytes.byteLength);
    eventBuffer.set(bytes, eventLength);
    eventLength += bytes.byteLength;
  };

  const inspectEvent = (delimiterLength) => {
    const contentLength = eventLength - delimiterLength;
    if (contentLength > MAX_SSE_BUFFER_BYTES) {
      throw httpError(`Upstream SSE buffer exceeds ${MAX_SSE_BUFFER_BYTES} bytes`, 502);
    }
    const chunk = eventBuffer.subarray(0, contentLength).toString("utf8");
    const lines = chunk.split(/\r?\n/);
    const eventName = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) inspectResponseSseEvent(state, eventName, data);
    eventLength = 0;
    previous1 = -1;
    previous2 = -1;
    previous3 = -1;
  };

  return {
    push(value) {
      let segmentStart = 0;
      for (let index = 0; index < value.byteLength; index += 1) {
        const byte = value[index];
        let delimiterLength = 0;
        if (byte === 0x0a && previous1 === 0x0a) {
          delimiterLength = previous2 === 0x0d ? 3 : 2;
        } else if (byte === 0x0a && previous1 === 0x0d && previous2 === 0x0a) {
          delimiterLength = previous3 === 0x0d ? 4 : 3;
        }
        if (delimiterLength) {
          append(value.subarray(segmentStart, index + 1));
          inspectEvent(delimiterLength);
          segmentStart = index + 1;
          if (state.sawTerminal) return index + 1;
          continue;
        }
        previous3 = previous2;
        previous2 = previous1;
        previous1 = byte;
      }
      append(value.subarray(segmentStart));
      if (eventLength > MAX_SSE_BUFFER_BYTES + 3) {
        throw httpError(`Upstream SSE buffer exceeds ${MAX_SSE_BUFFER_BYTES} bytes`, 502);
      }
      return null;
    },
  };
}

function invalidResponsesResponse(message) {
  const error = httpError(message, 502);
  error.code = "ccdx_invalid_responses_response";
  error.jsonBody = {
    error: {
      message,
      type: "upstream_error",
      code: error.code,
    },
  };
  return error;
}

function parseSuccessfulResponsesResult(text) {
  let response;
  try {
    response = JSON.parse(text);
  } catch {
    throw invalidResponsesResponse("Copilot Responses returned invalid JSON");
  }
  if (!response
    || typeof response !== "object"
    || Array.isArray(response)
    || typeof response.id !== "string"
    || response.id.length === 0
    || !Array.isArray(response.output)) {
    throw invalidResponsesResponse("Copilot Responses returned an invalid response envelope");
  }
  return response;
}

function storeCompletedResponse(reqContext, completed) {
  if (!completed) return;
  rememberResponseHistory(reqContext, completed.response);
  recordResponsesUsage({
    surface: reqContext.surface,
    mode: "stream",
    model: reqContext.body?.model,
    response: completed.response,
    event: completed.event,
  });
}

export async function proxyCopilotResponses(reqContext, req, res, upstream = copilotResponses, options = {}) {
  let opened;
  try {
    opened = await openCopilotResponse(reqContext, upstream, options);
  } finally {
    options.releaseRequest?.(opened?.reqContext);
  }
  const { resp, errorText } = opened;
  reqContext = opened.reqContext;
  if (errorText !== undefined) {
    sendUpstreamError(res, resp, errorText);
    return { successful: false, compacted: false, upstreamStatus: resp.status };
  }

  if (reqContext.body.stream) {
    await requireUpstreamEventStream(resp);
    options.abort?.setTimeout(options.streamIdleTimeoutMs, "stream_idle_timeout");
    res.writeHead(resp.status, {
      ...safeUpstreamResponseHeaders(resp.headers, { defaultContentType: "text/event-stream" }),
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const reader = resp.body.getReader();
    const streamState = {
      completed: null,
      sawTerminal: false,
      sawOutput: false,
      toolArgumentGuard: new ToolArgumentDeltaGuard(),
    };
    const inspector = createResponseSseInspector(streamState);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (!streamState.sawTerminal) throw incompleteUpstreamStream("a terminal Responses event");
          storeCompletedResponse(reqContext, streamState.completed);
          res.end();
          return { successful: Boolean(streamState.completed), compacted: false };
        }
        options.abort?.setTimeout(options.streamIdleTimeoutMs, "stream_idle_timeout");
        const terminalOffset = inspector.push(value);
        const forwarded = terminalOffset === null ? value : value.subarray(0, terminalOffset);
        if (forwarded.byteLength > 0 && !await writeOrDrain(res, forwarded)) return;
        if (streamState.sawTerminal) {
          storeCompletedResponse(reqContext, streamState.completed);
          res.end();
          return { successful: Boolean(streamState.completed), compacted: false };
        }
      }
    } catch (e) {
      logRequestFailure("Responses", e, options.abort);
      await endStreamWithError(res, e, options.abort);
      return { successful: false, compacted: false };
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } else {
    const data = resp.ok
      ? await readBoundedResponseText(resp, {
        maxBytes: MAX_UPSTREAM_RESPONSES_SUCCESS_BODY_BYTES,
        label: "Copilot Responses success body",
        signal: options.signal,
      })
      : await readBoundedResponseText(resp, {
        maxBytes: MAX_UPSTREAM_ERROR_BODY_BYTES,
        label: "Copilot Responses error body",
      });
    if (resp.ok && reqContext.surface === "responses_compact") {
      const response = parseResponsesCompactionResult(
        compactionInputWithoutTrigger(reqContext.body.input),
        data,
      );
      rememberResponseHistory(reqContext, response);
      recordResponsesUsage({
        surface: reqContext.surface,
        mode: "json",
        model: reqContext.body?.model,
        response,
        event: response,
      });
      res.writeHead(resp.status, safeUpstreamResponseHeaders(resp.headers, {
        contentType: "application/json",
      }));
      res.end(JSON.stringify(response));
      return { successful: true, compacted: true };
    }
    if (resp.ok) {
      const response = parseSuccessfulResponsesResult(data);
      rememberResponseHistory(reqContext, response);
      recordResponsesUsage({
        surface: reqContext.surface,
        mode: "json",
        model: reqContext.body?.model,
        response,
        event: response,
      });
      res.writeHead(resp.status, safeUpstreamResponseHeaders(resp.headers, {
        contentType: "application/json",
      }));
      res.end(data);
      return { successful: true, compacted: false };
    }
    res.writeHead(resp.status, safeUpstreamResponseHeaders(resp.headers, {
      contentType: "application/json",
    }));
    res.end(data);
    return { successful: false, compacted: false };
  }
}
