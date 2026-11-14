import { responses as copilotResponses } from "./copilot.mjs";
import {
  logRequestFailure,
  MAX_UPSTREAM_ERROR_BODY_BYTES,
  MAX_UPSTREAM_RESPONSES_SUCCESS_BODY_BYTES,
  readBoundedResponseText,
  sendUpstreamError,
  writeOrDrain,
} from "./http-transport.mjs";
import { httpError } from "./http-errors.mjs";
import {
  hasCopilotResponseRetryPolicy,
  openCopilotResponse,
  selectCopilotResponseRetryWithHistory,
} from "./copilot-responses-compat.mjs";
import {
  dropMaterializedResponseHistory,
  hasEncryptedResponseState,
  rememberResponseHistory,
  restoreMaterializedResponseHistoryForRetry,
} from "./responses-request.mjs";
import {
  formatResponseFailureLog,
  responseFailureDetails,
  responseFailureText,
} from "./response-failures.mjs";
import {
  compactionInputWithoutTrigger,
  parseResponsesCompactionResult,
} from "./responses-compaction.mjs";
import { loadRuntimeConfig } from "./runtime-config.mjs";
import { endStreamWithError, responseFailedEvent } from "./stream-errors.mjs";
import { createSseKeepalive } from "./sse-keepalive.mjs";
import {
  incompleteUpstreamStream,
  invalidUpstreamStream,
  requireUpstreamEventStream,
  ToolArgumentDeltaGuard,
} from "./stream-contract.mjs";
import {
  isResponsesOutputEvent,
  markFirstOutput,
  responsesTimingSource,
  markOutputTokens,
  markRequestObservation,
  markResponseErrorOrigin,
  markResponseTerminal,
  markStreamFailure,
  markUpstreamActivity,
} from "./stream-performance.mjs";
import { safeUpstreamResponseHeaders } from "./upstream-headers.mjs";
import { recordResponsesUsage } from "./usage-store.mjs";
import { COMPACTION_USAGE_RECORDED } from "./context-compaction.mjs";
import { status } from "./status.mjs";

const MAX_SSE_BUFFER_BYTES = loadRuntimeConfig().maxSseBufferBytes;
const SSE_WRITE_BATCH_BYTES = 64 * 1024;
const STREAM_RETRY_PRELUDE_MAX_BYTES = 256 * 1024;
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
    if ((eventType === "response.output_item.added" || eventType === "response.output_item.done")
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
  const eventType = event.type || (event.error ? "error" : eventName);
  const previousSequence = state.lastSequence;
  state.lastSequence = event.sequence_number ?? previousSequence + 1;
  if (event.response && typeof event.response === "object" && !Array.isArray(event.response)) {
    if (typeof event.response.id === "string" && event.response.id) state.response.id = event.response.id;
    if (Number.isSafeInteger(event.response.created_at) && event.response.created_at >= 0) state.response.created_at = event.response.created_at;
    if (typeof event.response.model === "string" && event.response.model) state.response.model = event.response.model;
  }
  let changed = normalizeMessageIds(state, event, eventType);
  if (state.protectCompactionResult) {
    if (event.item?.type === "compaction") {
      const protectedItem = state.protectCompactionResult({ output: [event.item] }).output[0];
      if (protectedItem !== event.item) { event.item = protectedItem;changed = true; }
    }
    if (Array.isArray(event.response?.output)) {
      const protectedResponse = state.protectCompactionResult(event.response);
      if (protectedResponse !== event.response) { event.response = protectedResponse;changed = true; }
    }
  }
  const outputTokens = event.response?.usage?.output_tokens ?? event.usage?.output_tokens;
  if (outputTokens !== undefined) markOutputTokens(outputTokens);
  const inputTokens = event.response?.usage?.input_tokens ?? event.usage?.input_tokens;
  if (inputTokens !== undefined) markRequestObservation({ input_tokens: inputTokens });
  if (!state.sawTiming) {
    const timingSource = responsesTimingSource(event, eventType);
    if (timingSource) {
      state.sawTiming = true;
      markFirstOutput(timingSource);
    }
  }
  if (!state.sawOutput && isResponsesOutputEvent(event, eventType)) {
    state.sawOutput = true;
  }
  if (["response.function_call_arguments.delta", "response.custom_tool_call_input.delta"].includes(eventType)) {
    state.toolArgumentGuard.observe(event.output_index ?? event.item_id ?? event.call_id, event.delta);
  }
  if (!RESPONSES_TERMINAL_EVENT_TYPES.has(eventType)) return changed ? event : null;
  if (eventType === "error" || eventType === "response.failed") {
    const response = { ...(event.response && typeof event.response === "object" ? event.response : {}), ...state.response };
    const sequenceNumber = Number.isSafeInteger(state.lastSequence) && state.lastSequence > previousSequence
      ? state.lastSequence : Number.isSafeInteger(previousSequence) ? previousSequence + 1 : 0;
    const failure = responseFailedEvent(event.response?.error ?? event.error ?? (eventType === "error" ? event : {}), {
      response, model: state.model, sequenceNumber, template: eventType === "response.failed" ? event : undefined,
    });
    state.sawTerminal = true;
    state.failure = { event: failure, eventType: "response.failed" };
    return failure;
  }
  const expectedStatus = {
    "response.completed": "completed",
    "response.incomplete": "incomplete",
  }[eventType];
  if (expectedStatus && (!event.response?.id || event.response.status !== expectedStatus)) {
    throw invalidUpstreamStream(
      `Upstream ${eventType} event contained an invalid response resource`,
      "upstream_stream_terminal_invalid",
    );
  }
  state.sawTerminal = true;
  if (eventType === "response.completed") {
    const response = event.response;
    state.completed = { response, event };
  } else if (eventType === "response.incomplete") {
    state.incomplete = { response: event.response, event };
  }
  return changed ? event : null;
}

