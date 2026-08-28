import http from "node:http";
import { createAnthropicCountTokensHandler, createAnthropicMessagesHandler } from "./anthropic-handler.mjs";
import { defaultCopilotClient } from "./copilot.mjs";
import { isValidModelList } from "./model-cache.mjs";
import { claudeDesktopModelsResponse } from "./models.mjs";
import {
  ADAPTER_STATUS_PATH,
  classifyAdapterRoute,
  createRequestMetrics,
  isLoopbackAddress,
  runtimeStatusPayload,
} from "./observability.mjs";
import { createRequestId, runWithRequestContext } from "./request-context.mjs";
import { createPmStudioRelayHandler, PM_STUDIO_RELAY_PREFIX } from "./pm-studio-relay.mjs";
import { createStreamPerformanceMetrics } from "./stream-performance.mjs";
import { status } from "./status.mjs";
import { createTerminalActivityIndicator } from "./terminal-activity.mjs";
import { ADAPTER_HEALTH_PATH, adapterHealthPayload } from "./running-adapter.mjs";
import { createResponsesCompactHandler, createResponsesHandler } from "./responses-handler.mjs";
import { createResponsesImagePressureController } from "./responses-image-pressure.mjs";
import { loadRuntimeConfig, parsePositiveInteger } from "./runtime-config.mjs";
import {
  createRequestAdmission,
  createRequestAbort,
  httpError,
  logRequestFailure,
  sendJsonError,
} from "./http-transport.mjs";

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

function bearerToken(headers = {}) {
  const value = headers.authorization || headers.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(String(value));
  return match?.[1]?.trim() || "";
}

export function shouldServeClaudeDesktopModels(req, claudeDesktopApiKey) {
  if (!claudeDesktopApiKey || claudeDesktopApiKey === "dummy") return false;
  const token = bearerToken(req.headers);
  const xApiKey = req.headers?.["x-api-key"] || req.headers?.["X-Api-Key"] || req.headers?.["X-API-Key"] || "";
  return token === claudeDesktopApiKey || xApiKey === claudeDesktopApiKey;
}

function modelListCanUseLastKnownGood(statusCode) {
  return [408, 425, 429].includes(statusCode) || statusCode >= 500;
}

function sendLastKnownGoodModels(res, modelRegistry) {
  if (!isValidModelList(modelRegistry?.models) || res.destroyed || res.writableEnded) return false;
  res.writeHead(200, {
    "Content-Type": "application/json",
    "X-CCDX-Model-Source": "last-known-good",
  });
  res.end(JSON.stringify(modelRegistry.models));
  return true;
}

