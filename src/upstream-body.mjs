import { httpError } from "./http-errors.mjs";

export const MAX_UPSTREAM_ERROR_BODY_BYTES = 1024 * 1024;
export const MAX_UPSTREAM_MODEL_CATALOG_BYTES = 8 * 1024 * 1024;
export const MAX_UPSTREAM_RETRY_DRAIN_BYTES = 64 * 1024;

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
