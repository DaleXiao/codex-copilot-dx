import http from "node:http";
import { defaultCopilotClient } from "./copilot.mjs";
import { buildCodexModelResponse } from "./codex-model-catalog.mjs";
import { isValidModelList } from "./model-cache.mjs";
import {
  ADAPTER_STATUS_PATH,
  classifyAdapterRoute,
  createRequestMetrics,
  runtimeStatusPayload,
} from "./observability.mjs";
import { createRequestId, runWithRequestContext, currentRequestContext } from "./request-context.mjs";
import { requestApplication } from "./request-application.mjs";
import { createStreamPerformanceMetrics } from "./stream-performance.mjs";
import { status } from "./status.mjs";
import { exportResponseHistory, importResponseHistory } from "./response-history.mjs";
import { createTerminalActivityIndicator } from "./terminal-activity.mjs";
import { ADAPTER_HEALTH_PATH, ADAPTER_PREDICTION_FIX_PATH } from "./running-adapter.mjs";
import { createManagementHandler, isManagementRoute } from "./management-routes.mjs";
import { createOptionalRoutes, isOptionalRoute, DASHBOARD_PATHS, DASHBOARD_API_PATHS } from "./optional-routes.mjs";
import { createResponsesCompactHandler, createResponsesHandler } from "./responses-handler.mjs";
import { createResponsesImagePressureController } from "./responses-image-pressure.mjs";
import { createResponseFailureDiagnostics, createHttpFailureDiagnostics, buildHttpFailureDetails } from "./response-failures.mjs";
import { ADAPTER_CACHE_PATH } from "./cache-control.mjs";
import { loadRuntimeConfig, parsePositiveInteger } from "./runtime-config.mjs";
import {
  createRequestAbort,
  logRequestFailure,
  sendJsonError,
} from "./http-transport.mjs";
import { httpError } from "./http-errors.mjs";
import { createRequestAdmission } from "./request-admission.mjs";
import { PROVIDER_MANAGEMENT_PATH, handleProviderManagement } from "./provider-management.mjs";
import { isLoopbackAddress, isLoopbackHostHeader } from "./security.mjs";

export {
  abortErrorStatusCode,
  createRequestAdmission,
  createRequestAbort,
  isAbortLikeError,
  readJsonBody,
  writeOrDrain,
} from "./http-transport.mjs";
export {
  clearResponseHistoryForTests,
  configureResponseHistoryForTests,
  responseHistoryStats,
} from "./response-history.mjs";
export { forwardToChat, responsesToChat } from "./responses-bridge.mjs";
export {
  openCopilotResponse,
} from "./copilot-responses-compat.mjs";
export {
  isEncryptedContentVerificationError,
  isImageNamespaceCollisionError,
  sanitizeImageNamespaceCollisionRequest,
} from "./copilot-responses-policy.mjs";
export {
  prepareResponsesRequest,
  rememberResponseHistory,
  sanitizeEncryptedReasoningRequest,
  stripInternalResponsesInputFields,
} from "./responses-request.mjs";

const ADAPTER_RUNTIME_CONFIG = loadRuntimeConfig();

export function requestPath(reqUrl) {
  return new URL(reqUrl || "/", "http://localhost").pathname;
}

function sendRetiredClaudeSurface(res) {
  res.writeHead(410, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({
    type: "error",
    error: {
      type: "not_found_error",
      code: "ccdx_claude_retired",
      message: "The GitHub Claude endpoint was retired in ccdx 0.7.0. Microsoft 365 Claude uses the separate gateway; run ccdx m365 status.",
    },
  }));
}

function modelListCanUseLastKnownGood(statusCode) {
  return [408, 425, 429].includes(statusCode) || statusCode >= 500;
}

function modelClientVersion(reqUrl) {
  try {
    return String(new URL(reqUrl || "/", "http://localhost").searchParams.get("client_version") || "").trim();
  } catch {
    return "";
  }
}