function createResponseSseTransformer(state) {
  let eventBuffer = Buffer.allocUnsafe(Math.min(4096, MAX_SSE_BUFFER_BYTES + 4));
  let eventLength = 0;
  let previous1 = -1;
  let previous2 = -1;
  let previous3 = -1;
  let bareCR = false;

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
    const lines = bareCR ? chunk.split(/\r\n|\r|\n/) : chunk.split(/\r?\n/);
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
    }).map((line) => line.startsWith("data:") ? `data: ${JSON.stringify(changed)}`
      : changed.type === "response.failed" && line.startsWith("event:") ? "event: response.failed" : line);
    if (changed.type === "response.failed" && !eventName) rewritten.unshift("event: response.failed");
    const newline = bareCR ? chunk.match(/\r\n|\r|\n/)?.[0] || "\n" : chunk.includes("\r\n") ? "\r\n" : "\n";
    return Buffer.from(rewritten.join(newline)
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
      if (!bareCR) {
        if (previous1 === 0x0d && value.length && value[0] !== 0x0a) bareCR = true;
        for (let at = value.indexOf(0x0d); !bareCR && at >= 0; at = value.indexOf(0x0d, at + 1)) {
          if (at + 1 < value.length && value[at + 1] !== 0x0a) bareCR = true;
        }
      }
      if (!bareCR) {
        // The common LF/CRLF path searches newline bytes in native code;
        // the three-byte carry keeps delimiters split across reads intact.
        for (let index = value.indexOf(0x0a); index >= 0; index = value.indexOf(0x0a, index + 1)) {
          const available = index - segmentStart;
          const p1 = available >= 1 ? value[index - 1] : segmentStart === 0 ? previous1 : -1;
          const p2 = available >= 2 ? value[index - 2] : segmentStart === 0 ? available === 1 ? previous1 : previous2 : -1;
          const p3 = available >= 3 ? value[index - 3] : segmentStart === 0 ? available === 2 ? previous1 : available === 1 ? previous2 : previous3 : -1;
          let delimiterLength = 0;
          if (p1 === 0x0a) {
            delimiterLength = p2 === 0x0d ? 3 : 2;
          } else if (p1 === 0x0d && p2 === 0x0a) {
            delimiterLength = p3 === 0x0d ? 4 : 3;
          }
          if (delimiterLength) {
            let frame = value.subarray(segmentStart, index + 1);
            if (eventLength > 0) {
              append(frame);
              if (eventLength > SSE_WRITE_BATCH_BYTES) {
                frame = eventBuffer.subarray(0, eventLength);
                eventBuffer = Buffer.allocUnsafe(Math.min(4096, MAX_SSE_BUFFER_BYTES + 4));
              } else frame = Buffer.from(eventBuffer.subarray(0, eventLength));
            }
            eventLength = 0;previous1 = -1;previous2 = -1;previous3 = -1;segmentStart = index + 1;
            const forwarded = inspectEvent(frame, delimiterLength), last = pending.at(-1);
            if (last && last.buffer === forwarded.buffer && last.byteOffset + last.byteLength === forwarded.byteOffset)
              pending[pending.length - 1] = Buffer.from(last.buffer, last.byteOffset, last.byteLength + forwarded.byteLength);
            else pending.push(forwarded);
            pendingBytes += forwarded.byteLength;
            if (state.sawTerminal) return flush();
          }
        }
        for (let index = Math.max(segmentStart, value.byteLength - 3); index < value.byteLength; index++) {
          previous3 = previous2;previous2 = previous1;previous1 = value[index];
        }
        append(value.subarray(segmentStart));
        if (eventLength > MAX_SSE_BUFFER_BYTES + 3) throw httpError(`Upstream SSE buffer exceeds ${MAX_SSE_BUFFER_BYTES} bytes`, 502);
        return pendingBytes > 0 ? flush() : null;
      }
      const forward = (end, delimiterLength) => {
        let frame = value.subarray(segmentStart, end);
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
        segmentStart = end;
        const forwarded = inspectEvent(frame, delimiterLength);
        const last = pending.at(-1);
        if (last && last.buffer === forwarded.buffer
          && last.byteOffset + last.byteLength === forwarded.byteOffset) {
          pending[pending.length - 1] = Buffer.from(last.buffer, last.byteOffset, last.byteLength + forwarded.byteLength);
        } else {
          pending.push(forwarded);
        }
        pendingBytes += forwarded.byteLength;
      };
      for (let index = 0; index < value.byteLength; index += 1) {
        const byte = value[index];
        // A CR after an LF may be the last byte of a blank line. Wait for
        // the next byte so split CRLF frames retain their original bytes.
        if (previous1 === 0x0d && previous2 === 0x0a && byte !== 0x0a) {
          forward(index, previous3 === 0x0d ? 3 : 2);
          if (state.sawTerminal) return flush();
        }
        let delimiterLength = 0;
        if (byte === 0x0a && previous1 === 0x0a) {
          delimiterLength = previous2 === 0x0d ? 3 : 2;
        } else if (byte === 0x0a && previous1 === 0x0d && previous2 === 0x0a) {
          delimiterLength = previous3 === 0x0d ? 4 : 3;
        } else if (byte === 0x0d && previous1 === 0x0d) {
          delimiterLength = 2;
          if (value[index + 1] === 0x0a) { index += 1;delimiterLength += 1; }
        }
        if (delimiterLength) {
          forward(index + 1, delimiterLength);
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
    finish() {
      if (previous1 !== 0x0d || previous2 !== 0x0a || !eventLength) return null;
      bareCR = true;
      const delimiterLength = previous3 === 0x0d ? 3 : 2;
      const frame = Buffer.from(eventBuffer.subarray(0, eventLength));
      eventLength = 0;previous1 = -1;previous2 = -1;previous3 = -1;
      return inspectEvent(frame, delimiterLength);
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
  rememberResponseHistory(reqContext, reqContext.privacyRestore?.(completed.response) || completed.response);
  if (!reqContext.compactionUsageRecorded) recordResponsesUsage({
    surface: reqContext.surface,
    mode: "stream",
    model: reqContext.body?.model,
    response: completed.response,
    event: completed.event,
  });
}

function streamHeaders(resp) {
  return {
    ...safeUpstreamResponseHeaders(resp.headers, { defaultContentType: "text/event-stream", allowReasoningIncluded: resp.ok }),
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
}

async function selectStreamFailureRetry(reqContext, failure, usedRetryPolicies, options) {
  if (!failure) return null;
  const errorText = responseFailureText(failure.event, failure.eventType);
  if (!(options.compatibility?.hasRetry || hasCopilotResponseRetryPolicy)(400, errorText, usedRetryPolicies)) return null;
  const preparation = await options.acquireRetryPreparation?.(reqContext);
  let keepReservation = false;
  try {
    const restored = restoreMaterializedResponseHistoryForRetry(reqContext, {
      assertActive: options.assertPrepareActive,
      historySnapshot: preparation?.historySnapshot,
    });
    const retry = await (options.compatibility?.selectRetry || selectCopilotResponseRetryWithHistory)(restored, 400, errorText, usedRetryPolicies, {
      ...options, reserveHistory: preparation?.reserveHistory || options.reserveHistory,
    });
    options.assertPrepareActive?.();
    keepReservation = Boolean(retry);
    return {
      retry: retry ? { ...retry, releasePreparation: () => { retry.releasePreparation?.();preparation?.release(); } } : null,
      retrySkipped: null,
    };
  } catch (error) {
    options.assertPrepareActive?.();
    if (error.code === "ccdx_history_rebuild_required") throw error;
    return { retry: null, retrySkipped: "history_unavailable" };
  } finally {
    if (!keepReservation) preparation?.release();
  }
}

function recordResponseFailure(options, reqContext, resp, failure, {
  retry,
  retrySkipped,
  recovery,
} = {}) {
  if (!failure) return;
  const details = responseFailureDetails(failure.event, failure.eventType, {
    model: reqContext.body?.model,
    headers: resp.headers,
    retried: Boolean(retry),
    retryPolicy: retry?.policyId,
    retrySkipped,
  });
  if (retry?.recovery) details.recovery = retry.recovery;
  else if (recovery) details.recovery = recovery;
  options.responseFailures?.record?.(details);
  console.warn(status("warn", formatResponseFailureLog(details)));
}

async function proxyStreamingResponses(opened, res, upstream, options) {
  while (true) {
    let {
      resp,
      errorText,
      reqContext,
      streamRetryEligible = false,
      usedRetryPolicies = new Set(),
    } = opened;
    if (errorText !== undefined) {
      markResponseErrorOrigin("upstream_http");
      sendUpstreamError(res, resp, errorText);
      return { successful: false, compacted: false, upstreamStatus: resp.status };
    }
    await requireUpstreamEventStream(resp);
    options.onStreamStart?.();
    options.abort?.setTimeout(options.streamIdleTimeoutMs, "stream_idle_timeout");
    const headers = streamHeaders(resp);
    let headersSent = false;
    const writeHeaders = () => {
      if (headersSent || res.headersSent) return;
      headersSent = true;
      res.writeHead(resp.status, headers);
    };
    const reader = resp.body.getReader();
    const streamState = {
      completed: null,
      incomplete: null,
      failure: null,
      sawTerminal: false,
      sawOutput: false,
      response: {},
      model: reqContext.body?.model,
      lastSequence: -1,
      toolArgumentGuard: new ToolArgumentDeltaGuard(),
      messageIds: new Map(),
      protectCompactionResult: reqContext.protectCompactionResult,
    };
    const transformer = createResponseSseTransformer(streamState);
    let holdPrelude = streamRetryEligible;
    let retryDisabledReason = holdPrelude ? null : "request_not_eligible";
    const prelude = [];
    let preludeBytes = 0;
    const keepalive = createSseKeepalive({ res, signal: options.signal,
      intervalMs: options.keepaliveIntervalMs,
      canWrite: () => !holdPrelude && !streamState.sawTerminal });
    const flushPrelude = async () => {
      if (!preludeBytes) return true;
      writeHeaders();
      const body = prelude.length === 1 ? prelude[0] : Buffer.concat(prelude, preludeBytes);
      prelude.length = 0;
      preludeBytes = 0;
      keepalive.activity();
      return writeOrDrain(res, body, { signal: options.signal });
    };
    const forwardFrame = async (frame) => {
      if (!frame) return true;
      if (!holdPrelude) {
        writeHeaders();
        keepalive.activity();
        return writeOrDrain(res, frame, { signal: options.signal });
      }
      prelude.push(frame);
      preludeBytes += frame.byteLength;
      if (!streamState.sawOutput && preludeBytes <= STREAM_RETRY_PRELUDE_MAX_BYTES) return true;
      retryDisabledReason = streamState.sawOutput ? "output_started" : "prelude_limit";
      holdPrelude = false;
      return flushPrelude();
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (!await forwardFrame(transformer.finish())) return { successful: false, compacted: false };
          if (!streamState.sawTerminal) throw incompleteUpstreamStream("a terminal Responses event");
          break;
        }
        markUpstreamActivity();
        options.abort?.setTimeout(options.streamIdleTimeoutMs, "stream_idle_timeout");
        for (let offset = 0; offset < value.byteLength; offset += SSE_WRITE_BATCH_BYTES) {
          const frame = transformer.push(value.subarray(offset, offset + SSE_WRITE_BATCH_BYTES));
          if (!await forwardFrame(frame)) return { successful: false, compacted: false };
          if (streamState.sawTerminal) break;
        }
        if (streamState.sawTerminal) break;
      }

      let retry = null;
      if (streamState.failure && holdPrelude && !streamState.sawOutput) {
        let selected;
        try {
          selected = await selectStreamFailureRetry(reqContext, streamState.failure, usedRetryPolicies, options);
        } catch (error) {
          recordResponseFailure(options, reqContext, resp, streamState.failure, {
            retrySkipped: error.code === "ccdx_history_rebuild_required" ? error.code : "retry_preparation_failed",
            recovery: error.jsonBody?.error?.recovery,
          });
          throw error;
        }
        retry = selected?.retry || null;
        if (!retry) retryDisabledReason = selected?.retrySkipped || "not_applicable";
      }
      if (streamState.failure) {
        recordResponseFailure(options, reqContext, resp, streamState.failure, {
          retry,
          retrySkipped: retry ? null : retryDisabledReason,
        });
      }
      if (retry) {
        console.warn(status("warn", retry.warning));
        try {
          opened = await (options.compatibility?.openResponse || openCopilotResponse)(retry.reqContext, upstream, {
            ...options,
            usedRetryPolicies: retry.usedPolicies,
          });
          opened.streamRetryEligible = hasEncryptedResponseState(opened.reqContext.body?.input);
          dropMaterializedResponseHistory(opened.reqContext);
        } finally {
          retry.releasePreparation?.();
        }
        continue;
      }
      if (holdPrelude && !await flushPrelude()) return { successful: false, compacted: false };
      if (streamState.completed) {
        markResponseTerminal("completed", {
          model: streamState.completed.response.model || reqContext.body?.model,
          origin: "upstream_response",
        });
      } else if (streamState.incomplete) {
        markResponseTerminal("incomplete", {
          model: streamState.incomplete.response.model || reqContext.body?.model,
          origin: "upstream_response",
          reason: streamState.incomplete.response.incomplete_details?.reason,
        });
      } else if (streamState.failure) {
        markStreamFailure();
        markResponseTerminal("failed", { model: reqContext.body?.model, origin: "upstream_event" });
      }
      storeCompletedResponse(reqContext, streamState.completed);
      if (!res.writableEnded) res.end();
      return { successful: Boolean(streamState.completed), compacted: false };
    } catch (error) {
      markResponseErrorOrigin(error.origin === "privacy" ? "privacy" : "transport");
      markStreamFailure();
      logRequestFailure("Responses", error, options.abort);
      writeHeaders();
      await endStreamWithError(res, error, options.abort, {
        response: streamState.response, model: streamState.model, sequenceNumber: streamState.lastSequence + 1,
      });
      return { successful: false, compacted: false };
    } finally {
      keepalive.stop();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

export async function proxyCopilotResponses(reqContext, req, res, upstream = copilotResponses, options = {}) {
  let opened;
  try {
    opened = await (options.compatibility?.openResponse || openCopilotResponse)(reqContext, upstream, options);
    opened.streamRetryEligible = opened.reqContext.body.stream === true
      && hasEncryptedResponseState(opened.reqContext.body?.input);
  } finally {
    options.releaseRequest?.(opened?.reqContext);
  }
  reqContext = opened.reqContext;
  if (reqContext.body.stream) {
    return proxyStreamingResponses(opened, res, upstream, options);
  }

  while (true) {
    const { resp, errorText, usedRetryPolicies = new Set() } = opened;
    reqContext = opened.reqContext;
    if (errorText !== undefined) {
      markResponseErrorOrigin("upstream_http");
      sendUpstreamError(res, resp, errorText);
      return { successful: false, compacted: false, upstreamStatus: resp.status };
    }
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
      let response = parseResponsesCompactionResult(
        compactionInputWithoutTrigger(reqContext.body.input),
        data,
      );
      response = reqContext.protectCompactionResult?.(response) || response;
      rememberResponseHistory(reqContext, reqContext.privacyRestore?.(response) || response);
      if (!resp[COMPACTION_USAGE_RECORDED]) recordResponsesUsage({
        surface: reqContext.surface,
        mode: "json",
        model: reqContext.body?.model,
        response,
        event: response,
      });
      markResponseTerminal("completed", { model: response.model || reqContext.body?.model, origin: "upstream_response" });
      res.writeHead(resp.status, safeUpstreamResponseHeaders(resp.headers, {
        contentType: "application/json",
        allowReasoningIncluded: true,
      }));
      res.end(JSON.stringify(response));
      return { successful: true, compacted: true };
    }
    if (resp.ok) {
      const response = parseSuccessfulResponsesResult(data);
      if (response.status === "failed") {
        const failure = { event: { type: "response.failed", response }, eventType: "response.failed" };
        let selected;
        try {
          selected = await selectStreamFailureRetry(reqContext, failure, usedRetryPolicies, options);
        } catch (error) {
          recordResponseFailure(options, reqContext, resp, failure, {
            retrySkipped: error.code === "ccdx_history_rebuild_required" ? error.code : "retry_preparation_failed",
            recovery: error.jsonBody?.error?.recovery,
          });
          throw error;
        }
        const retry = selected?.retry || null;
        recordResponseFailure(options, reqContext, resp, failure, {
          retry,
          retrySkipped: retry ? null : selected?.retrySkipped || "not_applicable",
        });
        if (retry) {
          console.warn(status("warn", retry.warning));
          try {
            opened = await (options.compatibility?.openResponse || openCopilotResponse)(retry.reqContext, upstream, {
              ...options,
              usedRetryPolicies: retry.usedPolicies,
            });
            dropMaterializedResponseHistory(opened.reqContext);
          } finally {
            retry.releasePreparation?.();
          }
          continue;
        }
      }
      rememberResponseHistory(reqContext, reqContext.privacyRestore?.(response) || response);
      if (!reqContext.compactionUsageRecorded) recordResponsesUsage({
        surface: reqContext.surface,
        mode: "json",
        model: reqContext.body?.model,
        response,
        event: response,
      });
      if (["completed", "incomplete", "failed"].includes(response.status)) {
        markResponseTerminal(response.status, {
          model: response.model || reqContext.body?.model,
          origin: "upstream_response",
          reason: response.incomplete_details?.reason,
        });
      }
      res.writeHead(resp.status, safeUpstreamResponseHeaders(resp.headers, {
        contentType: "application/json",
        allowReasoningIncluded: response.status !== "failed",
      }));
      res.end(data);
      return { successful: response.status !== "failed" && response.status !== "incomplete", compacted: false };
    }
    res.writeHead(resp.status, safeUpstreamResponseHeaders(resp.headers, {
      contentType: "application/json",
    }));
    markResponseErrorOrigin("upstream_http");
    res.end(data);
    return { successful: false, compacted: false };
  }
}
