import { createHash } from "node:crypto";
import {
  abortErrorStatusCode,
  createRequestAbort,
  createRequestAdmission,
  httpError,
  isAbortLikeError,
  readJsonBody,
  sendJsonError,
  writeOrDrain,
} from "./http-transport.mjs";
import { isLoopbackAddress } from "./observability.mjs";
import { createPmStudioModelRouter } from "./profile-routing.mjs";
import { loadRuntimeConfig, parsePositiveInteger } from "./runtime-config.mjs";
import { requireUpstreamEventStream } from "./stream-contract.mjs";
import { safeUpstreamResponseHeaders } from "./upstream-headers.mjs";

export const PM_STUDIO_RELAY_PREFIX = "/pm-ccdx";
const COPILOT_ORIGIN = "https://api.githubcopilot.com";
const DEFAULT_VALIDATION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_VALIDATION_CACHE_SIZE = 128;
const DEFAULT_VALIDATION_CONCURRENCY = 8;
const DEFAULT_VALIDATION_MAX_FLIGHTS = 32;
const DEFAULT_VALIDATION_MAX_WAITERS = 64;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const POST_PATHS = new Set([
  "/chat/completions",
  "/responses",
  "/embeddings",
]);

function localError(statusCode, code, message) {
  const error = httpError(message, statusCode);
  error.jsonBody = { error: { message, type: "invalid_request_error", code } };
  return error;
}

function sendLocalError(res, statusCode, code, message, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(statusCode, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ error: { message, type: "invalid_request_error", code } }));
}

function bearerToken(headers = {}) {
  const value = headers.authorization || headers.Authorization || "";
  const match = /^Bearer\s+([^\s].*)$/i.exec(String(value));
  return match?.[1]?.trim() || "";
}

function headerEntries(headers = {}) {
  if (headers && typeof headers[Symbol.iterator] === "function") return headers;
  return Object.entries(headers);
}

function connectionHeaderNames(headers = {}) {
  const value = headers.connection || headers.Connection || "";
  return new Set(String(value).split(",").map((name) => name.trim().toLowerCase()).filter(Boolean));
}

function enterpriseHeaders(inbound, token, bodyText) {
  const headers = new Headers();
  const connectionHeaders = connectionHeaderNames(inbound);
  for (const [rawName, rawValue] of headerEntries(inbound)) {
    const name = String(rawName).toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name)
      || connectionHeaders.has(name)
      || ["authorization", "host", "content-length", "content-encoding", "expect"].includes(name)) {
      continue;
    }
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value !== undefined) headers.append(name, String(value));
    }
  }
  headers.set("Authorization", `Bearer ${token}`);
  if (typeof bodyText === "string") {
    if (!headers.has("content-type")) headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Content-Length", String(Buffer.byteLength(bodyText)));
  } else {
    headers.delete("content-type");
    headers.set("Accept", "application/json");
  }
  return headers;
}

function tokenFingerprint(token) {
  return createHash("sha256").update(token).digest("hex");
}