async function sendModelList(res, models, {
  codexModelCatalog,
  clientVersion = "",
  headers = {},
  rawBody,
  statusCode = 200,
  restrictToUpstream = false,
  providerCatalog,
} = {}) {
  let body = rawBody || JSON.stringify(models);
  if (clientVersion && typeof providerCatalog === "function") {
    const catalog = providerCatalog.needsNativeCatalog && codexModelCatalog?.load ? await codexModelCatalog.load({ clientVersion }) : null;
    body = JSON.stringify(providerCatalog(models, catalog));
  }
  else if (clientVersion && typeof codexModelCatalog?.load === "function") {
    let response = null;
    try {
      const codexCatalog = await codexModelCatalog.load({ clientVersion });
      response = buildCodexModelResponse({ copilotModels: models, codexCatalog, restrictToUpstream });
    } catch {}
    if (!response) {
      if (res.destroyed || res.writableEnded) return false;
      res.writeHead(503, {
        "Content-Type": "application/json",
        "Retry-After": "5",
        ...headers,
      });
      res.end(JSON.stringify({
        error: {
          message: "The Codex App model catalog is temporarily unavailable",
          type: "server_error",
          code: "ccdx_codex_model_catalog_unavailable",
        },
      }));
      return true;
    }
    body = JSON.stringify(response);
  }
  if (res.destroyed || res.writableEnded) return false;
  res.writeHead(statusCode, { "Content-Type": "application/json", ...headers });
  res.end(body);
  return true;
}

async function sendLastKnownGoodModels(res, modelRegistry, options = {}) {
  if (!isValidModelList(modelRegistry?.models) || res.destroyed || res.writableEnded) return false;
  await sendModelList(res, modelRegistry.models, {
    ...options,
    headers: { "X-CCDX-Model-Source": "last-known-good" },
  });
  return true;
}

