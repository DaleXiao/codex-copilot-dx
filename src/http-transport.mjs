import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { loadRuntimeConfig, parsePositiveInteger } from "./runtime-config.mjs";
import { status } from "./status.mjs";
import { safeUpstreamResponseHeaders } from "./upstream-headers.mjs";

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

export const MAX_UPSTREAM_ERROR_BODY_BYTES = 1024 * 1024;
export const MAX_UPSTREAM_MODEL_CATALOG_BYTES = 8 * 1024 * 1024;
export const MAX_UPSTREAM_RETRY_DRAIN_BYTES = 64 * 1024;
export const MAX_UPSTREAM_CHAT_SUCCESS_BODY_BYTES = HTTP_RUNTIME_CONFIG.maxUpstreamChatResponseBytes;
export const MAX_UPSTREAM_RESPONSES_SUCCESS_BODY_BYTES = HTTP_RUNTIME_CONFIG.maxUpstreamResponsesResponseBytes;

export function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function upstreamBodyTooLarge(label, maxBytes) {
  const error = httpError(`${label} exceeds ${maxBytes} bytes`, 502);
  error.code = "ccdx_upstream_response_too_large";
  error.jsonBody = {
    error: {
      message: error.message,
      type: "upstream_error",
      code: error.code,
    },
  };
  return error;
}

function unreadableUpstreamBody(label) {
  const error = httpError(`${label} is not a readable web stream`, 502);
  error.code = "ccdx_upstream_response_unreadable";
  error.jsonBody = {
    error: {
      message: error.message,
      type: "upstream_error",
      code: error.code,
    },
  };
  return error;
}

async function cancelResponseBody(response) {
  try { await response?.body?.cancel?.(); } catch {}
}

function responseAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function readResponseChunk(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(responseAbortError(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => {
      const error = responseAbortError(signal);
      try { Promise.resolve(reader.cancel(error)).catch(() => {}); } catch {}
      finish(reject, error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function responseContentLength(response) {
  const raw = response?.headers?.get?.("content-length")
    ?? response?.headers?.["content-length"]
    ?? response?.headers?.["Content-Length"];
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export async function readBoundedResponseBuffer(response, {
  maxBytes,
  label = "Upstream response body",
  signal,
} = {}) {
  const limit = Number.isFinite(maxBytes) && maxBytes >= 0 ? Math.floor(maxBytes) : 0;
  if (signal?.aborted) {
    cancelResponseBody(response);
    throw responseAbortError(signal);
  }
  if (responseContentLength(response) > limit) {
    await cancelResponseBody(response);
    throw upstreamBodyTooLarge(label, limit);
  }
  if (!response?.body) {
    if (typeof response?.text === "function") {
      const buffer = Buffer.from(await response.text());
      if (buffer.length > limit) throw upstreamBodyTooLarge(label, limit);
      return buffer;
    }
    if ((responseContentLength(response) || 0) > 0) throw unreadableUpstreamBody(label);
    return Buffer.alloc(0);
  }
  const reader = response?.body?.getReader?.();
  if (!reader) throw unreadableUpstreamBody(label);
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readResponseChunk(reader, signal);
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw upstreamBodyTooLarge(label, limit);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } finally {
    try {
      reader.releaseLock();
    } catch (error) {
      if (!signal?.aborted) throw error;
    }
  }
}

export async function readBoundedResponseText(response, options) {
  return new TextDecoder().decode(await readBoundedResponseBuffer(response, options));
}

export async function discardBoundedResponseBody(response, maxBytes = MAX_UPSTREAM_RETRY_DRAIN_BYTES) {
  try {
    await readBoundedResponseBuffer(response, { maxBytes, label: "Upstream retry response body" });
    return true;
  } catch {
    await cancelResponseBody(response);
    return false;
  }
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

function createSupplementalAdmission({ maxWeight, maxQueued, waitTimeoutMs, label, blockBehindExclusive = false }) {
  const queue = [];
  let activeWeight = 0;
  let activeRequestedWeight = 0;
  let activeRequests = 0;

  const activate = (entry) => {
    entry.cleanup();
    activeWeight += entry.weight;
    activeRequestedWeight += entry.requestedWeight;
    activeRequests += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeWeight = Math.max(0, activeWeight - entry.weight);
      activeRequestedWeight = Math.max(0, activeRequestedWeight - entry.requestedWeight);
      activeRequests = Math.max(0, activeRequests - 1);
      drain();
    };
    release.resize = (requestedWeight) => {
      if (released) return 0;
      const parsedWeight = Number.isFinite(requestedWeight) && requestedWeight > 0
        ? Math.ceil(requestedWeight)
        : maxWeight;
      const requested = Math.max(1, parsedWeight);
      const weight = Math.min(requested, maxWeight);
      if (weight > entry.weight) {
        throw new RangeError(`${label} admission weight cannot grow`);
      }
      activeWeight = Math.max(0, activeWeight - (entry.weight - weight));
      activeRequestedWeight = Math.max(0, activeRequestedWeight + requested - entry.requestedWeight);
      entry.weight = weight;
      entry.requestedWeight = requested;
      drain();
      return weight;
    };
    Object.defineProperties(release, {
      weight: { get: () => released ? 0 : entry.weight },
      requestedWeight: { get: () => released ? 0 : entry.requestedWeight },
      maxWeight: { value: maxWeight },
    });
    entry.resolve(release);
  };

  const drain = () => {
    for (let index = 0; index < queue.length;) {
      const entry = queue[index];
      if (activeWeight + entry.weight > maxWeight) {
        if (blockBehindExclusive && entry.weight === maxWeight) break;
        index += 1;
        continue;
      }
      queue.splice(index, 1);
      activate(entry);
    }
  };

  const acquire = (requestedWeight, { signal } = {}) => {
    if (signal?.aborted) return Promise.reject(admissionAbortError(signal));
    const parsedWeight = Number.isFinite(requestedWeight) && requestedWeight > 0
      ? Math.ceil(requestedWeight)
      : maxWeight;
    const requested = Math.max(1, parsedWeight);
    const weight = Math.min(requested, maxWeight);
    const blockedByExclusive = blockBehindExclusive
      && queue.some((entry) => entry.weight === maxWeight);
    const mustWait = blockedByExclusive || activeWeight + weight > maxWeight;
    if (queue.length >= maxQueued && mustWait) {
      return Promise.reject(httpError(`${label} queue is full (${maxQueued} waiting)`, 503));
    }

    return new Promise((resolve, reject) => {
      let timer;
      const entry = {
        weight,
        requestedWeight: requested,
        resolve,
        cleanup: () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      const remove = () => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
      };
      const fail = (error) => {
        entry.cleanup();
        remove();
        reject(error);
        drain();
      };
      const onAbort = () => fail(admissionAbortError(signal));
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        fail(httpError(`${label} admission timed out after ${waitTimeoutMs}ms`, 503));
      }, waitTimeoutMs);
      timer.unref?.();
      queue.push(entry);
      if (signal?.aborted) onAbort();
      else drain();
    });
  };

  acquire.stats = () => ({
    activeWeight,
    activeRequestedWeight,
    activeRequests,
    queued: queue.length,
    maxWeight,
  });
  return acquire;
}

export function createRequestAdmission({
  maxBytes = MAX_INFLIGHT_BODY_BYTES,
  maxQueued = MAX_QUEUED_REQUESTS,
  waitTimeoutMs = REQUEST_QUEUE_TIMEOUT_MS,
} = {}) {
  const byteLimit = parsePositiveInteger(maxBytes, MAX_INFLIGHT_BODY_BYTES);
  const queueLimit = parsePositiveInteger(maxQueued, MAX_QUEUED_REQUESTS);
  const timeoutMs = parsePositiveInteger(waitTimeoutMs, REQUEST_QUEUE_TIMEOUT_MS);
  const acquireDecompression = createSupplementalAdmission({
    maxWeight: 1,
    maxQueued: queueLimit,
    waitTimeoutMs: timeoutMs,
    label: "Request decompression",
  });
  const acquireDecodedBody = createSupplementalAdmission({
    maxWeight: byteLimit,
    maxQueued: queueLimit,
    waitTimeoutMs: timeoutMs,
    label: "Decoded request body",
    blockBehindExclusive: true,
  });
  const acquireResponseHistory = createSupplementalAdmission({
    maxWeight: byteLimit,
    maxQueued: queueLimit,
    waitTimeoutMs: timeoutMs,
    label: "Response history",
  });
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
    const supplementalReleases = new Set();
    const release = () => {
      if (released) return;
      released = true;
      for (const releaseSupplemental of supplementalReleases) releaseSupplemental();
      supplementalReleases.clear();
      activeBytes = Math.max(0, activeBytes - entry.weight);
      activeRequests = Math.max(0, activeRequests - 1);
      drain();
    };
    const reserve = async (gate, weight, options) => {
      const releaseSupplemental = await gate(weight, options);
      if (released) {
        releaseSupplemental();
        throw admissionAbortError(options?.signal);
      }
      let supplementalReleased = false;
      const releaseReservation = () => {
        if (supplementalReleased) return;
        supplementalReleased = true;
        supplementalReleases.delete(releaseReservation);
        releaseSupplemental();
      };
      releaseReservation.resize = (nextWeight) => {
        if (supplementalReleased) return 0;
        return releaseSupplemental.resize(nextWeight);
      };
      Object.defineProperties(releaseReservation, {
        weight: { get: () => supplementalReleased ? 0 : releaseSupplemental.weight },
        requestedWeight: {
          get: () => supplementalReleased ? 0 : releaseSupplemental.requestedWeight,
        },
        maxWeight: { value: releaseSupplemental.maxWeight },
      });
      supplementalReleases.add(releaseReservation);
      return releaseReservation;
    };
    release.acquireDecompression = (options) => acquireDecompression(1, options);
    release.reserveDecodedBody = (bytes, options) => reserve(acquireDecodedBody, bytes, options);
    release.reserveDecodedBody.supportsResize = true;
    release.reserveResponseHistory = (bytes, options) => reserve(acquireResponseHistory, bytes, options);
    entry.resolve(release);
  };

  const drain = () => {
    for (let index = 0; index < queue.length;) {
      const entry = queue[index];
      if (entry.cancelled) {
        queue.splice(index, 1);
        continue;
      }
      if (activeBytes + entry.weight > byteLimit) {
        // Unknown-length requests reserve the whole budget. Once one is waiting,
        // do not let later arrivals keep extending its wait indefinitely.
        if (entry.weight === byteLimit) break;
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
    const blockedByExclusive = queue.some((entry) => !entry.cancelled && entry.weight === byteLimit);
    const mustWait = blockedByExclusive || activeBytes + weight > byteLimit;
    if (queue.length >= queueLimit && mustWait) {
      counters.rejected += 1;
      return Promise.reject(httpError(`Request queue is full (${queueLimit} waiting)`, 503));
    }
    if (mustWait) counters.queued += 1;

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
    decompressionsActive: acquireDecompression.stats().activeRequests,
    decompressionsQueued: acquireDecompression.stats().queued,
    decodedBodyBytes: acquireDecodedBody.stats().activeRequestedWeight,
    decodedBodyAdmissionBytes: acquireDecodedBody.stats().activeWeight,
    decodedBodiesActive: acquireDecodedBody.stats().activeRequests,
    decodedBodiesQueued: acquireDecodedBody.stats().queued,
    responseHistoryBytes: acquireResponseHistory.stats().activeWeight,
    responseHistoriesActive: acquireResponseHistory.stats().activeRequests,
    responseHistoriesQueued: acquireResponseHistory.stats().queued,
  });
  return acquire;
}

function consumeRequestChunks(req, { signal, onChunk }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      req.off("data", handleData);
      req.off("end", handleEnd);
      req.off("error", handleError);
      req.off("aborted", handleAborted);
      signal?.removeEventListener("abort", handleSignalAbort);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const stopReading = (error) => {
      req.pause?.();
      finish(error);
    };
    const handleData = (chunk) => {
      try {
        onChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      } catch (error) {
        stopReading(error);
      }
    };
    const handleEnd = () => finish();
    const handleError = (error) => finish(error);
    const handleAborted = () => finish(admissionAbortError(signal));
    const handleSignalAbort = () => stopReading(admissionAbortError(signal));

    req.once("end", handleEnd);
    req.once("error", handleError);
    req.once("aborted", handleAborted);
    signal?.addEventListener("abort", handleSignalAbort, { once: true });
    if (signal?.aborted) handleSignalAbort();
    else {
      req.on("data", handleData);
      req.resume?.();
    }
  });
}

async function readRequestBuffer(req, maxBytes, signal) {
  const contentLength = requestContentLength(req);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw payloadTooLarge("Raw", maxBytes);
  }

  const chunks = [];
  let total = 0;
  await consumeRequestChunks(req, {
    signal,
    onChunk(buffer) {
      total += buffer.length;
      if (total > maxBytes) throw payloadTooLarge("Raw", maxBytes);
      chunks.push(buffer);
    },
  });
  return Buffer.concat(chunks);
}

