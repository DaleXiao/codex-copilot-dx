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
import { recordAnthropicUsage } from "./usage.mjs";

export function createAnthropicCountTokensHandler(options) {
  const { acquireRequest } = options;

  return async function handleAnthropicCountTokens(req, res) {
    const abort = createRequestAbort(req, res);
    let releaseRequest = () => {};
    try {
      releaseRequest = await acquireRequest(req, { signal: abort.signal });
      const parsed = await readJsonBody(req);
      const result = await countTokens(parsed);
      releaseRequest();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      sendJsonError(res, error);
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
    streamHandshakeTimeoutMs,
    streamIdleTimeoutMs,
    upstreamTimeoutMs,
  } = options;

  return async function handleAnthropicMessages(req, res) {
    const abort = createRequestAbort(req, res);
    let releaseRequest = () => {};
    try {
      releaseRequest = await acquireRequest(req, { signal: abort.signal });
      const parsed = await readJsonBody(req);
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
        const upstream = await chatCompletionsFn({ ...chatReq, stream: true }, { signal: abort.signal });
        releaseRequest();
        if (!upstream.ok) {
          if (!res.headersSent) res.writeHead(upstream.status);
          res.end(await upstream.text());
          return;
        }
        abort.setTimeout(streamIdleTimeoutMs, "stream_idle_timeout");
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
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
          sendUpstreamError(res, upstream, data);
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
        res.writeHead(200, { "Content-Type": "application/json" });
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