// Shared request handler. Keeping this separate from the listener makes the
// complete HTTP routing layer testable without opening a local port.
export function createAdapterHandler(options = {}) {
  const codexClient = options.codexClient || defaultCopilotClient;
  // Keep the established injection names because Responses may still use the
  // internal Chat Completions compatibility path for upstream models that need it.
  const chatCompletionsFn = options.codexChatCompletionsFn
    || options.chatCompletionsFn
    || codexClient.chatCompletions;
  const responsesFn = options.responsesFn || codexClient.responses;
  const responsesCompactFn = options.responsesCompactFn || codexClient.responsesCompact;
  const listModelsFn = options.listModelsFn || codexClient.listModels;
  const codexModelCatalog = options.codexModelCatalog;
  const getCachedModelEndpointsFn = options.getCachedModelEndpointsFn
    || codexClient.getCachedModelEndpoints;
  const codexModelRegistry = options.codexModelRegistry || options.modelRegistry;
  const openAIModelEnv = options.openAIModelEnv || process.env;
  const upstreamTimeoutMs = parsePositiveInteger(options.upstreamTimeoutMs, ADAPTER_RUNTIME_CONFIG.upstreamTimeoutMs);
  const streamHandshakeTimeoutMs = parsePositiveInteger(options.streamHandshakeTimeoutMs, ADAPTER_RUNTIME_CONFIG.streamHandshakeTimeoutMs);
  const streamIdleTimeoutMs = parsePositiveInteger(options.streamIdleTimeoutMs, ADAPTER_RUNTIME_CONFIG.streamIdleTimeoutMs);
  const requestBodyTimeoutMs = parsePositiveInteger(options.requestBodyTimeoutMs, ADAPTER_RUNTIME_CONFIG.requestBodyTimeoutMs);
  const acquireRequest = options.acquireRequest || createRequestAdmission();
  const requestMetrics = options.requestMetrics || createRequestMetrics();
  const streamPerformanceMetrics = options.streamPerformanceMetrics || createStreamPerformanceMetrics();
  const imagePressure = options.imagePressure || createResponsesImagePressureController();
  const responseFailures = options.responseFailures || createResponseFailureDiagnostics();
  const httpErrors = createHttpFailureDiagnostics();
  const optionalRoutes = createOptionalRoutes({ ...options, dashboardOptions: { ...options.dashboardOptions,
    credentialsChanged: options.dashboardOptions?.credentialsChanged || (() => codexClient.invalidateCredentials?.()),
    ...(options.providerRuntime ? { providerCatalogFn: input => options.providerRuntime.dashboardCatalog(input),
      providerStateFn: () => options.providerRuntime.dashboardProviders(),
      providerAccountsFn: () => options.providerRuntime.action({ action: "accounts" }),
      connectionsFn: input => options.providerRuntime.manageConnections(input) } : {}) } });
  let statusSnapshot;
  const managementHandler = createManagementHandler({
    nativePredictionPac: options.nativePredictionPac, fixPrediction: options.fixPrediction, requestBodyTimeoutMs,
    statusSnapshot: statusSnapshot = () => {
      const snapshot = runtimeStatusPayload({ metrics: requestMetrics, streamPerformance: streamPerformanceMetrics, admission: acquireRequest,
        imagePressure, responseFailures, imageGeneration: optionalRoutes.imageStats(),
        modelRegistry: codexModelRegistry, codexClient, codexModelRegistry, codexModelCatalog,
        clientIntegrations: options.clientIntegrationSnapshot?.() });
      const providers = options.providerRuntime?.snapshot();
      if (providers?.codex_provider === "m365") {
        snapshot.routing = { ...snapshot.routing, responses: "m365" };
        snapshot.models = { ...snapshot.models, models: providers.m365.models?.gpt || 0,
          source: providers.m365.models?.source || "unavailable", provider: "m365",
          refresh_in_flight: providers.m365.refresh_in_flight === true };
      }
      if (providers?.codex_provider?.startsWith("api_")) {
        const source = providers.connections.providers.find(entry => entry.id === providers.codex_provider);
        snapshot.routing = { ...snapshot.routing, responses: providers.codex_provider };
        snapshot.models = { ...snapshot.models, provider: providers.codex_provider, source: "configured", models: source?.codex_model_count || 0, refresh_in_flight: false };
      }
      return { ...snapshot, http_errors: httpErrors.snapshot(), ...(providers ? { providers } : {}) };
    },
  });
  const responsesHandler = createResponsesHandler({
    validateConversation: (body, headers, source) => options.providerRuntime?.validateConversation?.(body, headers, source),
    resolveProvider: (body, req) => options.providerRuntime?.resolveCodex?.(body, req),
    providerPreference: id => options.providerRuntime?.providerPreference?.(id),
    provider: options.provider || options.providerRuntime?.github,
    acquireRequest,
    autoReviewModelResolver: options.autoReviewModelResolver,
    chatCompletionsFn,
    getCachedModelEndpointsFn,
    imagePressure,
    keepaliveIntervalMs: options.keepaliveIntervalMs,
    modelRegistry: codexModelRegistry,
    now: options.now,
    openAIModelEnv,
    responsesPayloadOptions: options.responsesPayloadOptions,
    responsesFn,
    responseFailures,
    requestBodyTimeoutMs,
    streamHandshakeTimeoutMs,
    streamIdleTimeoutMs,
    upstreamTimeoutMs,
  });
  const responsesCompactHandler = createResponsesCompactHandler({
    validateConversation: (body, headers, source) => options.providerRuntime?.validateConversation?.(body, headers, source),
    resolveProvider: (body, req) => options.providerRuntime?.resolveCodex?.(body, req),
    providerPreference: id => options.providerRuntime?.providerPreference?.(id),
    provider: options.provider || options.providerRuntime?.github,
    acquireRequest,
    autoReviewModelResolver: options.autoReviewModelResolver,
    imagePressure,
    modelRegistry: codexModelRegistry,
    now: options.now,
    openAIModelEnv,
    requestBodyTimeoutMs,
    responsesCompactFn,
    streamHandshakeTimeoutMs,
    streamIdleTimeoutMs,
    upstreamTimeoutMs,
  });
  const providerHandlers = new WeakMap();
  const githubHandlers = { responses: responsesHandler, compact: responsesCompactHandler };
  function handlersFor(provider) {
    if (!provider || provider.id === "github") return githubHandlers;
    if (!providerHandlers.has(provider)) {
      const common = { provider, acquireRequest, imagePressure, keepaliveIntervalMs: options.keepaliveIntervalMs,
        validateConversation: (body, headers, source) => options.providerRuntime?.validateConversation?.(body, headers, source),
    resolveProvider: (body, req) => options.providerRuntime?.resolveCodex?.(body, req),
    providerPreference: id => options.providerRuntime?.providerPreference?.(id),
        modelRegistry: provider.registry, now: options.now, openAIModelEnv: { ...openAIModelEnv, CCDX_AUTO_REVIEW_MODEL: "" },
        autoReviewModelResolver: () => { const preference = options.providerRuntime.providerPreference?.(provider.id) || options.providerRuntime.selection().m365;
          return { model: preference?.auto_review_model, reasoningEffort: preference?.auto_review_effort === undefined ? Object.hasOwn(provider, "defaultReviewEffort") ? provider.defaultReviewEffort : "low" : preference.auto_review_effort }; },
        requestBodyTimeoutMs, responsesPayloadOptions: options.responsesPayloadOptions, responseFailures,
        streamHandshakeTimeoutMs, streamIdleTimeoutMs, upstreamTimeoutMs };
      providerHandlers.set(provider, {
        responses: createResponsesHandler({ ...common, responsesFn: provider.client.responses, chatCompletionsFn: provider.client.chatCompletions,
          getCachedModelEndpointsFn: provider.client.getCachedModelEndpoints }),
        compact: createResponsesCompactHandler({ ...common, responsesCompactFn: provider.client.responsesCompact }),
      });
    }
    return providerHandlers.get(provider);
  }
  const dispatch = async (req, res, pathname) => {
    if (options.isDraining?.() && ![ADAPTER_STATUS_PATH, ADAPTER_HEALTH_PATH].includes(pathname)) {
      res.setHeader("Retry-After", "1");sendJsonError(res, httpError("CCDX is switching versions; retry shortly", 503));return;
    }
    if (pathname.startsWith("/anthropic/")) {
      if (!isLoopbackAddress(req.socket?.remoteAddress) || !req.headers?.host || !isLoopbackHostHeader(req.headers.host)
        || Object.hasOwn(req.headers, "origin")) { sendJsonError(res, httpError("Claude requires native local clients", 403));return; }
      if (!options.providerRuntime?.handleClaude) { sendJsonError(res, httpError("Claude is not configured", 503));return; }
      const original = req.url;
      const query = new URL(req.url, "http://localhost").search;
      req.url = pathname.slice("/anthropic".length) + query;
      try { return await options.providerRuntime.handleClaude(req, res); }
      catch (error) { sendJsonError(res, error, error.statusCode || 502); }
      finally { req.url = original; }
    }
    if (req.method === "POST" && ["/v1/responses", "/v1/responses/compact"].includes(pathname)
      && Object.hasOwn(req.headers || {}, "origin")) {
      const error = httpError("Browser origins are not allowed for inference", 403);
      error.jsonBody = { error: { message: error.message, type: "invalid_request_error", code: "ccdx_browser_origin_forbidden" } };
      sendJsonError(res, error, 403);
      return;
    }
    if (isOptionalRoute(req.method, pathname)) return optionalRoutes.handle(req, res, pathname);
    if (isManagementRoute(req.method, pathname)) return managementHandler(req, res, pathname);
    if (pathname === PROVIDER_MANAGEMENT_PATH) return handleProviderManagement(req, res, options.providerRuntime);

    let target;
    if (["/v1/responses", "/v1/responses/compact", "/v1/models"].includes(pathname) && options.providerRuntime) {
      try { target = options.providerRuntime.current(req); }
      catch (error) { sendJsonError(res, error, 503);return; }
      const context = currentRequestContext();
      if (context && !(req.method === "POST" && options.providerRuntime.hasModelBindings?.())) {
        context.provider = target.id;
        context.streamPerformance?.setProvider?.(target.id);
        context.finishProvider = options.providerRuntime.track?.(target);
        Object.assign(context, options.providerRuntime.historyContext?.(req.headers, target));
        context.clientHeaders = {
          session_id: typeof req.headers.session_id === "string" ? req.headers.session_id : undefined,
          "session-id": typeof req.headers["session-id"] === "string" ? req.headers["session-id"] : undefined,
          "x-conversation-id": typeof req.headers["x-conversation-id"] === "string" ? req.headers["x-conversation-id"] : undefined,
        };
      }
    }

    if (req.method === "POST" && pathname === "/v1/responses") {
      return handlersFor(target).responses(req, res);
    }

    if (req.method === "POST" && pathname === "/v1/responses/compact") {
      return handlersFor(target).compact(req, res);
    }

    if (req.method === "GET" && pathname === "/v1/models") {
      const clientVersion = modelClientVersion(req.url);
      const selectedRegistry = target?.registry || codexModelRegistry;
      const selectedListModels = target && (target.id !== "github" || options.providerRuntime.hasModelBindings?.()) ? target.client.listModels : listModelsFn;
      const modelOptions = { codexModelCatalog, clientVersion, providerCatalog: target?.codexCatalog, restrictToUpstream: Boolean(target && target.id !== "github") };
      const abort = createRequestAbort(req, res);
      // Keep live discovery and explicit auth failures authoritative, but do
      // not make a usable cached picker wait the full inference timeout.
      const modelTimeoutMs = isValidModelList(selectedRegistry?.models)
        ? Math.min(upstreamTimeoutMs, parsePositiveInteger(options.cachedModelsTimeoutMs, 1500))
        : upstreamTimeoutMs;
      abort.setTimeout(modelTimeoutMs);
      selectedListModels({ signal: abort.signal })
        .then(async ({ status, body }) => {
          abort.clearTimeout();
          if (status >= 200 && status < 300) {
            let models;
            try { models = JSON.parse(body); } catch {}
            if (isValidModelList(models)) {
              if (selectedRegistry) {
                selectedRegistry.models = models;
              }
              await sendModelList(res, models, {
                ...modelOptions,
                rawBody: body,
                statusCode: status,
              });
              return;
            }
            if (await sendLastKnownGoodModels(res, selectedRegistry, modelOptions)) return;
            sendJsonError(res, httpError("Copilot models response contained no valid models", 502), 502);
            return;
          }
          if (modelListCanUseLastKnownGood(status)
            && await sendLastKnownGoodModels(res, selectedRegistry, modelOptions)) return;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(body);
        })
        .catch(async (e) => {
          logRequestFailure("Models", e, abort);
          if (await sendLastKnownGoodModels(res, selectedRegistry, modelOptions)) return;
          if (!res.destroyed && !res.writableEnded) {
            if (!res.headersSent) res.writeHead(e?.statusCode || 502);
            res.end(JSON.stringify({ error: e.message }));
          }
        })
        .finally(() => abort.cleanup());
      return;
    }

    if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
      return sendRetiredClaudeSurface(res);
    }

    if (req.method === "POST" && pathname === "/v1/messages") {
      return sendRetiredClaudeSurface(res);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  };
  const dispatchRequest = typeof options.dispatchRequestForTests === "function"
    ? options.dispatchRequestForTests
    : dispatch;

  const handler = (req, res) => {
    const requestId = createRequestId();
    if (typeof res.setHeader === "function") {
      res.setHeader("X-Request-Id", requestId);
    } else if (res.headers && typeof res.headers === "object") {
      res.headers["X-Request-Id"] = requestId;
    }
    let pathname;
    try {
      pathname = requestPath(req.url);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ error: "Invalid request target" }));
      return;
    }

    const trackRequest = pathname !== ADAPTER_HEALTH_PATH
      && pathname !== ADAPTER_STATUS_PATH
      && pathname !== ADAPTER_CACHE_PATH
      && pathname !== ADAPTER_PREDICTION_FIX_PATH
      && pathname !== PROVIDER_MANAGEMENT_PATH
      && !DASHBOARD_API_PATHS.has(pathname)
      && !((req.method === "GET" || req.method === "HEAD") && DASHBOARD_PATHS.has(pathname));
    const routeName = classifyAdapterRoute(req.method, pathname);
    const complete = trackRequest ? requestMetrics.begin(routeName) : () => {};
    const streamPerformance = trackRequest ? streamPerformanceMetrics.begin(routeName, { requestId, application: requestApplication(req.headers) }) : null;
    let finishTerminalActivity = () => {};
    if (trackRequest && ["responses", "responses_compact", "messages", "image_mcp"].includes(routeName)) {
      try {
        const finish = options.terminalActivity?.beginRequest?.();
        if (typeof finish === "function") finishTerminalActivity = finish;
      } catch {}
    }
    let requestFinished = false;
    let httpEvidence = {}, context;
    const finishRequest = ({ statusCode = 0, aborted = false } = {}) => {
      if (requestFinished) return;
      requestFinished = true;
      if (trackRequest && statusCode >= 400) {
        try { httpErrors.record(buildHttpFailureDetails({ ...httpEvidence, statusCode, route: routeName, requestId, model: context?.model || context?.requestedModel,
          method: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"].includes(req.method) ? req.method : "OTHER",
          target: ["/v1/responses", "/v1/responses/compact", "/anthropic/v1/messages", "/anthropic/v1/messages/count_tokens", "/anthropic/v1/models", "/mcp/image", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp/image"].includes(pathname) ? pathname : "unrecognized_path",
          request_options: context?.requestOptions, upstream_attempts: streamPerformance?.attemptCount?.() ?? context?.upstreamAttempts,
          attempt_timings: streamPerformance?.attemptTimings?.(),
          requested_model: context?.requestedModel, provider: context?.provider, application: context?.application || requestApplication(req.headers),
          capability_cached: context?.countObservation?.cached, shared_upstream: context?.countObservation?.shared,
        })); } catch {}
      }
      try { complete({ statusCode, aborted }); } catch {}
      try { streamPerformance?.finish({ failed: aborted || statusCode >= 400, aborted, statusCode }); } catch {}
      try { finishTerminalActivity(); } catch {}
      try { context?.finishProvider?.(); } catch {}
    };
    const containUnexpectedError = (error) => {
      try { finishRequest({ statusCode: res.statusCode >= 400 ? res.statusCode : 500 }); } catch {}
      const safeCause = error instanceof Error ? error : new Error("Unexpected adapter failure");
      try { logRequestFailure("Adapter", safeCause); } catch {}
      try {
        const safeError = httpError("Internal adapter error", 500);
        safeError.jsonBody = {
          error: {
            message: safeError.message,
            type: "server_error",
            code: "ccdx_internal_error",
          },
        };
        sendJsonError(res, safeError, 500);
      } catch {
        try { res.destroy?.(); } catch {}
      }
    };
    if (trackRequest && typeof res.once === "function") {
      res.once("finish", () => finishRequest({ statusCode: res.statusCode }));
      res.once("close", () => finishRequest({
        statusCode: res.statusCode,
        aborted: !res.writableFinished && !res.writableEnded,
      }));
    }

    try {
      context = {
        requestId,
        pathname,
        showRequestId: options.showRequestId === true,
        includeHttpErrorDetails: options.includeHttpErrorDetails === true || process.env.CCDX_HTTP_ERROR_DETAILS === "1",
        streamPerformance,
        upstreamAttempts: 0,
        provider: undefined,
        finishProvider: undefined,
        historyNamespace: undefined,
        historyTransferNamespace: undefined,
        onHistoryStored: undefined,
        clientHeaders: undefined,
        onHttpError: evidence => { httpEvidence = { ...httpEvidence, ...evidence }; },
      };
      const result = runWithRequestContext(context, () => dispatchRequest(req, res, pathname));
      if (result && typeof result.then === "function") {
        return result.catch((error) => {
          containUnexpectedError(error);
        });
      }
      return result;
    } catch (error) {
      containUnexpectedError(error);
    }
  };
  handler.snapshot = statusSnapshot;
  handler.busy = () => optionalRoutes.busy() || options.providerRuntime?.busy?.() === true;
  handler.exportState = () => ({ version: 1, history: exportResponseHistory(), optional: optionalRoutes.exportState() });
  handler.importState = async state => {
    if (state?.version !== 1) throw new Error("Unsupported service-state version");
    importResponseHistory(state.history);await optionalRoutes.importState(state.optional);
  };
  handler.cleanup = () => optionalRoutes.dispose();
  return handler;
}

