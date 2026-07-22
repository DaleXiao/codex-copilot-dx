import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { loadRuntimeConfig, parsePositiveInteger } from "./runtime-config.mjs";
import { status } from "./status.mjs";

const COMPRESSED_BODY_WEIGHT_MULTIPLIER = 4;
const gunzipAsync = promisify(zlib.gunzip);
const inflateAsync = promisify(zlib.inflate);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);
const zstdDecompressAsync = zlib.zstdDecompress ? promisify(zlib.zstdDecompress) : null;

const HTTP_RUNTIME_CONFIG = loadRuntimeConfig();
const MAX_BODY_BYTES = HTTP_RUNTIME_CONFIG.maxBodyBytes;
const MAX_DECODED_BODY_BYTES = HTTP_RUNTIME_CONFIG.maxDecodedBodyBytes;
const MAX_INFLIGHT_BODY_BYTES = HTTP_RUNTIME_CONFIG.maxInflightBodyBytes;
const MAX_QUEUED_REQUESTS = HTTP_RUNTIME_CONFIG.maxQueuedRequests;
const REQUEST_QUEUE_TIMEOUT_MS = HTTP_RUNTIME_CONFIG.requestQueueTimeoutMs;

export function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function payloadTooLarge(kind, maxBytes) {
  return httpError(`${kind} request body exceeds ${maxBytes} bytes`, 413);
}

function requestContentLength(req) {
  return Number.parseInt(req.headers?.["content-length"] || "", 10);
}

function requestAdmissionWeight(req, maxBytes) {
  const encodings = contentEncodings(req.headers?.["content-encoding"]);
  const contentLength = requestContentLength(req);
  if (!Number.isFinite(contentLength) || contentLength < 0) return maxBytes;
  const compressed = encodings.some((encoding) => encoding !== "identity");
  const weightedLength = compressed ? contentLength * COMPRESSED_BODY_WEIGHT_MULTIPLIER : contentLength;
  return Math.max(1, Math.min(weightedLength, maxBytes));
}

function admissionAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

