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
const SSE_WRITE_BATCH_BYTES = 64 * 1024;
const RESPONSES_TERMINAL_EVENT_TYPES = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
  "error",
]);
const MESSAGE_CONTENT_EVENT_TYPES = new Set([
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.output_text.annotation.added",
  "response.refusal.delta",
  "response.refusal.done",
]);

function normalizeMessageIds(state, event, eventType) {
  let changed = false;
  const replaceId = (object, field, id) => {
    if (id && typeof object?.[field] === "string" && object[field] !== id) {
      object[field] = id;
      changed = true;
    }
  };
  const index = event.output_index;
  if (Number.isSafeInteger(index) && index >= 0) {
    // Bind only confirmed message items, using the full output index (including tools).
    // IDs are opaque: retain the first upstream ID without decoding or synthesizing one.
    if (eventType === "response.output_item.added" && event.item?.type === "message"
      && typeof event.item.id === "string" && event.item.id.length > 0
      && !state.messageIds.has(index)) {
      state.messageIds.set(index, event.item.id);
    }
    const id = state.messageIds.get(index);
    if (["response.output_item.added", "response.output_item.done"].includes(eventType)
      && event.item?.type === "message") {
      replaceId(event.item, "id", id);
    } else if (MESSAGE_CONTENT_EVENT_TYPES.has(eventType)) {
      replaceId(event, "item_id", id);
    }
  }
  if (RESPONSES_TERMINAL_EVENT_TYPES.has(eventType) && Array.isArray(event.response?.output)) {
    for (let index = 0; index < event.response.output.length; index += 1) {
      const item = event.response.output[index];
      if (item?.type === "message") replaceId(item, "id", state.messageIds.get(index));
    }
  }
  return changed;
}

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
  const changed = normalizeMessageIds(state, event, eventType);
  const outputTokens = event.response?.usage?.output_tokens ?? event.usage?.output_tokens;
  if (outputTokens !== undefined) markOutputTokens(outputTokens);
  if (!state.sawOutput && isResponsesOutputEvent(event, eventType)) {
    state.sawOutput = true;
    markFirstOutput();
  }
  if (["response.function_call_arguments.delta", "response.custom_tool_call_input.delta"].includes(eventType)) {
    state.toolArgumentGuard.observe(event.output_index ?? event.item_id ?? event.call_id, event.delta);
  }
  if (!RESPONSES_TERMINAL_EVENT_TYPES.has(eventType)) return changed ? event : null;
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
  if (eventType === "response.completed") {
    const response = event.response;
    state.completed = { response, event };
  }
  return changed ? event : null;
}

function createResponseSseTransformer(state) {
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

  const inspectEvent = (frame, delimiterLength) => {
    const contentLength = frame.byteLength - delimiterLength;
    if (contentLength > MAX_SSE_BUFFER_BYTES) {
      throw httpError(`Upstream SSE buffer exceeds ${MAX_SSE_BUFFER_BYTES} bytes`, 502);
    }
    const chunk = frame.subarray(0, contentLength).toString("utf8");
    const lines = chunk.split(/\r?\n/);
    const eventName = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    const changed = data && inspectResponseSseEvent(state, eventName, data);
    if (!changed) return frame;
    let wroteData = false;
    const rewritten = lines.filter((line) => {
      if (!line.startsWith("data:")) return true;
      if (wroteData) return false;
      wroteData = true;
      return true;
    }).map((line) => line.startsWith("data:") ? `data: ${JSON.stringify(changed)}` : line);
    return Buffer.from(rewritten.join(chunk.includes("\r\n") ? "\r\n" : "\n")
      + frame.subarray(contentLength).toString("ascii"));
  };

  return {
    push(value) {
      // Fetch exposes Uint8Array chunks; use a zero-copy Buffer view for UTF-8 decoding.
      if (!Buffer.isBuffer(value)) value = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      let pending = [];
      let pendingBytes = 0;
      const flush = () => {
        const output = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
        pending = [];
        pendingBytes = 0;
        return output;
      };
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
          let frame = value.subarray(segmentStart, index + 1);
          if (eventLength > 0) {
            append(frame);
            // Writes may retain a Buffer after returning; never expose the reusable buffer.
            if (eventLength > SSE_WRITE_BATCH_BYTES) {
              frame = eventBuffer.subarray(0, eventLength);
              eventBuffer = Buffer.allocUnsafe(Math.min(4096, MAX_SSE_BUFFER_BYTES + 4));
            } else {
              frame = Buffer.from(eventBuffer.subarray(0, eventLength));
            }
          }
          eventLength = 0;
          previous1 = -1;
          previous2 = -1;
          previous3 = -1;
          segmentStart = index + 1;
          const forwarded = inspectEvent(frame, delimiterLength);
          const last = pending.at(-1);
          if (last && last.buffer === forwarded.buffer
            && last.byteOffset + last.byteLength === forwarded.byteOffset) {
            pending[pending.length - 1] = Buffer.from(last.buffer, last.byteOffset, last.byteLength + forwarded.byteLength);
          } else {
            pending.push(forwarded);
          }
          pendingBytes += forwarded.byteLength;
          if (state.sawTerminal) return flush();
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
      return pendingBytes > 0 ? flush() : null;
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
      messageIds: new Map(),
    };
    const transformer = createResponseSseTransformer(streamState);
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
        // Batch within this read, not across reads, and await drain before processing more.
        for (let offset = 0; offset < value.byteLength; offset += SSE_WRITE_BATCH_BYTES) {
          const frame = transformer.push(value.subarray(offset, offset + SSE_WRITE_BATCH_BYTES));
          if (frame && !await writeOrDrain(res, frame)) return;
          if (streamState.sawTerminal) break;
        }
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
