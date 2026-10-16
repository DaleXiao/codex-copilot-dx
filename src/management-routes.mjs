import { ADAPTER_STATUS_PATH, ADAPTER_HEALTH_PATH, ADAPTER_PREDICTION_FIX_PATH, PREDICTION_FIX_CAPABILITY, adapterHealthPayload } from "./running-adapter.mjs";
import { ADAPTER_CACHE_PATH, cacheRuntimeSnapshot, cleanRuntimeCaches, setHistoryCacheLimit } from "./cache-control.mjs";
import { createRequestAbort, readJsonBody, sendJsonError } from "./http-transport.mjs";
import { httpError } from "./http-errors.mjs";
import { isLoopbackAddress, isLoopbackHostHeader } from "./security.mjs";

export function isManagementRoute(method, pathname) {
  return (method === "GET" && [ADAPTER_STATUS_PATH, ADAPTER_HEALTH_PATH].includes(pathname))
    || pathname === ADAPTER_PREDICTION_FIX_PATH || pathname === ADAPTER_CACHE_PATH;
}

// Management retains its own access checks; it receives snapshots and explicit
// actions, never an inference client or a second integration lifecycle.
export function createManagementHandler({ statusSnapshot, nativePredictionPac, fixPrediction, requestBodyTimeoutMs } = {}) {
  const options = { nativePredictionPac, fixPrediction };
  return async (req, res, pathname) => {
    if (req.method === "GET" && pathname === ADAPTER_STATUS_PATH) {
      if (!isLoopbackAddress(req.socket?.remoteAddress) || !isLoopbackHostHeader(req.headers?.host)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Runtime status is available only from loopback" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(statusSnapshot()));
      return;
    }

    if (req.method === "GET" && pathname === ADAPTER_HEALTH_PATH) {
      res.writeHead(200, { "Content-Type": "application/json" });
      const predictionPac = isLoopbackAddress(req.socket?.remoteAddress) && isLoopbackHostHeader(req.headers?.host)
        ? options.nativePredictionPac?.() : null;
      const health = adapterHealthPayload();
      res.end(JSON.stringify({ ...health,
        capabilities: [...health.capabilities, ...(typeof options.fixPrediction === "function" ? [PREDICTION_FIX_CAPABILITY] : [])],
        ...(predictionPac ? { native_prediction_pac: predictionPac } : {}) }));
      return;
    }

    if (pathname === ADAPTER_PREDICTION_FIX_PATH) {
      if (!isLoopbackAddress(req.socket?.remoteAddress) || req.headers?.host === undefined
        || !isLoopbackHostHeader(req.headers.host) || Object.hasOwn(req.headers, "origin")) {
        sendJsonError(res, httpError("Prediction repair is available only to native loopback clients", 403));return;
      }
      if (req.method !== "POST") {
        res.setHeader?.("Allow", "POST");sendJsonError(res, httpError("Prediction repair requires POST", 405));return;
      }
      if (String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        sendJsonError(res, httpError("Prediction repair requires application/json", 415));return;
      }
      if (typeof options.fixPrediction !== "function") {
        sendJsonError(res, httpError("This adapter does not support prediction repair; upgrade and restart CCDX once", 503));return;
      }
      const abort = createRequestAbort(req, res);abort.setTimeout(2000);
      try {
        const body = await readJsonBody(req, { maxBodyBytes: 1024, maxDecodedBodyBytes: 1024, signal: abort.signal });
        if (!body || Object.keys(body).length !== 1 || body.action !== "fix") throw httpError("Expected prediction repair action: fix", 400);
        abort.clearTimeout();
        const result = await options.fixPrediction();
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });res.end(JSON.stringify(result));
        }
      } catch (error) { sendJsonError(res, error, 503); }
      finally { abort.cleanup(); }
      return;
    }

    if (pathname === ADAPTER_CACHE_PATH) {
      if (!isLoopbackAddress(req.socket?.remoteAddress) || !isLoopbackHostHeader(req.headers?.host)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Cache control is available only from loopback" }));
        return;
      }
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(cacheRuntimeSnapshot()));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json", Allow: "GET, POST" });
        res.end(JSON.stringify({ error: "Only GET and POST are supported" }));
        return;
      }
      if (Object.hasOwn(req.headers || {}, "origin")) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Browser origins are not allowed for cache control" }));
        return;
      }
      const mediaType = String(req.headers?.["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
      if (mediaType !== "application/json") {
        res.writeHead(415, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Cache control requires application/json" }));
        return;
      }
      const abort = createRequestAbort(req, res);
      abort.setTimeout(requestBodyTimeoutMs, "request_body_timeout");
      try {
        const body = await readJsonBody(req, {
          maxBodyBytes: 8 * 1024,
          maxDecodedBodyBytes: 8 * 1024,
          signal: abort.signal,
        });
        let result;
        if (body?.action === "set_limit") result = setHistoryCacheLimit(body.max_bytes);
        else if (body?.action === "clean") result = cleanRuntimeCaches({ history: body.history === true });
        else throw httpError("Unknown cache action", 400);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(result));
      } catch (error) {
        if (["ccdx_cache_busy", "ccdx_cache_limit_below_usage"].includes(error?.code)) error.statusCode = 409;
        sendJsonError(res, error, 400);
      } finally {
        abort.cleanup();
      }
      return;
    }

  };
}