// Public server entry point.

export async function startAdapter(port = 2026, host = "127.0.0.1", options = {}) {
  const handoffState = options.handoffState;options = { ...options };delete options.handoffState;
  const ownsTerminalActivity = !Object.hasOwn(options, "terminalActivity");
  const terminalActivity = ownsTerminalActivity
    ? createTerminalActivityIndicator({ theme: options.terminalAnimationTheme })
    : options.terminalActivity;
  const handler = createAdapterHandler({ ...options, terminalActivity, imageMcpHostname: host });
  const server = http.createServer(handler);
  server.ccdxSnapshot = handler.snapshot;
  server.ccdxBusy = handler.busy;
  server.ccdxExportState = handler.exportState;
  server.ccdxImportState = handler.importState;
  if (handoffState) await handler.importState(handoffState);
  const cleanupTerminalActivity = () => {
    if (ownsTerminalActivity) terminalActivity?.cleanup?.();
    handler.cleanup?.();
  };
  server.on("close", cleanupTerminalActivity);

  server.on("upgrade", (req, socket) => {
    // The responses_websockets upgrade expects a server-push protocol that this
    // adapter does not implement. Refuse it so the client can fall back to the
    // supported HTTP SSE transport instead of waiting on an unusable socket.
    socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
  });

  return new Promise((resolve, reject) => {
    const onListenError = (e) => {
      cleanupTerminalActivity();
      if (e?.code === "EADDRINUSE") {
        reject(new Error(`Adapter address http://${host}:${port} is already in use. Stop the existing ccdx process or set ADAPTER_PORT to another port.`));
        return;
      }
      reject(e);
    };

    server.once("error", onListenError);
    server.listen(port, host, () => {
      server.off("error", onListenError);
      const actualPort = server.address()?.port || port;
      (options.log || console.log)(status("ok", `Adapter listening on http://${host}:${actualPort}`));
      resolve(server);
    });
  });
}
