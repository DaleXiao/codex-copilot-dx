import {
  anthropicToChat,
  chatToAnthropic,
  countTokens,
  streamAnthropicFromLines,
} from "./anthropic.mjs";
import {
  createRequestAbort,
  logRequestFailure,
  readJsonBody,
  sendJsonError,
  sendUpstreamError,
  writeOrDrain,
} from "./http-transport.mjs";
import { resolveAnthropicModel } from "./models.mjs";
import { status } from "./status.mjs";
import { webStreamLines } from "./stream.mjs";
import { endStreamWithError } from "./stream-errors.mjs";
import { requireUpstreamEventStream, withChatStreamUsage } from "./stream-contract.mjs";
import { safeUpstreamResponseHeaders } from "./upstream-headers.mjs";
import { recordAnthropicUsage } from "./usage.mjs";

const PROMPT_TOO_LONG_MESSAGE = "prompt is too long: your prompt is too long. Please reduce the number of messages or use a model with a larger context window.";

function contextWindowErrorBody(text) {
  let error;
  try {
    const parsed = JSON.parse(text);
    error = parsed && typeof parsed === "object" ? parsed.error : null;
  } catch {
    error = { message: text };
  }
  if (!error || typeof error !== "object") return null;
  const code = error.code;
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  const matches = code === "context_length_exceeded"
    || code === "model_max_prompt_tokens_exceeded"
    || message.includes("exceeds the context window of this model")
    || message.includes("maximum context length is")
    || message.includes("request body is too large for model context window");
  if (!matches) return null;
  return JSON.stringify({
    type: "error",
    error: { type: "invalid_request_error", message: PROMPT_TOO_LONG_MESSAGE },
  });
}

function sendAnthropicUpstreamError(res, response, text) {
  const rewritten = contextWindowErrorBody(text);
  if (!rewritten) {
    sendUpstreamError(res, response, text);
    return;
  }
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  sendUpstreamError(res, { status: response.status, headers }, rewritten);
}

export function createAnthropicCountTokensHandler(options) {
  const { acquireRequest, requestBodyTimeoutMs } = options;

  return async function handleAnthropicCountTokens(req, res) {
    const abort = createRequestAbort(req, res);
    let releaseRequest = () => {};
    try {
      releaseRequest = await acquireRequest(req, { signal: abort.signal });
      abort.setTimeout(requestBodyTimeoutMs, "request_body_timeout");
      const parsed = await readJsonBody(req, { admission: releaseRequest, signal: abort.signal });
      abort.clearTimeout();
      const result = await countTokens(parsed);
      releaseRequest();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      sendJsonError(res, error, abort.reason === "request_body_timeout" ? 408 : 400);
    } finally {
      releaseRequest();
      abort.cleanup();
    }
  };
}

export function createAnthropicMessagesHandler(options) {
  const {
    acquireRequest,
    chatCompletionsFn,
    environment,
    modelOptions,
    requestBodyTimeoutMs,
    streamHandshakeTimeoutMs,
    streamIdleTimeoutMs,
    upstreamTimeoutMs,
  } = options;

  return async function handleAnthropicMessages(req, res) {
    const abort = createRequestAbort(req, res);
    let releaseRequest = () => {};
    try {
      releaseRequest = await acquireRequest(req, { signal: abort.signal });
      abort.setTimeout(requestBodyTimeoutMs, "request_body_timeout");
      const parsed = await readJsonBody(req, { admission: releaseRequest, signal: abort.signal });
      abort.setTimeout(
        parsed.stream ? streamHandshakeTimeoutMs : upstreamTimeoutMs,
        parsed.stream ? "stream_handshake_timeout" : "upstream_timeout",
      );
      const { requestedModel, upstreamModel } = resolveAnthropicModel(parsed.model || "unknown", environment, modelOptions());
      const modelNote = upstreamModel === requestedModel ? requestedModel : `${requestedModel} -> ${upstreamModel}`;
      console.log(status("info", `messages model=${modelNote} stream=${!!parsed.stream}`));
      const chatReq = anthropicToChat(parsed, { upstreamModel });
      const forceRequestedModel = upstreamModel !== requestedModel;
      if (parsed.stream) {
        const upstream = await chatCompletionsFn(withChatStreamUsage(chatReq), { signal: abort.signal });
        releaseRequest();
        if (!upstream.ok) {
          sendAnthropicUpstreamError(res, upstream, await upstream.text());
          return;
        }
        await requireUpstreamEventStream(upstream);
        abort.setTimeout(streamIdleTimeoutMs, "stream_idle_timeout");
        res.writeHead(200, {
          ...safeUpstreamResponseHeaders(upstream.headers, { contentType: "text/event-stream" }),
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        let messageId;
        let usage;
        try {
          await streamAnthropicFromLines(
            webStreamLines(upstream, {
              onChunk: () => abort.setTimeout(streamIdleTimeoutMs, "stream_idle_timeout"),
            }),
            async (event, data) => {
              if (event === "message_start") messageId = data.message?.id;
              if (event === "message_delta") usage = data.usage;
              await writeOrDrain(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            },
            requestedModel,
            { forceModel: forceRequestedModel },
          );
        } catch (error) {
          logRequestFailure("Messages", error, abort);
          await endStreamWithError(res, "anthropic", error, abort);
          return;
        }
        recordAnthropicUsage({ surface: "messages", mode: "stream", model: requestedModel, responseId: messageId, usage });
        if (!res.writableEnded) res.end();
      } else {
        const upstream = await chatCompletionsFn({ ...chatReq, stream: false }, { signal: abort.signal });
        releaseRequest();
        const data = await upstream.text();
        if (!upstream.ok) {
          sendAnthropicUpstreamError(res, upstream, data);
          return;
        }
        const anthropicMessage = chatToAnthropic(JSON.parse(data), requestedModel, { forceModel: forceRequestedModel });
        recordAnthropicUsage({
          surface: "messages",
          mode: "json",
          model: anthropicMessage.model,
          responseId: anthropicMessage.id,
          usage: anthropicMessage.usage,
        });
        res.writeHead(200, safeUpstreamResponseHeaders(upstream.headers, {
          contentType: "application/json",
        }));
        res.end(JSON.stringify(anthropicMessage));
      }
    } catch (error) {
      logRequestFailure("Messages", error, abort);
      sendJsonError(res, error, 502);
    } finally {
      releaseRequest();
      abort.cleanup();
    }
  };
}
