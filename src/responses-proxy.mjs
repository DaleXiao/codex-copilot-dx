import { responses as copilotResponses } from "./copilot.mjs";
import {
  httpError,
  logRequestFailure,
  sendUpstreamError,
  writeOrDrain,
} from "./http-transport.mjs";
import { openCopilotResponse, rememberResponseHistory } from "./responses-request.mjs";
import { loadRuntimeConfig } from "./runtime-config.mjs";
import { endStreamWithError } from "./stream-errors.mjs";
import { recordResponsesUsage } from "./usage.mjs";

const MAX_SSE_BUFFER_BYTES = loadRuntimeConfig().maxSseBufferBytes;

function storeCompletedResponseFromSse(reqContext, data) {
  if (!data || data === "[DONE]") return;
  try {
    const event = JSON.parse(data);
    const response = event.response;
    if (response?.id && response.status === "completed") {
      rememberResponseHistory(reqContext, response);
      recordResponsesUsage({
        surface: reqContext.surface,
        mode: "stream",
        model: reqContext.body?.model,
        response,
        event,
      });
    }
  } catch {
    // Ignore non-JSON stream fragments.
  }
}

function readSseEvents(buffer, onData) {
  while (true) {
    const match = buffer.match(/\r?\n\r?\n/);
    if (!match) return buffer;
    const chunk = buffer.slice(0, match.index);
    if (Buffer.byteLength(chunk) > MAX_SSE_BUFFER_BYTES) {
      throw httpError(`Upstream SSE buffer exceeds ${MAX_SSE_BUFFER_BYTES} bytes`, 502);
    }
    buffer = buffer.slice(match.index + match[0].length);
    const data = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) onData(data);
  }
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
    options.abort?.setTimeout(options.streamIdleTimeoutMs, "stream_idle_timeout");
    res.writeHead(resp.status, {
      "Content-Type": resp.headers.get("content-type") || "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (Buffer.byteLength(buffer) > MAX_SSE_BUFFER_BYTES) {
            throw httpError(`Upstream SSE buffer exceeds ${MAX_SSE_BUFFER_BYTES} bytes`, 502);
          }
          readSseEvents(buffer, (data) => storeCompletedResponseFromSse(reqContext, data));
          res.end();
          return;
        }
        options.abort?.setTimeout(options.streamIdleTimeoutMs, "stream_idle_timeout");
        buffer += decoder.decode(value, { stream: true });
        buffer = readSseEvents(buffer, (data) => storeCompletedResponseFromSse(reqContext, data));
        if (Buffer.byteLength(buffer) > MAX_SSE_BUFFER_BYTES) {
          throw httpError(`Upstream SSE buffer exceeds ${MAX_SSE_BUFFER_BYTES} bytes`, 502);
        }
        if (!await writeOrDrain(res, value)) return;
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
    res.writeHead(resp.status, { "Content-Type": "application/json" });
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
