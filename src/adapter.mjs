import http from "node:http";
import { createAnthropicCountTokensHandler, createAnthropicMessagesHandler } from "./anthropic-handler.mjs";
import { chatCompletions, listModels, responses as copilotResponses, responsesCompact as copilotResponsesCompact } from "./copilot.mjs";
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
import { status } from "./status.mjs";
import { ADAPTER_HEALTH_PATH, adapterHealthPayload } from "./running-adapter.mjs";
import { createResponsesCompactHandler, createResponsesHandler } from "./responses-handler.mjs";
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
  isEncryptedContentVerificationError,
  isImageNamespaceCollisionError,
  openCopilotResponse,
  prepareResponsesRequest,
  rememberResponseHistory,
  sanitizeEncryptedReasoningRequest,
  sanitizeImageNamespaceCollisionRequest,
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
  const chatCompletionsFn = options.chatCompletionsFn || chatCompletions;
  const responsesFn = options.responsesFn || copilotResponses;
  const responsesCompactFn = options.responsesCompactFn || copilotResponsesCompact;
  const listModelsFn = options.listModelsFn || listModels;
  const openAIModelEnv = options.openAIModelEnv || process.env;
  const upstreamTimeoutMs = parsePositiveInteger(options.upstreamTimeoutMs, ADAPTER_RUNTIME_CONFIG.upstreamTimeoutMs);
  const streamHandshakeTimeoutMs = parsePositiveInteger(options.streamHandshakeTimeoutMs, ADAPTER_RUNTIME_CONFIG.streamHandshakeTimeoutMs);
  const streamIdleTimeoutMs = parsePositiveInteger(options.streamIdleTimeoutMs, ADAPTER_RUNTIME_CONFIG.streamIdleTimeoutMs);
  const acquireRequest = options.acquireRequest || createRequestAdmission();
  const requestMetrics = options.requestMetrics || createRequestMetrics();
  const claudeDesktopModelOptions = () => {
    const modelDefs = options.modelRegistry?.modelDefs || options.claudeDesktopModelDefs;
    return Array.isArray(modelDefs) ? { modelDefs } : {};
  };
  const responsesHandler = createResponsesHandler({
    acquireRequest,
    chatCompletionsFn,
    openAIModelEnv,
    responsesFn,
    streamHandshakeTimeoutMs,
    streamIdleTimeoutMs,
    upstreamTimeoutMs,
  });
  const responsesCompactHandler = createResponsesCompactHandler({
    acquireRequest,
    openAIModelEnv,
    responsesCompactFn,
    streamHandshakeTimeoutMs,
    streamIdleTimeoutMs,
    upstreamTimeoutMs,
  });
  const anthropicCountTokensHandler = createAnthropicCountTokensHandler({ acquireRequest });
  const anthropicMessagesHandler = createAnthropicMessagesHandler({
    acquireRequest,
    chatCompletionsFn,
    environment: process.env,
    modelOptions: claudeDesktopModelOptions,
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
        admission: acquireRequest,
        modelRegistry: options.modelRegistry,
      })));
      return;
    }

    if (req.method === "GET" && pathname === ADAPTER_HEALTH_PATH) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(adapterHealthPayload()));
      return;
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
              if (options.modelRegistry) {
                options.modelRegistry.models = models;
              }
              res.writeHead(status, { "Content-Type": "application/json" });
              res.end(body);
              return;
            }
            if (sendLastKnownGoodModels(res, options.modelRegistry)) return;
            sendJsonError(res, httpError("Copilot models response contained no valid models", 502), 502);
            return;
          }
          if (modelListCanUseLastKnownGood(status) && sendLastKnownGoodModels(res, options.modelRegistry)) return;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(body);
        })
        .catch((e) => {
          logRequestFailure("Models", e, abort);
          if (sendLastKnownGoodModels(res, options.modelRegistry)) return;
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

  return (req, res) => {
    const pathname = requestPath(req.url);
    const requestId = createRequestId();
    if (typeof res.setHeader === "function") {
      res.setHeader("X-Request-Id", requestId);
    } else if (res.headers && typeof res.headers === "object") {
      res.headers["X-Request-Id"] = requestId;
    }

    const trackRequest = pathname !== ADAPTER_HEALTH_PATH && pathname !== ADAPTER_STATUS_PATH;
    const complete = trackRequest
      ? requestMetrics.begin(classifyAdapterRoute(req.method, pathname))
      : () => {};
    if (trackRequest && typeof res.once === "function") {
      res.once("finish", () => complete({ statusCode: res.statusCode }));
      res.once("close", () => complete({
        statusCode: res.statusCode,
        aborted: !res.writableFinished && !res.writableEnded,
      }));
    }

    try {
      const result = runWithRequestContext({ requestId, pathname }, () => dispatch(req, res, pathname));
      if (result && typeof result.then === "function") {
        return result.catch((error) => {
          complete({ statusCode: res.statusCode >= 400 ? res.statusCode : 500 });
          throw error;
        });
      }
      return result;
    } catch (error) {
      complete({ statusCode: res.statusCode >= 400 ? res.statusCode : 500 });
      throw error;
    }
  };
}

// Public server entry point.

export function startAdapter(port = 2026, host = "127.0.0.1", options = {}) {
  const server = http.createServer(createAdapterHandler(options));

  server.on("upgrade", (req, socket) => {
    // Codex Desktop 0.130+ negotiates a "responses_websockets" server-push
    // protocol on WS upgrade. We don't implement that protocol; accepting the
    // upgrade and waiting for a client request just hangs and triggers a
    // 5-attempt reconnect storm. Refuse the upgrade so Codex falls back to
    // plain HTTP SSE, which this adapter handles correctly.
    socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
  });

  return new Promise((resolve, reject) => {
    const onListenError = (e) => {
      if (e?.code === "EADDRINUSE") {
        reject(new Error(`Adapter address http://${host}:${port} is already in use. Stop the existing codex-copilot-dx process or set ADAPTER_PORT to another port.`));
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
