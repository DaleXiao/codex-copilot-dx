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
import { chatToResponses, forwardToChat, responsesBodyUsesCustomTools } from "./responses-bridge.mjs";
import { prepareResponsesChatPayload } from "./responses-chat-payload.mjs";
import { prepareResponsesCompactionRequest } from "./responses-compaction.mjs";
import { proxyCopilotResponses } from "./responses-proxy.mjs";
import { prepareResponsesRequest, rememberResponseHistory } from "./responses-request.mjs";
import { status } from "./status.mjs";
import { endStreamWithError } from "./stream-errors.mjs";
import { safeUpstreamResponseHeaders } from "./upstream-headers.mjs";
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

function cachedModelSupportsResponses(model) {
  const endpoints = getCachedModelEndpoints(model);
  return Array.isArray(endpoints)
    && (endpoints.includes("/responses") || endpoints.includes("/v1/responses"));
}

function unsupportedCustomToolsError(model) {
  const message = `Model ${model} has custom tool items that cannot be represented by Chat Completions, and cached endpoint metadata does not confirm Responses support`;
  const error = new Error(message);
  error.statusCode = 400;
  error.code = "ccdx_custom_tools_require_responses";
  error.jsonBody = {
    error: {
      message,
      type: "invalid_request_error",
      code: error.code,
      model,
    },
  };
  return error;
}

function resolveRequestModel(model, openAIModelEnv, autoReviewModelResolver) {
  const options = model === CODEX_AUTO_REVIEW_MODEL && typeof autoReviewModelResolver === "function"
    ? { autoReviewModel: autoReviewModelResolver() }
    : {};
  return resolveOpenAIModel(model, openAIModelEnv, options);
}

export function createResponsesHandler(options) {
  const {
    acquireRequest,
    autoReviewModelResolver,
    chatCompletionsFn,
    openAIModelEnv,
    responsesPayloadOptions,
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
      const { requestedModel, upstreamModel } = resolveRequestModel(model, openAIModelEnv, autoReviewModelResolver);
      if (upstreamModel !== requestedModel) prepared.body.model = upstreamModel;
      const upstreamLog = upstreamModel === requestedModel ? "" : ` upstream_model=${upstreamModel}`;
      console.log(status("info", `responses model=${requestedModel}${upstreamLog} stream=${!!parsed.stream}`));
      const usesCustomTools = responsesBodyUsesCustomTools(prepared.body);
      const useNativeResponses = requestedModel === CODEX_AUTO_REVIEW_MODEL
        || isResponsesOnlyModel(upstreamModel)
        || (usesCustomTools && cachedModelSupportsResponses(upstreamModel));
      if (usesCustomTools && !useNativeResponses) throw unsupportedCustomToolsError(upstreamModel);
      if (useNativeResponses) {
        await proxyCopilotResponses(prepared, req, res, responsesFn, {
          signal: abort.signal,
          abort,
          releaseRequest,
          streamIdleTimeoutMs,
        });
      } else {
        const chatPayload = await prepareResponsesChatPayload(prepared, {
          payloadOptions: responsesPayloadOptions,
          signal: abort.signal,
          stream: parsed.stream,
        });
        const { chatReq, bodyText } = chatPayload;
        if (parsed.stream) {
          let streamResponseHeaders = null;
          await forwardToChat(chatReq, async (event, data) => {
            if (!res.headersSent) res.writeHead(200, {
              ...streamResponseHeaders,
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            await writeOrDrain(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            if (event === "response.completed") {
              rememberResponseHistory(prepared, data.response);
              recordResponsesUsage({ surface: prepared.surface, mode: "stream", model, response: data.response, event: data });
            }
          }, () => { if (!res.writableEnded) res.end(); }, async (statusCode, errMsg, error, upstreamResponse) => {
            if (!res.headersSent) {
              if (upstreamResponse) {
                sendUpstreamError(res, upstreamResponse, errMsg);
                return;
              }
              const responseError = error || Object.assign(new Error(errMsg), { statusCode });
              sendJsonError(res, responseError, statusCode || 500);
              return;
            }
            await endStreamWithError(res, "responses", error || new Error(errMsg), abort);
          }, {
            signal: abort.signal,
            abort,
            streamIdleTimeoutMs,
            chatCompletionsFn,
            releaseRequest,
            bodyText,
            onUpstreamResponse: (upstreamResponse) => {
              streamResponseHeaders = safeUpstreamResponseHeaders(upstreamResponse.headers, {
                contentType: "text/event-stream",
              });
            },
          });
        } else {
          try {
            const upstream = await chatCompletionsFn(chatReq, { signal: abort.signal, bodyText });
            releaseRequest();
            const data = await upstream.text();
            if (!upstream.ok) {
              sendUpstreamError(res, upstream, data);
              return;
            }
            const response = chatToResponses(JSON.parse(data), model);
            rememberResponseHistory(prepared, response);
            recordResponsesUsage({ surface: prepared.surface, mode: "json", model, response, event: response });
            res.writeHead(200, safeUpstreamResponseHeaders(upstream.headers, {
              contentType: "application/json",
            }));
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
    autoReviewModelResolver,
    openAIModelEnv,
    responsesCompactFn,
    upstreamTimeoutMs,
  } = options;

  return async function handleResponsesCompact(req, res) {
    const abort = createRequestAbort(req, res);
    let releaseRequest = () => {};
    try {
      releaseRequest = await acquireRequest(req, { signal: abort.signal });
      const parsed = await readJsonBody(req);
      abort.setTimeout(upstreamTimeoutMs, "upstream_timeout");
      const prepared = prepareResponsesCompactionRequest(
        prepareResponsesRequest(parsed, { mutate: true }),
      );
      prepared.surface = "responses_compact";
      const model = parsed.model || "unknown";
      const { requestedModel, upstreamModel } = resolveRequestModel(model, openAIModelEnv, autoReviewModelResolver);
      if (upstreamModel !== requestedModel) prepared.body.model = upstreamModel;
      const upstreamLog = upstreamModel === requestedModel ? "" : ` upstream_model=${upstreamModel}`;
      console.log(status("info", `responses compact model=${requestedModel}${upstreamLog} stream=false`));
      await proxyCopilotResponses(prepared, req, res, responsesCompactFn, {
        signal: abort.signal,
        abort,
        releaseRequest,
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