function tokenExpiryMs(token) {
  const semicolonExpiry = /(?:^|[;,&\s])exp=(\d{9,16})(?:$|[;,&\s])/i.exec(token)?.[1];
  if (semicolonExpiry) {
    const value = Number(semicolonExpiry);
    return value >= 1e12 ? value : value * 1000;
  }
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const value = Number(payload.exp);
    return Number.isFinite(value) && value > 0 ? value * 1000 : null;
  } catch {
    return null;
  }
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function waitForFlight(flight, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  flight.waiters += 1;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (handler, value) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      flight.waiters -= 1;
      if (!flight.settled && flight.waiters === 0) flight.controller.abort();
      handler(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    flight.promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function catalogData(catalog) {
  if (Array.isArray(catalog)) return catalog;
  return Array.isArray(catalog?.data) ? catalog.data : null;
}

async function responseSnapshot(response) {
  return {
    status: response.status,
    ok: response.ok,
    headers: new Headers(response.headers),
    body: Buffer.from(await response.arrayBuffer()),
  };
}

function responseHeaders(headers, body, options) {
  return {
    ...safeUpstreamResponseHeaders(headers, options),
    "Content-Length": String(body.length),
  };
}

function sendSnapshot(res, snapshot, options = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(snapshot.status, responseHeaders(snapshot.headers, snapshot.body, options));
  res.end(snapshot.body);
}

function rejectUpstreamRedirect(response) {
  if (response.status >= 300 && response.status < 400) {
    throw localError(502, "upstream_redirect", "PM Studio relay rejected an upstream redirect");
  }
  return response;
}

function mergeModelCatalog(snapshot, modelRouter) {
  if (!snapshot.ok) return null;
  const allowed = modelRouter.allowedModels();
  if (!allowed.length) return null;
  let enterprise;
  try {
    enterprise = JSON.parse(snapshot.body.toString("utf8"));
  } catch {
    return null;
  }
  const data = catalogData(enterprise);
  if (!data) return null;
  const seen = new Set(data.map((model) => String(model?.id || "").trim()).filter(Boolean));
  const additions = [];
  for (const model of allowed) {
    const id = String(model?.id || "").trim();
    if (seen.has(id)) continue;
    seen.add(id);
    additions.push(model);
  }
  if (!additions.length) return null;
  return Buffer.from(JSON.stringify(Array.isArray(enterprise)
    ? [...enterprise, ...additions]
    : { ...enterprise, data: [...data, ...additions] }));
}

async function relayUpstreamResponse(response, reqBody, res, abort, streamIdleTimeoutMs) {
  const stream = reqBody?.stream === true;
  if (!stream || !response.ok) {
    const snapshot = await responseSnapshot(response);
    sendSnapshot(res, snapshot);
    return;
  }

  await requireUpstreamEventStream(response);
  abort.setTimeout(streamIdleTimeoutMs, "stream_idle_timeout");
  res.writeHead(response.status, {
    ...safeUpstreamResponseHeaders(response.headers, { contentType: "text/event-stream" }),
    "Cache-Control": "no-cache",
  });
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        res.end();
        return;
      }
      abort.setTimeout(streamIdleTimeoutMs, "stream_idle_timeout");
      let onAbort;
      const aborted = new Promise((resolve) => {
        onAbort = () => {
          if (!res.destroyed) res.destroy();
          resolve(false);
        };
        if (abort.signal.aborted) onAbort();
        else abort.signal.addEventListener("abort", onAbort, { once: true });
      });
      let writeCompleted;
      try {
        writeCompleted = await Promise.race([writeOrDrain(res, value), aborted]);
      } finally {
        abort.signal.removeEventListener("abort", onAbort);
      }
      if (!writeCompleted) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function safeFailure(error, abort) {
  if (error?.statusCode && !isAbortLikeError(error)) return error;
  if (abort?.signal.aborted || isAbortLikeError(error)) {
    return localError(
      abortErrorStatusCode(abort?.reason),
      "upstream_timeout",
      "PM Studio relay upstream request timed out or was cancelled",
    );
  }
  return localError(502, "upstream_error", "PM Studio relay upstream request failed");
}

function releaseOnce(release) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release?.();
  };
}