// Shared request handler. Keeping this separate from the listener makes the
// complete HTTP routing layer testable without opening a local port.
export function createAdapterHandler(options = {}) {
  const claudeDesktopApiKey = options.claudeDesktopApiKey
    || process.env.CCDX_CLAUDE_DESKTOP_API_KEY
    || process.env.CCDX_PROXY_API_KEY
    || "";
  const codexClient = options.codexClient || defaultCopilotClient;
  const hasExplicitClaudeMode = Object.hasOwn(options, "claudeMode");
  if (hasExplicitClaudeMode && !["inherited", "isolated"].includes(options.claudeMode)) {
    throw new Error(`Unsupported Claude mode: ${options.claudeMode}`);
  }
  if (options.claudeMode === "isolated"
    && (!options.claudeClient || options.claudeClient === codexClient)) {
    throw new Error("Isolated Claude mode requires a distinct Claude client");
  }
  if (options.claudeMode === "inherited"
    && options.claudeClient && options.claudeClient !== codexClient) {
    throw new Error("Inherited Claude mode requires the Codex client");
  }
  const claudeClient = options.claudeClient || codexClient;
  // chatCompletionsFn is retained as a compatibility injection and continues to
  // override both surfaces in existing tests and embedders. New dual-profile
  // callers should pass codexClient/claudeClient instead.
  const codexChatCompletionsFn = options.codexChatCompletionsFn
    || options.chatCompletionsFn
    || codexClient.chatCompletions;
  const claudeChatCompletionsFn = options.claudeChatCompletionsFn
    || options.chatCompletionsFn
    || claudeClient.chatCompletions;
  const responsesFn = options.responsesFn || codexClient.responses;
  const responsesCompactFn = options.responsesCompactFn || codexClient.responsesCompact;
  const listModelsFn = options.listModelsFn || codexClient.listModels;
  const getCachedModelEndpointsFn = options.getCachedModelEndpointsFn
    || codexClient.getCachedModelEndpoints;
  const claudeMode = hasExplicitClaudeMode
    ? options.claudeMode
    : claudeClient === codexClient ? "inherited" : "isolated";
  if (claudeMode === "isolated" && options.chatCompletionsFn) {
    throw new Error("Isolated Claude mode cannot use the shared chatCompletionsFn override; pass codexChatCompletionsFn or claudeChatCompletionsFn explicitly");
  }
  const codexModelRegistry = options.codexModelRegistry || options.modelRegistry;
  const claudeModelRegistry = options.claudeModelRegistry || options.modelRegistry || codexModelRegistry;
  if (claudeMode === "isolated"
    && (!options.claudeModelRegistry || claudeModelRegistry === codexModelRegistry)) {
    throw new Error("Isolated Claude mode requires a distinct Claude model registry");
  }
  const openAIModelEnv = options.openAIModelEnv || process.env;
  const upstreamTimeoutMs = parsePositiveInteger(options.upstreamTimeoutMs, ADAPTER_RUNTIME_CONFIG.upstreamTimeoutMs);
  const streamHandshakeTimeoutMs = parsePositiveInteger(options.streamHandshakeTimeoutMs, ADAPTER_RUNTIME_CONFIG.streamHandshakeTimeoutMs);
  const streamIdleTimeoutMs = parsePositiveInteger(options.streamIdleTimeoutMs, ADAPTER_RUNTIME_CONFIG.streamIdleTimeoutMs);
  const requestBodyTimeoutMs = parsePositiveInteger(options.requestBodyTimeoutMs, ADAPTER_RUNTIME_CONFIG.requestBodyTimeoutMs);
  const acquireRequest = options.acquireRequest || createRequestAdmission();
  const requestMetrics = options.requestMetrics || createRequestMetrics();
  const streamPerformanceMetrics = options.streamPerformanceMetrics || createStreamPerformanceMetrics();
  const imagePressure = options.imagePressure || createResponsesImagePressureController();
  const claudeDesktopModelOptions = () => {
    const modelDefs = claudeModelRegistry?.modelDefs || options.claudeDesktopModelDefs;
    return Array.isArray(modelDefs) ? { modelDefs } : {};
  };
  const responsesHandler = createResponsesHandler({
    acquireRequest,
    autoReviewModelResolver: options.autoReviewModelResolver,
    chatCompletionsFn: codexChatCompletionsFn,
    getCachedModelEndpointsFn,
    imagePressure,
    modelRegistry: codexModelRegistry,
    now: options.now,
    openAIModelEnv,
    responsesPayloadOptions: options.responsesPayloadOptions,
    responsesFn,
    requestBodyTimeoutMs,
    streamHandshakeTimeoutMs,
    streamIdleTimeoutMs,
    upstreamTimeoutMs,
  });
  const responsesCompactHandler = createResponsesCompactHandler({
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
  const anthropicCountTokensHandler = createAnthropicCountTokensHandler({ acquireRequest, requestBodyTimeoutMs });
  const anthropicMessagesHandler = createAnthropicMessagesHandler({
    acquireRequest,
    chatCompletionsFn: claudeChatCompletionsFn,
    environment: process.env,
    modelOptions: claudeDesktopModelOptions,
    requestBodyTimeoutMs,
    streamHandshakeTimeoutMs,
    streamIdleTimeoutMs,
    upstreamTimeoutMs,
  });
  const pmStudioRelayHandler = createPmStudioRelayHandler({
    acquireRequest,
    claudeClient,
    claudeMode,
    claudeProfile: options.claudeProfile,
    claudeModelRegistry,
    fetchImpl: options.pmStudioFetchImpl,
    requestBodyTimeoutMs,
    streamHandshakeTimeoutMs,
    streamIdleTimeoutMs,
    upstreamTimeoutMs,
  });

  const dispatch = (req, res, pathname) => {
    if (req.method === "GET" && pathname === ADAPTER_STATUS_PATH) {
      if (!isLoopbackAddress(req.socket?.remoteAddress)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Runtime status is available only from loopback" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(runtimeStatusPayload({
        metrics: requestMetrics,
        streamPerformance: streamPerformanceMetrics,
        admission: acquireRequest,
        imagePressure,
        modelRegistry: codexModelRegistry,
        codexClient,
        claudeClient,
        codexModelRegistry,
        claudeModelRegistry,
        claudeMode,
        isClaudeProfileCurrent: options.isClaudeProfileCurrent,
      })));
      return;
    }

    if (req.method === "GET" && pathname === ADAPTER_HEALTH_PATH) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(adapterHealthPayload()));
      return;
    }

    if (pathname.startsWith(`${PM_STUDIO_RELAY_PREFIX}/`)) {
      return pmStudioRelayHandler(req, res, pathname);
    }

    if (req.method === "POST" && pathname === "/v1/responses") {
      return responsesHandler(req, res);
    }

    if (req.method === "POST" && pathname === "/v1/responses/compact") {
      return responsesCompactHandler(req, res);
    }

    if (req.method === "GET" && pathname === "/v1/models") {
      if (shouldServeClaudeDesktopModels(req, claudeDesktopApiKey)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(claudeDesktopModelsResponse(process.env, claudeDesktopModelOptions())));
        return;
      }
      const abort = createRequestAbort(req, res);
      abort.setTimeout(upstreamTimeoutMs);
      listModelsFn({ signal: abort.signal })
        .then(({ status, body }) => {
          if (status >= 200 && status < 300) {
            let models;
            try { models = JSON.parse(body); } catch {}
            if (isValidModelList(models)) {
              if (codexModelRegistry) {
                codexModelRegistry.models = models;
              }
              res.writeHead(status, { "Content-Type": "application/json" });
              res.end(body);
              return;
            }
            if (sendLastKnownGoodModels(res, codexModelRegistry)) return;
            sendJsonError(res, httpError("Copilot models response contained no valid models", 502), 502);
            return;
          }
          if (modelListCanUseLastKnownGood(status) && sendLastKnownGoodModels(res, codexModelRegistry)) return;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(body);
        })
        .catch((e) => {
          logRequestFailure("Models", e, abort);
          if (sendLastKnownGoodModels(res, codexModelRegistry)) return;
          if (!res.destroyed && !res.writableEnded) {
            if (!res.headersSent) res.writeHead(e?.statusCode || 502);
            res.end(JSON.stringify({ error: e.message }));
          }
        })
        .finally(() => abort.cleanup());
      return;
    }

    if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
      return anthropicCountTokensHandler(req, res);
    }

    if (req.method === "POST" && pathname === "/v1/messages") {
      return anthropicMessagesHandler(req, res);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  };
  const dispatchRequest = typeof options.dispatchRequestForTests === "function"
    ? options.dispatchRequestForTests
    : dispatch;

  return (req, res) => {
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

    const trackRequest = pathname !== ADAPTER_HEALTH_PATH && pathname !== ADAPTER_STATUS_PATH;
    const routeName = classifyAdapterRoute(req.method, pathname);
    const complete = trackRequest ? requestMetrics.begin(routeName) : () => {};
    const streamPerformance = trackRequest ? streamPerformanceMetrics.begin(routeName) : null;
    let finishTerminalActivity = () => {};
    if (trackRequest) {
      try {
        const finish = options.terminalActivity?.beginRequest?.();
        if (typeof finish === "function") finishTerminalActivity = finish;
      } catch {}
    }
    let requestFinished = false;
    const finishRequest = ({ statusCode = 0, aborted = false } = {}) => {
      if (requestFinished) return;
      requestFinished = true;
      try { complete({ statusCode, aborted }); } catch {}
      try { streamPerformance?.finish({ failed: aborted || statusCode >= 400 }); } catch {}
      try { finishTerminalActivity(); } catch {}
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
      const result = runWithRequestContext({
        requestId,
        pathname,
        showRequestId: options.showRequestId === true,
        streamPerformance,
      }, () => dispatchRequest(req, res, pathname));
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
}

// Public server entry point.

export function startAdapter(port = 2026, host = "127.0.0.1", options = {}) {
  const ownsTerminalActivity = !Object.hasOwn(options, "terminalActivity");
  const terminalActivity = ownsTerminalActivity ? createTerminalActivityIndicator() : options.terminalActivity;
  const server = http.createServer(createAdapterHandler({ ...options, terminalActivity }));
  const cleanupTerminalActivity = () => {
    if (ownsTerminalActivity) terminalActivity?.cleanup?.();
  };
  server.once("close", cleanupTerminalActivity);

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
      console.log(status("ok", `Adapter listening on http://${host}:${actualPort}`));
      resolve(server);
    });
  });
}
