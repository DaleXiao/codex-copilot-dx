import { getCachedModelEndpoints } from "./copilot.mjs";
import {
  createRequestAbort,
  logRequestFailure,
  readJsonBody,
  sendJsonError,
  sendUpstreamError,
  writeOrDrain,
} from "./http-transport.mjs";
import {
  CODEX_AUTO_REVIEW_MODEL,
  modelIsResponsesOnly,
  modelSupportsChatCompletions,
  resolveOpenAIModel,
} from "./models.mjs";
import { chatToResponses, forwardToChat, responsesToChat } from "./responses-bridge.mjs";
import { proxyCopilotResponses } from "./responses-proxy.mjs";
import { prepareResponsesRequest, rememberResponseHistory } from "./responses-request.mjs";
import { status } from "./status.mjs";
import { endStreamWithError } from "./stream-errors.mjs";
import { recordResponsesUsage } from "./usage.mjs";

const RESPONSES_ONLY_FALLBACK = new Set([
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
]);

function isResponsesOnlyModel(model) {
  const endpoints = getCachedModelEndpoints(model);
  if (endpoints) {
    const fakeModel = { supported_endpoints: endpoints };
    if (modelSupportsChatCompletions(fakeModel)) return false;
    if (modelIsResponsesOnly(fakeModel)) return true;
  }
  return RESPONSES_ONLY_FALLBACK.has(model);
}

export function createResponsesHandler(options) {
  const {
    acquireRequest,
    chatCompletionsFn,
    openAIModelEnv,
    responsesFn,
    streamHandshakeTimeoutMs,
    streamIdleTimeoutMs,
    upstreamTimeoutMs,
  } = options;

  return async function handleResponses(req, res) {
    const abort = createRequestAbort(req, res);
    let releaseRequest = () => {};
    try {
      releaseRequest = await acquireRequest(req, { signal: abort.signal });
      const parsed = await readJsonBody(req);
      abort.setTimeout(
        parsed.stream ? streamHandshakeTimeoutMs : upstreamTimeoutMs,
        parsed.stream ? "stream_handshake_timeout" : "upstream_timeout",
      );
      const prepared = prepareResponsesRequest(parsed, { mutate: true });
      prepared.surface = "responses";
      const model = parsed.model || "unknown";
      const { requestedModel, upstreamModel } = resolveOpenAIModel(model, openAIModelEnv);
      if (upstreamModel !== requestedModel) prepared.body.model = upstreamModel;
      const upstreamLog = upstreamModel === requestedModel ? "" : ` upstream_model=${upstreamModel}`;
      console.log(status("info", `responses model=${requestedModel}${upstreamLog} stream=${!!parsed.stream}`));
      if (requestedModel === CODEX_AUTO_REVIEW_MODEL || isResponsesOnlyModel(upstreamModel)) {
        await proxyCopilotResponses(prepared, req, res, responsesFn, {
          signal: abort.signal,
          abort,
          releaseRequest,
          streamIdleTimeoutMs,
        });
      } else {
        const chatReq = responsesToChat(prepared.body);
        if (parsed.stream) {
          await forwardToChat(chatReq, async (event, data) => {
            if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
            await writeOrDrain(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            if (event === "response.completed") {
              rememberResponseHistory(prepared, data.response);
              recordResponsesUsage({ surface: prepared.surface, mode: "stream", model, response: data.response, event: data });
            }
          }, () => { if (!res.writableEnded) res.end(); }, async (statusCode, errMsg) => {
            if (!res.headersSent) {
              res.writeHead(statusCode || 500, { "Content-Type": "text/plain; charset=utf-8" });
              res.end(errMsg);
              return;
            }
            await endStreamWithError(res, "responses", new Error(errMsg), abort);
          }, {
            signal: abort.signal,
            abort,
            streamIdleTimeoutMs,
            chatCompletionsFn,
            releaseRequest,
          });
        } else {
          chatReq.stream = false;
          delete chatReq.max_tokens;
          try {
            const upstream = await chatCompletionsFn({ ...chatReq, stream: false }, { signal: abort.signal });
            releaseRequest();
            const data = await upstream.text();
            if (!upstream.ok) {
              sendUpstreamError(res, upstream, data);
              return;
            }
            const response = chatToResponses(JSON.parse(data), model);
            rememberResponseHistory(prepared, response);
            recordResponsesUsage({ surface: prepared.surface, mode: "json", model, response, event: response });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
          } catch (error) {
            logRequestFailure("Responses", error, abort);
            sendJsonError(res, error, 502);
          }
        }
      }
    } catch (error) {
      logRequestFailure("Responses", error, abort);
      sendJsonError(res, error, 502);
    } finally {
      releaseRequest();
      abort.cleanup();
    }
  };
}

export function createResponsesCompactHandler(options) {
  const {
    acquireRequest,
    openAIModelEnv,
    responsesCompactFn,
    streamHandshakeTimeoutMs,
    streamIdleTimeoutMs,
    upstreamTimeoutMs,
  } = options;

  return async function handleResponsesCompact(req, res) {
    const abort = createRequestAbort(req, res);
    let releaseRequest = () => {};
    try {
      releaseRequest = await acquireRequest(req, { signal: abort.signal });
      const parsed = await readJsonBody(req);
      abort.setTimeout(
        parsed.stream ? streamHandshakeTimeoutMs : upstreamTimeoutMs,
        parsed.stream ? "stream_handshake_timeout" : "upstream_timeout",
      );
      const prepared = prepareResponsesRequest(parsed, { mutate: true });
      prepared.surface = "responses_compact";
      const model = parsed.model || "unknown";
      const { requestedModel, upstreamModel } = resolveOpenAIModel(model, openAIModelEnv);
      if (upstreamModel !== requestedModel) prepared.body.model = upstreamModel;
      const upstreamLog = upstreamModel === requestedModel ? "" : ` upstream_model=${upstreamModel}`;
      console.log(status("info", `responses compact model=${requestedModel}${upstreamLog} stream=${!!parsed.stream}`));
      await proxyCopilotResponses(prepared, req, res, responsesCompactFn, {
        signal: abort.signal,
        abort,
        releaseRequest,
        streamIdleTimeoutMs,
      });
    } catch (error) {
      logRequestFailure("Responses compact", error, abort);
      sendJsonError(res, error, 502);
    } finally {
      releaseRequest();
      abort.cleanup();
    }
  };
}
