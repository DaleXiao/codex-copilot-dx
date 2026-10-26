import { defaultGithubProvider } from "./providers/github.mjs";
import {
  createRequestAbort,
  logRequestFailure,
  MAX_DECODED_BODY_BYTES,
  MAX_UPSTREAM_CHAT_SUCCESS_BODY_BYTES,
  MAX_UPSTREAM_ERROR_BODY_BYTES,
  readJsonBody,
  readBoundedResponseText,
  sendJsonError,
  sendUpstreamError,
  writeOrDrain,
} from "./http-transport.mjs";
import {
  CODEX_AUTO_REVIEW_MODEL,
  modelContextWindowTokens,
  resolveOpenAIModel,
} from "./models.mjs";
import { chatToResponses, forwardToChat } from "./responses-bridge.mjs";
import { prepareResponsesChatPayload } from "./responses-chat-payload.mjs";
import { prepareResponsesCompactionRequest } from "./responses-compaction.mjs";
import { clearResponsesToolOutputPartsCache } from "./responses-content.mjs";
import { proxyCopilotResponses } from "./responses-proxy.mjs";
import { acquireResponseHistorySnapshot } from "./response-history.mjs";
import {
  applyResponseHistoryRoutePlan,
  dropMaterializedResponseHistory,
  prepareResponsesRequest,
  rememberResponseHistory,
  responseHistoryPressureRootId,
} from "./responses-request.mjs";
import { status } from "./status.mjs";
import { observeRequestedModel } from "./request-context.mjs";
import { endStreamWithError } from "./stream-errors.mjs";
import { createSseKeepalive } from "./sse-keepalive.mjs";
import { safeUpstreamResponseHeaders } from "./upstream-headers.mjs";
import { recordResponsesUsage } from "./usage-store.mjs";
import {
  markResponseErrorOrigin,
  markResponseModel,
  markRequestObservation,
  markResponseTerminal,
  markUpstreamHeaders,
  measureRequestStage,
  measureRequestStageAsync,
} from "./stream-performance.mjs";

function resolveRequestModel(model, openAIModelEnv, autoReviewModelResolver) {
  const preference = model === CODEX_AUTO_REVIEW_MODEL && typeof autoReviewModelResolver === "function"
    ? autoReviewModelResolver() : undefined;
  const resolved = resolveOpenAIModel(model, openAIModelEnv, {
    autoReviewModel: typeof preference === "string" ? preference : preference?.model,
  });
  return { ...resolved, reasoningEffort: preference?.model === resolved.upstreamModel
    ? preference.reasoningEffort : undefined };
}

function applySelectedRoute(prepared, routePlan, options) {
  try { return applyResponseHistoryRoutePlan(prepared, routePlan); }
  catch (error) {
    if (error.code !== "ccdx_provider_history_rebuild_required") throw error;
    return recoverSelectedRoute(prepared, routePlan, error, options);
  }
}

async function recoverSelectedRoute(prepared, routePlan, error, { req, env, signal, assertActive, reserveHistory }) {
  try {
    const { recoverLocalCompaction } = await import("./local-compaction-recovery.mjs");
    const restored = await recoverLocalCompaction(prepared, { request: req, env, signal, assertActive, reserveHistory, maxBytes: MAX_DECODED_BODY_BYTES });
    return applyResponseHistoryRoutePlan(restored, routePlan);
  } catch (failure) {
    assertActive?.();
    error.jsonBody.error.recovery.local_status = /^[a-z][a-z_]{1,60}$/.test(failure.code || "") ? failure.code : "local_history_unavailable";
    throw error;
  }
}

