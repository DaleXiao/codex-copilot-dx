import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { loadRuntimeConfig } from "./runtime-config.mjs";
import { decodedBodyLimitPreference } from "./user-settings.mjs";
import { status } from "./status.mjs";
import { safeUpstreamResponseHeaders } from "./upstream-headers.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";
import { httpError } from "./http-errors.mjs";
import { admissionAbortError, contentEncodings, requestContentLength } from "./request-admission.mjs";
import { currentRequestContext } from "./request-context.mjs";
import { upstreamErrorEvidence } from "./response-failures.mjs";

export { httpError } from "./http-errors.mjs";
export { createRequestAdmission } from "./request-admission.mjs";

const COMPRESSED_BODY_WEIGHT_MULTIPLIER = 4;
const gunzipAsync = promisify(zlib.gunzip);
const inflateAsync = promisify(zlib.inflate);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);
const zstdDecompressAsync = zlib.zstdDecompress ? promisify(zlib.zstdDecompress) : null;

const HTTP_RUNTIME_CONFIG = loadRuntimeConfig();
const MAX_BODY_BYTES = HTTP_RUNTIME_CONFIG.maxBodyBytes;
export const MAX_DECODED_BODY_BYTES = decodedBodyLimitPreference().bytes;

export {
  MAX_UPSTREAM_ERROR_BODY_BYTES, MAX_UPSTREAM_MODEL_CATALOG_BYTES, MAX_UPSTREAM_RETRY_DRAIN_BYTES,
  readBoundedResponseBuffer, readBoundedResponseText, discardBoundedResponseBody,
} from "./upstream-body.mjs";
export const MAX_UPSTREAM_CHAT_SUCCESS_BODY_BYTES = HTTP_RUNTIME_CONFIG.maxUpstreamChatResponseBytes;
export const MAX_UPSTREAM_RESPONSES_SUCCESS_BODY_BYTES = HTTP_RUNTIME_CONFIG.maxUpstreamResponsesResponseBytes;

function payloadTooLarge(kind, maxBytes) {
  return httpError(`${kind} request body exceeds ${maxBytes} bytes`, 413);
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

  // Larger preallocations raise peak RSS; keep the streaming path for those bodies.
  const preallocatedLength = Number.isFinite(contentLength)
    && contentLength >= 1024 * 1024
    && contentLength <= 24 * 1024 * 1024
    ? contentLength
    : 0;
  let allocated = null;
  let overflow = null;
  const decoder = preallocatedLength ? null : new TextDecoder();
  let text = "";
  let total = 0;
  await consumeRequestChunks(req, {
    signal,
    onChunk(buffer) {
      total += buffer.length;
      if (total > maxBodyBytes) throw payloadTooLarge("Raw", maxBodyBytes);
      if (total > maxDecodedBodyBytes) throw payloadTooLarge("Decoded", maxDecodedBodyBytes);
      if (preallocatedLength) {
        allocated ||= Buffer.allocUnsafe(preallocatedLength);
        if (!overflow && total <= allocated.length) {
          buffer.copy(allocated, total - buffer.length);
        } else {
          if (!overflow) overflow = [allocated.subarray(0, total - buffer.length)];
          overflow.push(buffer);
        }
      } else {
        text += decoder.decode(buffer, { stream: true });
      }
    },
  });
  if (preallocatedLength) {
    if (!allocated) return "";
    return new TextDecoder().decode(overflow ? Buffer.concat(overflow, total) : allocated.subarray(0, total));
  }
  return text + decoder.decode();
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
  const context = currentRequestContext();
  context?.onHttpError?.({ code: err?.code || err?.jsonBody?.error?.code,
    origin: context.errorOrigin || (statusCode < 500 ? "client_validation" : "local_transport") });
  const headers = { "Content-Type": "application/json" };
  if (statusCode === 408 || statusCode === 413) headers.Connection = "close";
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(err?.jsonBody || { error: err?.message || "Request failed" }));
}

export function sendUpstreamError(res, response, text) {
  const context = currentRequestContext();
  if (context?.onHttpError) context.onHttpError({
    ...upstreamErrorEvidence(text, { includeMessage: context.includeHttpErrorDetails === true }),
    origin: "upstream_http", headers: response.headers,
  });
  if (!res.headersSent) {
    res.writeHead(response.status || 502, safeUpstreamResponseHeaders(response.headers, {
      defaultContentType: "application/json",
    }));
  }
  res.end(text || JSON.stringify({ error: "Upstream request failed" }));
}

export function writeOrDrain(res, chunk, { signal } = {}) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  if (signal?.aborted) {
    res.destroy?.();
    return Promise.resolve(false);
  }
  if (res.write(chunk)) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("error", onError);
      res.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const onDrain = () => { cleanup(); resolve(true); };
    const onClose = () => { cleanup(); resolve(false); };
    const onError = (err) => { cleanup(); reject(err); };
    const onAbort = () => { cleanup(); res.destroy?.(); resolve(false); };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
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
    console.error(status("err", `${label} request failed: ${redactDiagnosticText(err.message)}`));
    return;
  }

  const reason = abort?.reason || "aborted";
  err.statusCode ||= abortErrorStatusCode(reason);
  const cancelled = reason === "client_aborted" || reason === "client_closed";
  console[cancelled ? "log" : "warn"](status(cancelled ? "info" : "warn", `${label} request aborted: ${reason}`));
}