async function readIdentityText(req, maxBodyBytes, maxDecodedBodyBytes, signal) {
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
  await consumeRequestChunks(req, {
    signal,
    onChunk(buffer) {
      total += buffer.length;
      if (total > maxBodyBytes) throw payloadTooLarge("Raw", maxBodyBytes);
      if (total > maxDecodedBodyBytes) throw payloadTooLarge("Decoded", maxDecodedBodyBytes);
      text += decoder.decode(buffer, { stream: true });
    },
  });
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
  admission,
  maxBodyBytes = MAX_BODY_BYTES,
  maxDecodedBodyBytes = MAX_DECODED_BODY_BYTES,
  signal,
} = {}) {
  if (signal?.aborted) throw admissionAbortError(signal);
  const encodings = contentEncodings(req.headers?.["content-encoding"]);
  if (encodings.every((encoding) => encoding === "identity")) {
    return parseRequestJson(await readIdentityText(req, maxBodyBytes, maxDecodedBodyBytes, signal));
  }
  const buffer = await readRequestBuffer(req, maxBodyBytes, signal);
  let releaseDecompression = () => {};
  let decodedReservation;
  let retainDecodedReservation = false;
  try {
    let decoded;
    const supportsResizableReservation = admission?.reserveDecodedBody?.supportsResize === true;
    // Most compressed bodies fit the existing 4x admission estimate. High-ratio bodies retry
    // only after obtaining the pool's exclusive reservation, so a full decoded body never waits
    // outside the decoded-body budget.
    const estimatedDecodedBytes = Math.max(
      1,
      Math.min(buffer.length * COMPRESSED_BODY_WEIGHT_MULTIPLIER, maxDecodedBodyBytes),
    );
    if (supportsResizableReservation) {
      decodedReservation = await admission.reserveDecodedBody(estimatedDecodedBytes, { signal });
    }
    releaseDecompression = await admission?.acquireDecompression?.({ signal }) || (() => {});
    const reservedBytes = decodedReservation?.requestedWeight;
    const reservedAdmissionBytes = decodedReservation?.weight;
    const decodedPoolBytes = decodedReservation?.maxWeight;
    const tentativeDecodeLimit = Number.isFinite(reservedBytes)
      && Number.isFinite(reservedAdmissionBytes)
      && Number.isFinite(decodedPoolBytes)
      && reservedAdmissionBytes < decodedPoolBytes
      ? Math.min(reservedBytes, maxDecodedBodyBytes)
      : maxDecodedBodyBytes;
    try {
      decoded = await decodeRequestBuffer(buffer, req.headers?.["content-encoding"], tentativeDecodeLimit);
    } catch (e) {
      if (e?.statusCode === 413 && tentativeDecodeLimit < maxDecodedBodyBytes && supportsResizableReservation) {
        releaseDecompression();
        releaseDecompression = () => {};
        decodedReservation();
        decodedReservation = await admission.reserveDecodedBody(maxDecodedBodyBytes, { signal });
        releaseDecompression = await admission.acquireDecompression?.({ signal }) || (() => {});
        try {
          decoded = await decodeRequestBuffer(buffer, req.headers?.["content-encoding"], maxDecodedBodyBytes);
        } catch (retryError) {
          if (retryError?.statusCode) throw retryError;
          throw httpError(`Invalid compressed request body: ${retryError.message}`, 400);
        }
      } else {
        if (e?.statusCode) throw e;
        throw httpError(`Invalid compressed request body: ${e.message}`, 400);
      }
    }
    if (signal?.aborted) throw admissionAbortError(signal);
    if (decoded.length > 0) {
      if (supportsResizableReservation) decodedReservation.resize(decoded.length);
      else decodedReservation = await admission?.reserveDecodedBody?.(decoded.length, { signal });
    }
    const parsed = parseRequestJson(decoded.toString("utf8"));
    retainDecodedReservation = true;
    return parsed;
  } finally {
    if (!retainDecodedReservation) decodedReservation?.();
    releaseDecompression();
  }
}

export function sendJsonError(res, err, fallbackStatus = 400) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  const statusCode = err?.statusCode || fallbackStatus;
  const headers = { "Content-Type": "application/json" };
  if (statusCode === 408 || statusCode === 413) headers.Connection = "close";
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(err?.jsonBody || { error: err?.message || "Request failed" }));
}

export function sendUpstreamError(res, response, text) {
  if (!res.headersSent) {
    res.writeHead(response.status || 502, safeUpstreamResponseHeaders(response.headers, {
      defaultContentType: "application/json",
    }));
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
  if (reason === "request_body_timeout") return 408;
  if (["responses_prepare_timeout", "upstream_timeout", "stream_handshake_timeout", "stream_idle_timeout"].includes(reason)) return 504;
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
    abort,
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