export function createRequestAdmission({
  maxBytes = MAX_INFLIGHT_BODY_BYTES,
  maxQueued = MAX_QUEUED_REQUESTS,
  waitTimeoutMs = REQUEST_QUEUE_TIMEOUT_MS,
} = {}) {
  const byteLimit = parsePositiveInteger(maxBytes, MAX_INFLIGHT_BODY_BYTES);
  const queueLimit = parsePositiveInteger(maxQueued, MAX_QUEUED_REQUESTS);
  const timeoutMs = parsePositiveInteger(waitTimeoutMs, REQUEST_QUEUE_TIMEOUT_MS);
  const queue = [];
  let activeBytes = 0;
  let activeRequests = 0;
  const counters = {
    total: 0,
    activated: 0,
    queued: 0,
    rejected: 0,
    timedOut: 0,
    aborted: 0,
    waitMsTotal: 0,
    waitMsMax: 0,
  };

  const remove = (entry) => {
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
  };

  const activate = (entry) => {
    entry.cleanup();
    activeBytes += entry.weight;
    activeRequests += 1;
    counters.activated += 1;
    const waitMs = Math.max(0, Date.now() - entry.startedAt);
    counters.waitMsTotal += waitMs;
    counters.waitMsMax = Math.max(counters.waitMsMax, waitMs);
    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true;
      activeBytes = Math.max(0, activeBytes - entry.weight);
      activeRequests = Math.max(0, activeRequests - 1);
      drain();
    });
  };

  const drain = () => {
    for (let index = 0; index < queue.length;) {
      const entry = queue[index];
      if (entry.cancelled) {
        queue.splice(index, 1);
        continue;
      }
      if (activeBytes + entry.weight > byteLimit) {
        index += 1;
        continue;
      }
      queue.splice(index, 1);
      activate(entry);
    }
  };

  const acquire = (req, { signal } = {}) => {
    counters.total += 1;
    if (signal?.aborted) {
      counters.aborted += 1;
      return Promise.reject(admissionAbortError(signal));
    }
    const weight = requestAdmissionWeight(req, byteLimit);
    if (queue.length >= queueLimit && activeBytes + weight > byteLimit) {
      counters.rejected += 1;
      return Promise.reject(httpError(`Request queue is full (${queueLimit} waiting)`, 503));
    }
    if (activeBytes + weight > byteLimit) counters.queued += 1;

    return new Promise((resolve, reject) => {
      let timer;
      const entry = {
        cancelled: false,
        startedAt: Date.now(),
        weight,
        resolve,
        cleanup: () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      const cancel = (error, reason) => {
        if (entry.cancelled) return;
        entry.cancelled = true;
        if (reason === "aborted") counters.aborted += 1;
        if (reason === "timed_out") counters.timedOut += 1;
        entry.cleanup();
        remove(entry);
        reject(error);
        drain();
      };
      const onAbort = () => cancel(admissionAbortError(signal), "aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        cancel(httpError(`Request admission timed out after ${timeoutMs}ms`, 503), "timed_out");
      }, timeoutMs);
      timer.unref?.();
      queue.push(entry);
      if (signal?.aborted) onAbort();
      else drain();
    });
  };

  acquire.stats = () => ({ activeBytes, queued: queue.length, maxBytes: byteLimit });
  acquire.diagnostics = () => ({
    activeBytes,
    activeRequests,
    queued: queue.length,
    maxBytes: byteLimit,
    maxQueued: queueLimit,
    waitTimeoutMs: timeoutMs,
    total: counters.total,
    activated: counters.activated,
    queuedTotal: counters.queued,
    rejected: counters.rejected,
    timedOut: counters.timedOut,
    aborted: counters.aborted,
    waitMsAvg: counters.activated > 0
      ? Number((counters.waitMsTotal / counters.activated).toFixed(1))
      : 0,
    waitMsMax: counters.waitMsMax,
  });
  return acquire;
}

async function readRequestBuffer(req, maxBytes) {
  const contentLength = requestContentLength(req);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw payloadTooLarge("Raw", maxBytes);
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw payloadTooLarge("Raw", maxBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readIdentityText(req, maxBodyBytes, maxDecodedBodyBytes) {
  const contentLength = requestContentLength(req);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    throw payloadTooLarge("Raw", maxBodyBytes);
  }
  if (Number.isFinite(contentLength) && contentLength > maxDecodedBodyBytes) {
    throw payloadTooLarge("Decoded", maxDecodedBodyBytes);
  }

  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBodyBytes) throw payloadTooLarge("Raw", maxBodyBytes);
    if (total > maxDecodedBodyBytes) throw payloadTooLarge("Decoded", maxDecodedBodyBytes);
    text += decoder.decode(buffer, { stream: true });
  }
  return text + decoder.decode();
}

function contentEncodings(contentEncoding) {
  return String(contentEncoding || "identity")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

async function decompressBody(decompress, buffer, maxBytes) {
  try {
    return await decompress(buffer, { maxOutputLength: maxBytes });
  } catch (e) {
    if (e?.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength/i.test(e?.message || "")) {
      throw payloadTooLarge("Decoded", maxBytes);
    }
    throw e;
  }
}

async function decodeRequestBuffer(buffer, contentEncoding, maxBytes) {
  const encodings = contentEncodings(contentEncoding);

  let decoded = buffer;
  for (const encoding of encodings.reverse()) {
    if (encoding === "identity") continue;
    if (encoding === "gzip" || encoding === "x-gzip") {
      decoded = await decompressBody(gunzipAsync, decoded, maxBytes);
    } else if (encoding === "deflate") {
      decoded = await decompressBody(inflateAsync, decoded, maxBytes);
    } else if (encoding === "br") {
      decoded = await decompressBody(brotliDecompressAsync, decoded, maxBytes);
    } else if (encoding === "zstd") {
      if (!zstdDecompressAsync) throw httpError("Unsupported Content-Encoding: zstd", 415);
      decoded = await decompressBody(zstdDecompressAsync, decoded, maxBytes);
    } else {
      throw httpError(`Unsupported Content-Encoding: ${encoding}`, 415);
    }
    if (decoded.length > maxBytes) throw payloadTooLarge("Decoded", maxBytes);
  }
  if (decoded.length > maxBytes) throw payloadTooLarge("Decoded", maxBytes);
  return decoded;
}

function parseRequestJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw httpError(`Invalid JSON request body: ${e.message}`, 400);
  }
}