export function createPmStudioRelayHandler(options = {}) {
  const runtime = loadRuntimeConfig();
  const acquireRequest = options.acquireRequest || createRequestAdmission();
  const fetchImpl = options.fetchImpl || fetch;
  const upstreamTimeoutMs = parsePositiveInteger(options.upstreamTimeoutMs, runtime.upstreamTimeoutMs);
  const streamHandshakeTimeoutMs = parsePositiveInteger(options.streamHandshakeTimeoutMs, runtime.streamHandshakeTimeoutMs);
  const streamIdleTimeoutMs = parsePositiveInteger(options.streamIdleTimeoutMs, runtime.streamIdleTimeoutMs);
  const validationTtlMs = parsePositiveInteger(options.validationTtlMs, DEFAULT_VALIDATION_TTL_MS);
  const validationCacheSize = parsePositiveInteger(options.validationCacheSize, DEFAULT_VALIDATION_CACHE_SIZE, 4096);
  const validationConcurrency = parsePositiveInteger(
    options.validationConcurrency, DEFAULT_VALIDATION_CONCURRENCY, 64,
  );
  const validationMaxFlights = parsePositiveInteger(
    options.validationMaxFlights, DEFAULT_VALIDATION_MAX_FLIGHTS, 4096,
  );
  const validationMaxWaiters = parsePositiveInteger(
    options.validationMaxWaiters, DEFAULT_VALIDATION_MAX_WAITERS, 4096,
  );
  const now = typeof options.now === "function" ? options.now : Date.now;
  const validated = new Map();
  const validationFlights = new Map();
  let activeModelRequests = 0;
  const modelRouter = createPmStudioModelRouter({
    getCatalog: () => options.claudeModelRegistry?.models,
    isClaudeEnabled: () => options.claudeMode === "isolated"
      && options.claudeProfile?.valid === true
      && typeof options.claudeClient?.chatCompletions === "function",
  });

  function isValidated(fingerprint) {
    const expiresAt = validated.get(fingerprint);
    if (!expiresAt) return false;
    if (expiresAt <= now()) {
      validated.delete(fingerprint);
      return false;
    }
    return true;
  }

  function rememberValidation(fingerprint, token) {
    const currentTime = now();
    const parsedExpiry = tokenExpiryMs(token);
    if (parsedExpiry === null) return;
    const expiresAt = Math.min(currentTime + validationTtlMs, parsedExpiry);
    if (expiresAt <= currentTime) return;
    validated.delete(fingerprint);
    while (validated.size >= validationCacheSize) validated.delete(validated.keys().next().value);
    validated.set(fingerprint, expiresAt);
  }

  async function fetchEnterprise(pathname, method, inboundHeaders, token, bodyText, signal) {
    const response = await fetchImpl(`${COPILOT_ORIGIN}${pathname}`, {
      method,
      headers: enterpriseHeaders(inboundHeaders, token, bodyText),
      body: bodyText,
      signal,
      redirect: "manual",
    });
    return rejectUpstreamRedirect(response);
  }

  async function fetchEnterpriseModels(inboundHeaders, token, signal) {
    if (activeModelRequests >= validationConcurrency) {
      throw localError(503, "validation_busy", "PM Studio bearer validation is busy; retry shortly");
    }
    activeModelRequests += 1;
    try {
      return await fetchEnterprise(
        "/models", "GET", inboundHeaders, token, undefined, signal,
      ).then(responseSnapshot);
    } finally {
      activeModelRequests -= 1;
    }
  }

  function trustedClaudeChatUrl() {
    const rawBase = String(options.claudeClient?.getApiBase?.() || COPILOT_ORIGIN);
    let base;
    let target;
    try {
      base = new URL(rawBase);
      target = new URL(`${rawBase}/chat/completions`);
    } catch {
      throw localError(502, "invalid_upstream", "Claude client selected an invalid upstream URL");
    }
    if (base.protocol !== "https:"
      || base.username
      || base.password
      || base.search
      || base.hash
      || target.username
      || target.password) {
      throw localError(502, "invalid_upstream", "Claude client selected an unsupported upstream URL");
    }
    return target.href;
  }

  async function fetchClaudeUpstream(url, init = {}) {
    let target;
    try {
      target = new URL(url);
    } catch {
      throw localError(502, "invalid_upstream", "Claude client selected an invalid upstream URL");
    }
    if (target.href !== trustedClaudeChatUrl()) {
      throw localError(502, "invalid_upstream", "Claude client selected an unsupported upstream URL");
    }
    return rejectUpstreamRedirect(await fetchImpl(target.href, { ...init, redirect: "manual" }));
  }

  function validateBearer(token, inboundHeaders, signal) {
    const fingerprint = tokenFingerprint(token);
    if (isValidated(fingerprint)) return Promise.resolve(null);
    let flight = validationFlights.get(fingerprint);
    if (!flight) {
      if (validationFlights.size >= validationMaxFlights) {
        return Promise.reject(localError(
          503, "validation_busy", "PM Studio bearer validation is busy; retry shortly",
        ));
      }
      const controller = new AbortController();
      flight = { controller, waiters: 0, settled: false, promise: null };
      flight.promise = fetchEnterpriseModels(inboundHeaders, token, controller.signal)
        .then((snapshot) => {
          if (snapshot.ok) rememberValidation(fingerprint, token);
          return snapshot;
        })
        .finally(() => {
          flight.settled = true;
          if (validationFlights.get(fingerprint) === flight) validationFlights.delete(fingerprint);
        });
      validationFlights.set(fingerprint, flight);
    }
    if (flight.waiters >= validationMaxWaiters) {
      return Promise.reject(localError(
        503, "validation_busy", "PM Studio bearer validation is busy; retry shortly",
      ));
    }
    return waitForFlight(flight, signal);
  }

  async function handleModels(req, res, token, abort) {
    const validation = await validateBearer(token, req.headers, abort.signal);
    const snapshot = validation || await fetchEnterpriseModels(req.headers, token, abort.signal);
    if (!snapshot.ok) {
      sendSnapshot(res, snapshot);
      return;
    }
    const merged = mergeModelCatalog(snapshot, modelRouter);
    if (!merged) {
      sendSnapshot(res, snapshot);
      return;
    }
    res.writeHead(snapshot.status, responseHeaders(snapshot.headers, merged, { contentType: "application/json" }));
    res.end(merged);
  }

  async function handlePost(req, res, pathname, token, abort) {
    let releaseRequest = releaseOnce();
    try {
      releaseRequest = releaseOnce(await acquireRequest(req, { signal: abort.signal }));
      const body = await readJsonBody(req);
      const supportsStream = pathname === "/chat/completions" || pathname === "/responses";
      const streaming = supportsStream && body?.stream === true;
      const requestTimeoutMs = streaming ? streamHandshakeTimeoutMs : upstreamTimeoutMs;
      const timeoutReason = streaming ? "stream_handshake_timeout" : "upstream_timeout";
      abort.setTimeout(requestTimeoutMs, timeoutReason);

      const validation = await validateBearer(token, req.headers, abort.signal);
      if (validation && !validation.ok) {
        releaseRequest();
        sendSnapshot(res, validation);
        return;
      }
      abort.setTimeout(requestTimeoutMs, timeoutReason);

      const modelType = modelRouter.classify(body?.model);
      if (modelType === "unsupported_claude" || (modelType === "claude" && pathname !== "/chat/completions")) {
        throw localError(400, "model_not_supported", "The requested Claude model is not available for this endpoint");
      }

      let upstream;
      if (modelType === "claude") {
        upstream = await options.claudeClient.chatCompletions(body, {
          signal: abort.signal,
          fetchImpl: fetchClaudeUpstream,
        });
      } else {
        const bodyText = JSON.stringify(body);
        upstream = await fetchEnterprise(pathname, "POST", req.headers, token, bodyText, abort.signal);
      }
      releaseRequest();
      await relayUpstreamResponse(upstream, supportsStream ? body : null, res, abort, streamIdleTimeoutMs);
    } finally {
      releaseRequest();
    }
  }

  return async function handlePmStudioRelay(req, res, suppliedPathname) {
    const pathname = suppliedPathname || new URL(req.url || "/", "http://localhost").pathname;
    if (!pathname.startsWith(`${PM_STUDIO_RELAY_PREFIX}/`)) return false;
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendLocalError(res, 403, "loopback_required", "PM Studio relay is available only from loopback");
      return true;
    }
    const token = bearerToken(req.headers);
    if (!token) {
      sendLocalError(res, 401, "invalid_authorization", "A bearer Authorization header is required", {
        "WWW-Authenticate": "Bearer",
      });
      return true;
    }
    if (/\bupgrade\b/i.test(String(req.headers?.connection || "")) || req.headers?.upgrade) {
      sendLocalError(res, 426, "upgrade_not_supported", "Protocol upgrade is not supported");
      return true;
    }

    const upstreamPath = pathname.slice(PM_STUDIO_RELAY_PREFIX.length);
    const allowedMethod = upstreamPath === "/models" ? "GET" : POST_PATHS.has(upstreamPath) ? "POST" : null;
    if (!allowedMethod) {
      sendLocalError(res, 404, "route_not_found", "PM Studio relay route not found");
      return true;
    }
    if (req.method !== allowedMethod) {
      sendLocalError(res, 405, "method_not_allowed", "Method is not allowed for this PM Studio relay route", {
        Allow: allowedMethod,
      });
      return true;
    }

    const abort = createRequestAbort(req, res);
    try {
      if (upstreamPath === "/models") {
        abort.setTimeout(upstreamTimeoutMs, "upstream_timeout");
        await handleModels(req, res, token, abort);
      } else {
        await handlePost(req, res, upstreamPath, token, abort);
      }
    } catch (error) {
      const safe = safeFailure(error, abort);
      if (res.headersSent) {
        if (!res.destroyed) res.destroy();
      } else {
        sendJsonError(res, safe, safe.statusCode || 502);
      }
    } finally {
      abort.cleanup();
    }
    return true;
  };
}
