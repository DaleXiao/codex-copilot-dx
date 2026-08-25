import { getCachedModelEndpoints } from "./copilot.mjs";
import { applyCopilotResponsesRequestPolicies } from "./copilot-responses-policy.mjs";
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
import { clearResponsesToolOutputPartsCache } from "./responses-content.mjs";
import { proxyCopilotResponses } from "./responses-proxy.mjs";
import { responseHistoryMaterializedBytes } from "./response-history.mjs";
import {
  applyResponseHistoryRoutePlan,
  dropMaterializedResponseHistory,
  prepareResponsesRequest,
  rememberResponseHistory,
  responseHistoryPressureRootId,
} from "./responses-request.mjs";
import { createRoutePlan } from "./route-plan.mjs";
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

function isResponsesOnlyModel(model, getCachedModelEndpointsFn = getCachedModelEndpoints) {
  const endpoints = getCachedModelEndpointsFn(model);
  if (endpoints) {
    const fakeModel = { supported_endpoints: endpoints };
    if (modelSupportsChatCompletions(fakeModel)) return false;
    if (modelIsResponsesOnly(fakeModel)) return true;
  }
  return RESPONSES_ONLY_FALLBACK.has(model);
}

function cachedModelSupportsResponses(model, getCachedModelEndpointsFn = getCachedModelEndpoints) {
  const endpoints = getCachedModelEndpointsFn(model);
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
    getCachedModelEndpointsFn = getCachedModelEndpoints,
    imagePressure,
    openAIModelEnv,
    requestBodyTimeoutMs,
    responsesPayloadOptions,
    responsesFn,
    streamHandshakeTimeoutMs,
    streamIdleTimeoutMs,
    upstreamTimeoutMs,
  } = options;
  const now = options.now || Date.now;

  return async function handleResponses(req, res) {
    const abort = createRequestAbort(req, res);
    let releaseRequest = () => {};
    let prepared = null;
    let imagePressureResult = null;
    let parsed = null;
    let upstreamPayloadReleased = false;
    let activeDeadline = Number.POSITIVE_INFINITY;
    let activeTimeoutReason = "responses_prepare_timeout";
    const assertPrepareActive = () => {
      if (abort.signal.aborted) throw abort.signal.reason;
      if (now() < activeDeadline) return;
      abort.abort(activeTimeoutReason);
      throw abort.signal.reason;
    };
    const startUpstreamTimeout = () => {
      assertPrepareActive();
      const streaming = prepared?.body?.stream === true;
      const timeoutMs = streaming ? streamHandshakeTimeoutMs : upstreamTimeoutMs;
      activeTimeoutReason = streaming ? "stream_handshake_timeout" : "upstream_timeout";
      activeDeadline = now() + timeoutMs;
      abort.setTimeout(timeoutMs, activeTimeoutReason);
    };
    const applyAdaptiveTimeout = (error) => {
      if (!["responses_prepare_timeout", "stream_handshake_timeout", "upstream_timeout"].includes(abort.reason)) {
        return error;
      }
      const activated = imagePressure?.markTimeout?.(prepared?.historyRootId, {
        eligible: imagePressureResult?.pressureEligible === true,
      });
      if (!activated) return error;
      const message = "Responses timed out while processing a large visual history. Retry the request; ccdx will keep fewer earlier images automatically. Restart is not required.";
      error.statusCode = 504;
      error.jsonBody = {
        error: {
          message,
          type: "timeout_error",
          code: "ccdx_visual_history_timeout",
          retryable: true,
        },
      };
      return error;
    };
    const markAdaptiveHttpTimeout = (statusCode) => {
      if (statusCode !== 408) return false;
      return imagePressure?.markTimeout?.(responseHistoryPressureRootId(prepared), {
        eligible: imagePressureResult?.pressureEligible === true,
      }) || false;
    };
    const releaseUpstreamPayload = (finalContext) => {
      if (upstreamPayloadReleased) return;
      upstreamPayloadReleased = true;
      clearResponsesToolOutputPartsCache(prepared?.body?.input);
      clearResponsesToolOutputPartsCache(prepared?.historyInputItems);
      if (finalContext && finalContext !== prepared) {
        clearResponsesToolOutputPartsCache(finalContext.body?.input);
        clearResponsesToolOutputPartsCache(finalContext.historyInputItems);
      }
      if (finalContext && finalContext !== prepared) dropMaterializedResponseHistory(finalContext);
      dropMaterializedResponseHistory(prepared);
      releaseRequest();
    };
    try {
      releaseRequest = await acquireRequest(req, { signal: abort.signal });
      abort.setTimeout(requestBodyTimeoutMs, "request_body_timeout");
      parsed = await readJsonBody(req, { admission: releaseRequest, signal: abort.signal });
      activeDeadline = now() + upstreamTimeoutMs;
      activeTimeoutReason = "responses_prepare_timeout";
      abort.setTimeout(upstreamTimeoutMs, "responses_prepare_timeout");
      if (parsed.previous_response_id !== undefined && parsed.previous_response_id !== null) {
        const historyBytes = responseHistoryMaterializedBytes(parsed.previous_response_id);
        if (historyBytes > 0) {
          await releaseRequest.reserveResponseHistory?.(historyBytes, { signal: abort.signal });
        }
        assertPrepareActive();
      }
      prepared = prepareResponsesRequest(parsed, {
        assertActive: assertPrepareActive,
        copilotBoundary: false,
        mutate: true,
      });
      parsed = null;
      assertPrepareActive();
      imagePressureResult = imagePressure?.apply?.(prepared, { assertActive: assertPrepareActive }) || null;
      assertPrepareActive();
      if (imagePressureResult?.adapted) {
        console.warn(status("warn", `responses visual history mode=${imagePressureResult.mode} historical_images=${imagePressureResult.initialHistoricalImages}->${imagePressureResult.historicalImages} omitted=${imagePressureResult.imagesOmitted} bytes=${imagePressureResult.initialBodyBytes}->${imagePressureResult.bodyBytes}`));
      }
      prepared.surface = "responses";
      const model = prepared.body.model || "unknown";
      const streaming = prepared.body.stream === true;
      const { requestedModel, upstreamModel } = resolveRequestModel(model, openAIModelEnv, autoReviewModelResolver);
      if (upstreamModel !== requestedModel) prepared.body.model = upstreamModel;
      const upstreamLog = upstreamModel === requestedModel ? "" : ` upstream_model=${upstreamModel}`;
      console.log(status("info", `responses model=${requestedModel}${upstreamLog} stream=${streaming}`));
      const usesCustomTools = responsesBodyUsesCustomTools(prepared.body);
      const useNativeResponses = requestedModel === CODEX_AUTO_REVIEW_MODEL
        || isResponsesOnlyModel(upstreamModel, getCachedModelEndpointsFn)
        || (usesCustomTools && cachedModelSupportsResponses(upstreamModel, getCachedModelEndpointsFn));
      if (usesCustomTools && !useNativeResponses) throw unsupportedCustomToolsError(upstreamModel);
      const routePlan = createRoutePlan({
        disposition: "relay",
        origin: "ccdx",
        profile: "codex",
        protocol: useNativeResponses ? "openai-responses" : "openai-chat-completions",
        model: upstreamModel,
        surface: "responses",
      });
      prepared = applyResponseHistoryRoutePlan(prepared, routePlan);
      applyCopilotResponsesRequestPolicies(prepared.body);
      if (routePlan.protocol === "openai-responses") {
        const result = await proxyCopilotResponses(prepared, req, res, responsesFn, {
          assertPrepareActive,
          signal: abort.signal,
          abort,
          onUpstreamStart: startUpstreamTimeout,
          releaseRequest: releaseUpstreamPayload,
          streamIdleTimeoutMs,
        });
        if (result?.successful) imagePressure?.markSuccess?.(responseHistoryPressureRootId(prepared));
        else markAdaptiveHttpTimeout(result?.upstreamStatus);
      } else if (routePlan.protocol === "openai-chat-completions") {
        let { chatReq, bodyText } = await prepareResponsesChatPayload(prepared, {
          assertActive: assertPrepareActive,
          payloadOptions: responsesPayloadOptions,
          signal: abort.signal,
          stream: streaming,
        });
        const releaseChatPayload = () => {
          chatReq = undefined;
          bodyText = undefined;
          releaseUpstreamPayload();
        };
        if (streaming) {
          let streamResponseHeaders = null;
          const successful = await forwardToChat(chatReq, async (event, data) => {
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
                markAdaptiveHttpTimeout(upstreamResponse.status);
                sendUpstreamError(res, upstreamResponse, errMsg);
                return;
              }
              const responseError = applyAdaptiveTimeout(error || Object.assign(new Error(errMsg), { statusCode }));
              sendJsonError(res, responseError, statusCode || 500);
              return;
            }
            await endStreamWithError(res, "responses", error || new Error(errMsg), abort);
          }, {
            signal: abort.signal,
            abort,
            onUpstreamStart: startUpstreamTimeout,
            streamIdleTimeoutMs,
            chatCompletionsFn,
            releaseRequest: releaseChatPayload,
            bodyText,
            onUpstreamResponse: (upstreamResponse) => {
              streamResponseHeaders = safeUpstreamResponseHeaders(upstreamResponse.headers, {
                contentType: "text/event-stream",
              });
            },
          });
          if (successful) imagePressure?.markSuccess?.(responseHistoryPressureRootId(prepared));
        } else {
          try {
            startUpstreamTimeout();
            const upstream = await chatCompletionsFn(chatReq, {
              signal: abort.signal,
              bodyText,
              onUpstreamStart: startUpstreamTimeout,
            });
            releaseChatPayload();
            const data = await upstream.text();
            if (!upstream.ok) {
              markAdaptiveHttpTimeout(upstream.status);
              sendUpstreamError(res, upstream, data);
              return;
            }
            const response = chatToResponses(JSON.parse(data), model);
            rememberResponseHistory(prepared, response);
            imagePressure?.markSuccess?.(responseHistoryPressureRootId(prepared));
            recordResponsesUsage({ surface: prepared.surface, mode: "json", model, response, event: response });
            res.writeHead(200, safeUpstreamResponseHeaders(upstream.headers, {
              contentType: "application/json",
            }));
            res.end(JSON.stringify(response));
          } catch (error) {
            const responseError = applyAdaptiveTimeout(error);
            logRequestFailure("Responses", responseError, abort);
            sendJsonError(res, responseError, 502);
          }
        }
      } else {
        throw new Error(`Unsupported Responses target protocol: ${routePlan.protocol}`);
      }
    } catch (error) {
      const responseError = applyAdaptiveTimeout(error);
      logRequestFailure("Responses", responseError, abort);
      sendJsonError(res, responseError, 502);
    } finally {
      releaseUpstreamPayload();
      abort.cleanup();
    }
  };
}

