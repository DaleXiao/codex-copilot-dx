import { isMissingCallIdError } from "./responses-tool-output.mjs";
import { isRootToolSchemaError } from "./messages-tool-schema.mjs";

// Only fixed, documented-shaped codes leave this module; vendor messages and
// request data are never returned or logged.
const reasons = new Map([
  ["credit_balance_exhausted", { statuses: [429], message: "The source account has no remaining credits." }],
  ["insufficient_quota", { statuses: [429], message: "The source account has insufficient quota." }],
  ["quota_exceeded", { statuses: [429], message: "The source account has exceeded its quota." }],
  ["rate_limit_exceeded", { statuses: [429], message: "The source request rate limit was reached." }],
  ["rate_limit_error", { statuses: [429], message: "The source request rate limit was reached." }],
  ["context_length_exceeded", { statuses: [400, 413, 422], message: "The source reports that the context is too long." }],
  ["context_window_exceeded", { statuses: [400, 413, 422], message: "The source reports that the context is too long." }],
  ["content_policy_violation", { statuses: [400, 403, 422], message: "The source rejected the request under its content policy." }],
]);
const MAX_ACTIVE_READS = 4;
let activeReads = 0;

function cancelBody(body) {
  try { void Promise.resolve(body?.cancel()).catch(() => {}); } catch {}
}

export function safeUpstreamReason(code, status) {
  const reason = typeof code === "string" ? reasons.get(code) : null;
  return reason?.statuses.includes(status) ? { code, message: reason.message } : null;
}

function readChunk(reader, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (settled) return;settled = true;signal.removeEventListener("abort", onAbort);fn(value); };
    const onAbort = () => finish(reject, signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) onAbort();
  });
}

// Failure responses only. A stalled body or a stalled cancellation cannot delay
// the caller beyond the budget. The original request's cancellation wins.
export async function readSafeUpstreamReason(response, { signal, timeoutMs = 200, maxBytes = 64 * 1024, missingCallId = false, rootToolSchema = false } = {}) {
  if (signal?.aborted) {
    cancelBody(response?.body);
    signal.throwIfAborted();
  }
  if (!response?.body) return null;
  if (activeReads >= MAX_ACTIVE_READS) { cancelBody(response.body);return null; }
  activeReads++;
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  const readSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let reader, finished = false;
  try {
    const length = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(length) && length > maxBytes) return null;
    reader = response.body.getReader();const chunks = [];let bytes = 0;
    while (true) {
      if (performance.now() >= deadline) controller.abort();
      const { done, value } = await readChunk(reader, readSignal);
      if (done) { finished = true;break; }
      if (Number.isFinite(value?.byteLength) && bytes + value.byteLength > maxBytes) return null;
      const chunk = Buffer.from(value);bytes += chunk.length;
      if (bytes > maxBytes) return null;
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks, bytes).toString("utf8");
    if (missingCallId && isMissingCallIdError(response.status, text)) return { code: "ccdx_missing_call_id", message: "The source requires a tool call ID." };
    if (rootToolSchema && isRootToolSchemaError(response.status, text)) return { code: "ccdx_tool_schema_root_unsupported", message: "The source rejected a tool's root schema." };
    let value;try { value = JSON.parse(text); } catch { return null; }
    const error = value?.error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return null;
    return safeUpstreamReason(error.code, response.status) || safeUpstreamReason(error.type, response.status);
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    return null;
  } finally {
    clearTimeout(timer);
    if (!finished) {
      try { void Promise.resolve(reader ? reader.cancel() : response.body.cancel()).catch(() => {}); } catch {}
    }
    try { reader?.releaseLock(); } catch {}
    activeReads--;
  }
}