export function createResponsesHandler(options) {
  const provider = options.provider || defaultGithubProvider;
  const {
    acquireRequest,
    autoReviewModelResolver,
    chatCompletionsFn,
    getCachedModelEndpointsFn = provider.client.getCachedModelEndpoints,
    imagePressure,
    keepaliveIntervalMs,
    modelRegistry,
    openAIModelEnv,
    requestBodyTimeoutMs,
    responsesPayloadOptions,
    responsesFn,
    responseFailures,
    streamHandshakeTimeoutMs,
    streamIdleTimeoutMs,
    upstreamTimeoutMs,
  } = options;
  const now = options.now || Date.now;

  return async function handleResponses(req, res) {
    let provider = options.provider || defaultGithubProvider;
    let { modelRegistry, responsesFn, responsesCompactFn, chatCompletionsFn, autoReviewModelResolver, openAIModelEnv } = options;
    let getCachedModelEndpointsFn = options.getCachedModelEndpointsFn || provider.client.getCachedModelEndpoints;
    const abort = createRequestAbort(req, res);
    let releaseRequest = () => {};
    let prepared = null;
    let imagePressureResult = null;
    let historySnapshot = null;
    let parsed = null;
    let upstreamPayloadReleased = false;
    let activeDeadline = Number.POSITIVE_INFINITY;
    let activeTimeoutReason = "responses_prepare_timeout";
    const releaseHistorySnapshot = () => {
      historySnapshot?.release();
      historySnapshot = null;
    };
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
    const startStream = () => {
      assertPrepareActive();
      // Headers completed this phase. Stream liveness is now governed by its
      // idle timer, not the original handshake deadline.
      activeDeadline = Number.POSITIVE_INFINITY;
    };
    const acquireRetryPreparation = async (reqContext) => {
      assertPrepareActive();
      activeDeadline = now() + upstreamTimeoutMs;
      activeTimeoutReason = "responses_prepare_timeout";
      abort.setTimeout(upstreamTimeoutMs, activeTimeoutReason);
      let releaseRetryRequest = () => {};
      let retrySnapshot = null;
      const release = () => {
        retrySnapshot?.release();
        releaseRetryRequest();
      };
      try {
        releaseRetryRequest = await measureRequestStageAsync("admission", () => acquireRequest(req, { signal: abort.signal }));
        assertPrepareActive();
        if (reqContext.historyParentId) {
          retrySnapshot = measureRequestStage("history", () => acquireResponseHistorySnapshot(reqContext.historyParentId, {
            assertActive: assertPrepareActive,
            signal: abort.signal,
          }));
          if (retrySnapshot.bytes > 0) {
            await measureRequestStageAsync("admission", () => releaseRetryRequest.reserveResponseHistory?.(retrySnapshot.bytes, { signal: abort.signal }));
          }
        }
        assertPrepareActive();
        return { historySnapshot: retrySnapshot, reserveHistory: releaseRetryRequest.reserveResponseHistory, release };
      } catch (error) {
        release();
        throw error;
      }
    };
    const applyAdaptiveTimeout = (error) => {
      if (!["responses_prepare_timeout", "stream_handshake_timeout", "upstream_timeout"].includes(abort.reason)) {
        return error;
      }
      const activated = imagePressure?.markTimeout?.(responseHistoryPressureRootId(prepared), {
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
      if (finalContext?.historyParentId === null) releaseHistorySnapshot();
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
      releaseRequest = await measureRequestStageAsync("admission", () => acquireRequest(req, { signal: abort.signal }));
      abort.setTimeout(requestBodyTimeoutMs, "request_body_timeout");
      parsed = await measureRequestStageAsync("body", () => readJsonBody(req, { admission: releaseRequest, signal: abort.signal }));
      observeRequestedModel(parsed);
      markRequestObservation({ max_output_tokens_requested: parsed?.max_output_tokens });
      const selectedProvider = options.resolveProvider?.(parsed, req);
      if (selectedProvider) {
        provider = selectedProvider;modelRegistry = provider.registry;
        responsesFn = provider.client.responses;responsesCompactFn = provider.client.responsesCompact;chatCompletionsFn = provider.client.chatCompletions;
        getCachedModelEndpointsFn = provider.client.getCachedModelEndpoints;
        autoReviewModelResolver = () => options.providerPreference?.(provider.id);
        if (provider.id !== "github") openAIModelEnv = { ...openAIModelEnv, CCDX_AUTO_REVIEW_MODEL: "" };
      }
      options.validateConversation?.(parsed, req.headers, provider);
      activeDeadline = now() + upstreamTimeoutMs;
      activeTimeoutReason = "responses_prepare_timeout";
      abort.setTimeout(upstreamTimeoutMs, "responses_prepare_timeout");
      if (parsed.previous_response_id !== undefined && parsed.previous_response_id !== null) {
        historySnapshot = measureRequestStage("history", () => acquireResponseHistorySnapshot(parsed.previous_response_id, {
          assertActive: assertPrepareActive,
          signal: abort.signal,
        }));
        if (historySnapshot.bytes > 0) {
          await measureRequestStageAsync("admission", () => releaseRequest.reserveResponseHistory?.(historySnapshot.bytes, { signal: abort.signal }));
        }
        assertPrepareActive();
      }
      prepared = measureRequestStage("history", () => prepareResponsesRequest(parsed, {
        assertActive: assertPrepareActive,
        copilotBoundary: false,
        historySnapshot,
        mutate: true,
      }));
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
      const resolvedModel = resolveRequestModel(model, openAIModelEnv, autoReviewModelResolver);
      const { requestedModel } = resolvedModel;
      const { upstreamModel, forceResponses } = provider.selectModel(prepared.body, resolvedModel, modelRegistry?.models);
      if (requestedModel === CODEX_AUTO_REVIEW_MODEL) {
        delete prepared.body.service_tier;
        if (resolvedModel.reasoningEffort || provider.defaultReviewEffort !== null && prepared.body.reasoning?.effort === undefined) {
          prepared.body.reasoning = { ...prepared.body.reasoning, effort: resolvedModel.reasoningEffort || "low" };
        }
      }
      if (upstreamModel !== requestedModel) prepared.body.model = upstreamModel;
      markResponseModel(upstreamModel, { requestedModel, configuredModel: provider.configuredModels === true });
      markRequestObservation({ context_window_tokens: modelContextWindowTokens(modelRegistry?.models, upstreamModel) });
      const upstreamLog = upstreamModel === requestedModel ? "" : ` upstream_model=${upstreamModel}`;
      console.log(status("info", `responses model=${requestedModel}${upstreamLog} stream=${streaming}`));
      const routePlan = provider.route(prepared.body, { requestedModel, upstreamModel, forceResponses,
        surface: "responses", getCachedModelEndpoints: getCachedModelEndpointsFn });
      const selected = applySelectedRoute(prepared, routePlan, { req, env: openAIModelEnv, signal: abort.signal,
        assertActive: assertPrepareActive, reserveHistory: releaseRequest.reserveResponseHistory });
      prepared = selected instanceof Promise ? await selected : selected;
      if (prepared.historyParentId === null) releaseHistorySnapshot();
      provider.applyRequestPolicies(prepared.body);
      if (routePlan.protocol === "openai-responses") {
        const restorePlaintextHistory = async (context, { reserveHistory } = {}) => {
          assertPrepareActive();
          const { recoverLocalCompaction } = await import("./local-compaction-recovery.mjs");
          return recoverLocalCompaction(context, { request: req, env: openAIModelEnv,
            signal: abort.signal, assertActive: assertPrepareActive, reserveHistory, maxBytes: MAX_DECODED_BODY_BYTES });
        };
        const result = await proxyCopilotResponses(prepared, req, res, responsesFn, {
          compatibility: provider.compatibility,
          acquireRetryPreparation,
          assertPrepareActive,
          signal: abort.signal,
          abort,
          onUpstreamStart: startUpstreamTimeout,
          onStreamStart: startStream,
          releaseRequest: releaseUpstreamPayload,
          responseFailures,
          restorePlaintextHistory,
          reserveHistory: releaseRequest.reserveResponseHistory,
          streamIdleTimeoutMs,
          keepaliveIntervalMs,
        });
        if (result?.successful) imagePressure?.markSuccess?.(responseHistoryPressureRootId(prepared));
        else markAdaptiveHttpTimeout(result?.upstreamStatus);
      } else if (routePlan.protocol === "openai-chat-completions") {
        let { chatReq, bodyText } = await prepareResponsesChatPayload(prepared, {
          assertActive: assertPrepareActive,
          payloadOptions: responsesPayloadOptions,
          reasoningEfforts: (Array.isArray(modelRegistry?.models) ? modelRegistry.models : modelRegistry?.models?.data)
            ?.find(model => model?.id === upstreamModel)?.capabilities?.supports?.reasoning_effort,
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
          const keepalive = createSseKeepalive({ res, signal: abort.signal, intervalMs: keepaliveIntervalMs });
          let successful;
          try { successful = await forwardToChat(chatReq, async (event, data) => {
            if (!res.headersSent) res.writeHead(200, {
              ...streamResponseHeaders,
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            keepalive.activity();
            const written = await writeOrDrain(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, { signal: abort.signal });
            if (!written) return false;
            if (event === "response.completed" || event === "response.incomplete") {
              if (event === "response.completed") rememberResponseHistory(prepared, data.response);
              recordResponsesUsage({ surface: prepared.surface, mode: "stream", model, response: data.response, event: data });
            }
            return true;
          }, () => { if (!res.writableEnded) res.end(); }, async (statusCode, errMsg, error, upstreamResponse) => {
            if (!res.headersSent) {
              if (upstreamResponse) {
                markResponseErrorOrigin("upstream_http");
                markAdaptiveHttpTimeout(upstreamResponse.status);
                sendUpstreamError(res, upstreamResponse, errMsg);
                return;
              }
              const responseError = applyAdaptiveTimeout(error || Object.assign(new Error(errMsg), { statusCode }));
              markResponseErrorOrigin("transport");
              sendJsonError(res, responseError, statusCode || 500);
              return;
            }
            await endStreamWithError(res, error || new Error(errMsg), abort);
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
          }); } finally { keepalive.stop(); }
          if (successful) imagePressure?.markSuccess?.(responseHistoryPressureRootId(prepared));
        } else {
          try {
            startUpstreamTimeout();
            const upstream = await chatCompletionsFn(chatReq, {
              signal: abort.signal,
              bodyText,
              onUpstreamStart: startUpstreamTimeout,
            });
            markUpstreamHeaders(upstream.status);
            releaseChatPayload();
            const data = upstream.ok
              ? await readBoundedResponseText(upstream, {
                maxBytes: MAX_UPSTREAM_CHAT_SUCCESS_BODY_BYTES,
                label: "Copilot Chat success body",
                signal: abort.signal,
              })
              : await readBoundedResponseText(upstream, {
                maxBytes: MAX_UPSTREAM_ERROR_BODY_BYTES,
                label: "Copilot Chat error body",
              });
            if (!upstream.ok) {
              markResponseErrorOrigin("upstream_http");
              markAdaptiveHttpTimeout(upstream.status);
              sendUpstreamError(res, upstream, data);
              return;
            }
            const response = chatToResponses(JSON.parse(data), model);
            markResponseTerminal(response.status, {
              model: response.model || model, origin: "chat_completion", reason: response.incomplete_details?.reason,
            });
            rememberResponseHistory(prepared, response);
            if (response.status === "completed") imagePressure?.markSuccess?.(responseHistoryPressureRootId(prepared));
            recordResponsesUsage({ surface: prepared.surface, mode: "json", model, response, event: response });
            res.writeHead(200, safeUpstreamResponseHeaders(upstream.headers, {
              contentType: "application/json",
            }));
            res.end(JSON.stringify(response));
          } catch (error) {
            const responseError = applyAdaptiveTimeout(error);
            markResponseErrorOrigin(responseError?.statusCode >= 400 && responseError.statusCode < 500
              ? "client_validation" : "transport");
            logRequestFailure("Responses", responseError, abort);
            sendJsonError(res, responseError, 502);
          }
        }
      } else {
        throw new Error(`Unsupported Responses target protocol: ${routePlan.protocol}`);
      }
    } catch (error) {
      const responseError = applyAdaptiveTimeout(error);
      markResponseErrorOrigin(responseError?.statusCode >= 400 && responseError.statusCode < 500
        ? "client_validation" : "transport");
      logRequestFailure("Responses", responseError, abort);
      sendJsonError(res, responseError, 502);
    } finally {
      releaseUpstreamPayload();
      releaseHistorySnapshot();
      abort.cleanup();
    }
  };
}

export function createResponsesCompactHandler(options) {
  const provider = options.provider || defaultGithubProvider;
  const {
    acquireRequest,
    autoReviewModelResolver,
    imagePressure,
    modelRegistry,
    openAIModelEnv,
    requestBodyTimeoutMs,
    responsesCompactFn,
    upstreamTimeoutMs,
  } = options;
  const now = options.now || Date.now;

  return async function handleResponsesCompact(req, res) {
    let provider = options.provider || defaultGithubProvider;
    let { modelRegistry, responsesFn, responsesCompactFn, chatCompletionsFn, autoReviewModelResolver, openAIModelEnv } = options;
    let getCachedModelEndpointsFn = options.getCachedModelEndpointsFn || provider.client.getCachedModelEndpoints;
    const abort = createRequestAbort(req, res);
    let releaseRequest = () => {};
    let prepared = null;
    let imagePressureResult = null;
    let historySnapshot = null;
    let upstreamPayloadReleased = false;
    let activeDeadline = Number.POSITIVE_INFINITY;
    let activeTimeoutReason = "responses_prepare_timeout";
    const releaseHistorySnapshot = () => {
      historySnapshot?.release();
      historySnapshot = null;
    };
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
    const pressureRootId = () => responseHistoryPressureRootId(prepared);
    const markCompactTimeout = () => {
      const eligible = imagePressure?.isEligible?.(prepared) === true;
      return imagePressure?.markTimeout?.(pressureRootId(), { eligible }) || false;
    };
    const applyAdaptiveTimeout = (error) => {
      if (!["responses_prepare_timeout", "upstream_timeout"].includes(abort.reason)) return error;
      if (!markCompactTimeout()) return error;
      const message = "Responses compact timed out while processing a large visual history. Retry the request; ccdx will keep fewer earlier images automatically. Restart is not required.";
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
      releaseRequest = await measureRequestStageAsync("admission", () => acquireRequest(req, { signal: abort.signal }));
      abort.setTimeout(requestBodyTimeoutMs, "request_body_timeout");
      const parsed = await measureRequestStageAsync("body", () => readJsonBody(req, { admission: releaseRequest, signal: abort.signal }));
      observeRequestedModel(parsed);
      markRequestObservation({ max_output_tokens_requested: parsed?.max_output_tokens });
      const selectedProvider = options.resolveProvider?.(parsed, req);
      if (selectedProvider) {
        provider = selectedProvider;modelRegistry = provider.registry;
        responsesFn = provider.client.responses;responsesCompactFn = provider.client.responsesCompact;chatCompletionsFn = provider.client.chatCompletions;
        getCachedModelEndpointsFn = provider.client.getCachedModelEndpoints;
        autoReviewModelResolver = () => options.providerPreference?.(provider.id);
        if (provider.id !== "github") openAIModelEnv = { ...openAIModelEnv, CCDX_AUTO_REVIEW_MODEL: "" };
      }
      options.validateConversation?.(parsed, req.headers, provider);
      activeDeadline = now() + upstreamTimeoutMs;
      activeTimeoutReason = "responses_prepare_timeout";
      abort.setTimeout(upstreamTimeoutMs, "responses_prepare_timeout");
      if (parsed.previous_response_id !== undefined && parsed.previous_response_id !== null) {
        historySnapshot = measureRequestStage("history", () => acquireResponseHistorySnapshot(parsed.previous_response_id, {
          assertActive: assertPrepareActive,
          signal: abort.signal,
        }));
        if (historySnapshot.bytes > 0) {
          await measureRequestStageAsync("admission", () => releaseRequest.reserveResponseHistory?.(historySnapshot.bytes, { signal: abort.signal }));
        }
        assertPrepareActive();
      }
      prepared = measureRequestStage("history", () => prepareResponsesRequest(parsed, {
        assertActive: assertPrepareActive,
        copilotBoundary: false,
        historySnapshot,
        mutate: true,
      }));
      imagePressureResult = imagePressure?.applyRecovery?.(prepared, { assertActive: assertPrepareActive }) || null;
      if (imagePressureResult?.adapted) {
        console.warn(status("warn", `responses compact visual history mode=recovery historical_images=${imagePressureResult.initialHistoricalImages}->${imagePressureResult.historicalImages} omitted=${imagePressureResult.imagesOmitted} bytes=${imagePressureResult.initialBodyBytes}->${imagePressureResult.bodyBytes}`));
      }
      prepared = measureRequestStage("history", () => prepareResponsesCompactionRequest(prepared));
      assertPrepareActive();
      prepared.surface = "responses_compact";
      const model = parsed.model || "unknown";
      const resolvedModel = resolveRequestModel(model, openAIModelEnv, autoReviewModelResolver);
      const { requestedModel } = resolvedModel;
      const { upstreamModel, forceResponses } = provider.selectModel(prepared.body, resolvedModel, modelRegistry?.models);
      if (requestedModel === CODEX_AUTO_REVIEW_MODEL) {
        delete prepared.body.service_tier;
        if (resolvedModel.reasoningEffort || provider.defaultReviewEffort !== null && prepared.body.reasoning?.effort === undefined) {
          prepared.body.reasoning = { ...prepared.body.reasoning, effort: resolvedModel.reasoningEffort || "low" };
        }
      }
      if (upstreamModel !== requestedModel) prepared.body.model = upstreamModel;
      markRequestObservation({ context_window_tokens: modelContextWindowTokens(modelRegistry?.models, upstreamModel) });
      const upstreamLog = upstreamModel === requestedModel ? "" : ` upstream_model=${upstreamModel}`;
      console.log(status("info", `responses compact model=${requestedModel}${upstreamLog} stream=false`));
      markResponseModel(upstreamModel, { requestedModel, configuredModel: provider.configuredModels === true });
      const selected = applySelectedRoute(prepared, provider.route(prepared.body, {
        requestedModel, upstreamModel, forceResponses, surface: "responses-compact" }), { req, env: openAIModelEnv,
        signal: abort.signal, assertActive: assertPrepareActive, reserveHistory: releaseRequest.reserveResponseHistory });
      prepared = selected instanceof Promise ? await selected : selected;
      releaseHistorySnapshot();
      provider.applyRequestPolicies(prepared.body);
      const result = await proxyCopilotResponses(prepared, req, res, responsesCompactFn, {
        compatibility: provider.compatibility,
        assertPrepareActive,
        signal: abort.signal,
        abort,
        onUpstreamStart: startUpstreamTimeout,
        releaseRequest: releaseUpstreamPayload,
      });
      if (result?.compacted) imagePressure?.clear?.(responseHistoryPressureRootId(prepared));
      else if (result?.upstreamStatus === 408) markCompactTimeout();
    } catch (error) {
      const responseError = applyAdaptiveTimeout(error);
      logRequestFailure("Responses compact", responseError, abort);
      sendJsonError(res, responseError, 502);
    } finally {
      releaseUpstreamPayload();
      releaseHistorySnapshot();
      abort.cleanup();
    }
  };
}
