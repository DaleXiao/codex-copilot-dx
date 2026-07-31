import { responses as copilotResponses } from "./copilot.mjs";
import {
  httpError,
  logRequestFailure,
  sendUpstreamError,
  writeOrDrain,
} from "./http-transport.mjs";
import { openCopilotResponse, rememberResponseHistory } from "./responses-request.mjs";
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

function readSseEvents(buffer, onEvent) {
  while (true) {
    const match = buffer.match(/\r?\n\r?\n/);
    if (!match) return buffer;
    const chunk = buffer.slice(0, match.index);
    if (Buffer.byteLength(chunk) > MAX_SSE_BUFFER_BYTES) {
      throw httpError(`Upstream SSE buffer exceeds ${MAX_SSE_BUFFER_BYTES} bytes`, 502);
    }
    buffer = buffer.slice(match.index + match[0].length);
    const lines = chunk.split(/\r?\n/);
    const eventName = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) onEvent(eventName, data);
  }
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
    options.releaseRequest?.();
  }
  const { resp, errorText } = opened;
  reqContext = opened.reqContext;
  if (errorText !== undefined) {
    sendUpstreamError(res, resp, errorText);
    return;
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
    const decoder = new TextDecoder();
    let buffer = "";
    const streamState = {
      completed: null,
      sawTerminal: false,
      sawOutput: false,
      toolArgumentGuard: new ToolArgumentDeltaGuard(),
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (Buffer.byteLength(buffer) > MAX_SSE_BUFFER_BYTES) {
            throw httpError(`Upstream SSE buffer exceeds ${MAX_SSE_BUFFER_BYTES} bytes`, 502);
          }
          readSseEvents(buffer, (eventName, data) => inspectResponseSseEvent(streamState, eventName, data));
          if (!streamState.sawTerminal) throw incompleteUpstreamStream("a terminal Responses event");
          storeCompletedResponse(reqContext, streamState.completed);
          res.end();
          return;
        }
        options.abort?.setTimeout(options.streamIdleTimeoutMs, "stream_idle_timeout");
        buffer += decoder.decode(value, { stream: true });
        buffer = readSseEvents(buffer, (eventName, data) => inspectResponseSseEvent(streamState, eventName, data));
        if (Buffer.byteLength(buffer) > MAX_SSE_BUFFER_BYTES) {
          throw httpError(`Upstream SSE buffer exceeds ${MAX_SSE_BUFFER_BYTES} bytes`, 502);
        }
        if (!await writeOrDrain(res, value)) return;
        if (streamState.sawTerminal) {
          storeCompletedResponse(reqContext, streamState.completed);
          res.end();
          return;
        }
      }
    } catch (e) {
      logRequestFailure("Responses", e, options.abort);
      await endStreamWithError(res, "responses", e, options.abort);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } else {
    const data = await resp.text();
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
      return;
    }
    res.writeHead(resp.status, safeUpstreamResponseHeaders(resp.headers, {
      contentType: "application/json",
    }));
    res.end(data);
    if (resp.ok) {
      try {
        const response = JSON.parse(data);
        rememberResponseHistory(reqContext, response);
        recordResponsesUsage({
          surface: reqContext.surface,
          mode: "json",
          model: reqContext.body?.model,
          response,
          event: response,
        });
      } catch {}
    }
  }
}