export function createResponsesCompactHandler(options) {
  const {
    acquireRequest,
    autoReviewModelResolver,
    imagePressure,
    openAIModelEnv,
    requestBodyTimeoutMs,
    responsesCompactFn,
    upstreamTimeoutMs,
  } = options;
  const now = options.now || Date.now;

  return async function handleResponsesCompact(req, res) {
    const abort = createRequestAbort(req, res);
    let releaseRequest = () => {};
    let prepared = null;
    let upstreamPayloadReleased = false;
    const releaseUpstreamPayload = (finalContext) => {
      if (upstreamPayloadReleased) return;
      upstreamPayloadReleased = true;
      clearResponsesToolOutputPartsCache(prepared?.body?.input);
      clearResponsesToolOutputPartsCache(prepared?.historyInputItems);
      if (finalContext && finalContext !== prepared) {
        clearResponsesToolOutputPartsCache(finalContext.body?.input);
        clearResponsesToolOutputPartsCache(finalContext.historyInputItems);
      }
      releaseRequest();
    };
    try {
      releaseRequest = await acquireRequest(req, { signal: abort.signal });
      abort.setTimeout(requestBodyTimeoutMs, "request_body_timeout");
      const parsed = await readJsonBody(req, { admission: releaseRequest, signal: abort.signal });
      let activeDeadline = now() + upstreamTimeoutMs;
      let activeTimeoutReason = "responses_prepare_timeout";
      const assertPrepareActive = () => {
        if (abort.signal.aborted) throw abort.signal.reason;
        if (now() < activeDeadline) return;
        abort.abort(activeTimeoutReason);
        throw abort.signal.reason;
      };
      const startUpstreamTimeout = () => {
        assertPrepareActive();
        activeDeadline = now() + upstreamTimeoutMs;
        activeTimeoutReason = "upstream_timeout";
        abort.setTimeout(upstreamTimeoutMs, "upstream_timeout");
      };
      abort.setTimeout(upstreamTimeoutMs, "responses_prepare_timeout");
      if (parsed.previous_response_id !== undefined && parsed.previous_response_id !== null) {
        const historyBytes = responseHistoryMaterializedBytes(parsed.previous_response_id);
        if (historyBytes > 0) {
          await releaseRequest.reserveResponseHistory?.(historyBytes, { signal: abort.signal });
        }
        assertPrepareActive();
      }
      prepared = prepareResponsesCompactionRequest(
        prepareResponsesRequest(parsed, {
          assertActive: assertPrepareActive,
          copilotBoundary: false,
          mutate: true,
        }),
      );
      assertPrepareActive();
      prepared.surface = "responses_compact";
      const model = parsed.model || "unknown";
      const { requestedModel, upstreamModel } = resolveRequestModel(model, openAIModelEnv, autoReviewModelResolver);
      if (upstreamModel !== requestedModel) prepared.body.model = upstreamModel;
      const upstreamLog = upstreamModel === requestedModel ? "" : ` upstream_model=${upstreamModel}`;
      console.log(status("info", `responses compact model=${requestedModel}${upstreamLog} stream=false`));
      prepared = applyResponseHistoryRoutePlan(prepared, createRoutePlan({
        disposition: "relay",
        origin: "ccdx",
        profile: "codex",
        protocol: "openai-responses",
        model: upstreamModel,
        surface: "responses-compact",
      }));
      applyCopilotResponsesRequestPolicies(prepared.body);
      const result = await proxyCopilotResponses(prepared, req, res, responsesCompactFn, {
        assertPrepareActive,
        signal: abort.signal,
        abort,
        onUpstreamStart: startUpstreamTimeout,
        releaseRequest: releaseUpstreamPayload,
      });
      if (result?.compacted) imagePressure?.clear?.(responseHistoryPressureRootId(prepared));
    } catch (error) {
      logRequestFailure("Responses compact", error, abort);
      sendJsonError(res, error, 502);
    } finally {
      releaseUpstreamPayload();
      abort.cleanup();
    }
  };
}