export async function readJsonBody(req, {
  maxBodyBytes = MAX_BODY_BYTES,
  maxDecodedBodyBytes = MAX_DECODED_BODY_BYTES,
} = {}) {
  const encodings = contentEncodings(req.headers?.["content-encoding"]);
  if (encodings.every((encoding) => encoding === "identity")) {
    return parseRequestJson(await readIdentityText(req, maxBodyBytes, maxDecodedBodyBytes));
  }
  const buffer = await readRequestBuffer(req, maxBodyBytes);
  let decoded;
  try {
    decoded = await decodeRequestBuffer(buffer, req.headers?.["content-encoding"], maxDecodedBodyBytes);
  } catch (e) {
    if (e?.statusCode) throw e;
    throw httpError(`Invalid compressed request body: ${e.message}`, 400);
  }
  return parseRequestJson(decoded.toString("utf8"));
}

export function sendJsonError(res, err, fallbackStatus = 400) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(err?.statusCode || fallbackStatus, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: err?.message || "Request failed" }));
}

export function sendUpstreamError(res, response, text) {
  if (!res.headersSent) {
    res.writeHead(response.status || 502, { "Content-Type": response.headers?.get("content-type") || "application/json" });
  }
  res.end(text || JSON.stringify({ error: "Upstream request failed" }));
}

export function writeOrDrain(res, chunk) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  if (res.write(chunk)) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("error", onError);
      res.off("close", onClose);
    };
    const onDrain = () => { cleanup(); resolve(true); };
    const onClose = () => { cleanup(); resolve(false); };
    const onError = (err) => { cleanup(); reject(err); };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
  });
}

export function isAbortLikeError(err) {
  return err?.name === "AbortError" || /operation was aborted/i.test(String(err?.message || ""));
}

export function abortErrorStatusCode(reason) {
  if (["upstream_timeout", "stream_handshake_timeout", "stream_idle_timeout"].includes(reason)) return 504;
  if (reason === "client_aborted" || reason === "client_closed") return 499;
  return 502;
}

export function createRequestAbort(req, res) {
  const controller = new AbortController();
  let timer = null;
  let cleaned = false;
  let reason = null;
  const abort = (nextReason = "aborted") => {
    if (!cleaned && !controller.signal.aborted) {
      reason = nextReason;
      controller.abort();
    }
  };
  const onReqAborted = () => abort("client_aborted");
  const onResClose = () => {
    if (!res.writableEnded) abort("client_closed");
  };
  req.on("aborted", onReqAborted);
  res.on("close", onResClose);
  return {
    signal: controller.signal,
    get reason() { return reason; },
    setTimeout(ms, nextReason = "upstream_timeout") {
      if (timer) clearTimeout(timer);
      timer = null;
      if (ms > 0) timer = setTimeout(() => abort(nextReason), ms);
    },
    clearTimeout() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    cleanup() {
      cleaned = true;
      if (timer) clearTimeout(timer);
      req.off("aborted", onReqAborted);
      res.off("close", onResClose);
    },
  };
}

export function logRequestFailure(label, err, abort) {
  if (!isAbortLikeError(err)) {
    console.error(status("err", `${label} request failed: ${err.message}`));
    return;
  }

  const reason = abort?.reason || "aborted";
  err.statusCode ||= abortErrorStatusCode(reason);
  console.warn(status("warn", `${label} request aborted: ${reason}`));
}
