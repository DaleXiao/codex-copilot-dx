import { isMissingCallIdError } from "./responses-tool-output.mjs";
import { isRootToolSchemaError } from "./messages-tool-schema.mjs";
import { redactDiagnosticText, boundedDiagnosticText } from "./diagnostic-text.mjs";

// Default evidence contains only fixed categories. A separately authorized
// one-shot capture can retain a bounded, redacted technical message.
const reasons = new Map([
  ["credit_balance_exhausted", { statuses: [429], message: "The source account has no remaining credits." }],
  ["insufficient_quota", { statuses: [429], message: "The source account has insufficient quota." }],
  ["quota_exceeded", { statuses: [429], message: "The source account has exceeded its quota." }],
  ["rate_limit_exceeded", { statuses: [429], message: "The source request rate limit was reached." }],
  ["rate_limit_error", { statuses: [429], message: "The source request rate limit was reached." }],
  ["context_length_exceeded", { statuses: [400, 413, 422], message: "The source reports that the context is too long." }],
  ["context_window_exceeded", { statuses: [400, 413, 422], message: "The source reports that the context is too long." }],
  ["content_policy_violation", { statuses: [400, 403, 422], message: "The source rejected the request under its content policy." }],
  ["invalid_request_error", { statuses: [400, 422], message: "The source rejected the request parameters." }],
  ["unsupported_parameter", { statuses: [400, 422], message: "The source does not support a requested parameter." }],
  ["output_limit_invalid", { statuses: [400, 422], message: "The source rejected the output token limit." }],
  ["tool_limit_exceeded", { statuses: [400, 422], message: "The source rejected the number of tool definitions." }],
  ["reasoning_parameter_unsupported", { statuses: [400, 422], message: "The source does not support the requested reasoning parameter." }],
  ["authentication_error", { statuses: [401], message: "The source rejected authentication." }],
  ["permission_denied", { statuses: [403], message: "The source denied access to this model or operation." }],
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

export function safeUpstreamParameter(value){
  return typeof value==="string"&&value.length<=160&&/^(?:model|messages|input|tools|tool_choice|reasoning|output_config|thinking|temperature|top_p|max_tokens|max_output_tokens|max_completion_tokens|response_format|text|stream|stream_options|stop|stop_sequences)(?:\.[a-z_][a-z\d_]*|\[\d+\])*$/i.test(value)&&redactDiagnosticText(value)===value?value:undefined;
}

export function classifyUpstreamError(value,status){
  const error=value?.error??value,text=typeof error==="string"?error:typeof error?.message==="string"?error.message:"";
  if(text.length>65536)return null;
  const param=safeUpstreamParameter(error?.param||error?.parameter);
  let code;
  if([400,413,422].includes(status)&&/(context (?:length|window)|input tokens|上下文).{0,80}(?:exceed|too (?:long|large)|超|超过)|(?:exceed|超).{0,60}(?:context|上下文)/i.test(text))code="context_length_exceeded";
  else if([400,422].includes(status)&&/max_(?:completion_)?tokens|max_output_tokens|output token limit|输出.{0,12}(?:上限|限制)/i.test(text)&&/(?:maximum|at most|less than|exceed|between|invalid|unsupported|最多|超过|不支持)/i.test(text))code="output_limit_invalid";
  else if([400,422].includes(status)&&/(?:too many|maximum number of|at most).{0,40}tools|工具.{0,20}(?:过多|超过)/i.test(text))code="tool_limit_exceeded";
  else if([400,422].includes(status)&&/(?:effort|thinking|reasoning).{0,60}(?:not support|unsupported)|not support.{0,60}(?:effort|thinking|reasoning)/i.test(text))code="reasoning_parameter_unsupported";
  const selected=safeUpstreamReason(code,status)||safeUpstreamReason(error?.code,status)||safeUpstreamReason(error?.type,status);
  if(!selected)return null;
  const inferred = code === "output_limit_invalid" ? /\b(max_(?:completion_)?tokens|max_output_tokens)\b/i.exec(text)?.[1]?.toLowerCase() : code === "tool_limit_exceeded" ? "tools" : undefined;
  const bounds = {};
  if (["output_limit_invalid", "tool_limit_exceeded", "context_length_exceeded"].includes(selected.code)) {
    const maximum = /(?:maximum(?: (?:context length|number of tools|tokens))?(?: is| of)?|at most|must be (?:less than or equal to|<=)|最多|上限(?:为)?)\s*[:=]?\s*(\d[\d,]{0,11})(?![\d,])/i.exec(text)?.[1];
    const n = maximum && Number(maximum.replaceAll(",", ""));
    if (Number.isSafeInteger(n) && n > 0 && n <= 100000000) bounds.maximum = n;
  }
  return { ...selected, ...(param || inferred ? { parameter: param || inferred } : {}), ...bounds,
    message: selected.message + (param ? " Parameter: " + param + "." : "") + (bounds.maximum ? " Reported maximum: " + bounds.maximum + "." : "") };
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
export async function readSafeUpstreamReason(response, { signal, timeoutMs = 200, maxBytes = 64 * 1024, missingCallId = false, rootToolSchema = false, diagnosticRedact } = {}) {
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
    let value;try { value = JSON.parse(text); } catch { value=text; }
    const reason = missingCallId && isMissingCallIdError(response.status, text)
      ? { code: "ccdx_missing_call_id", message: "The source requires a tool call ID." }
      : rootToolSchema && isRootToolSchemaError(response.status, text)
        ? { code: "ccdx_tool_schema_root_unsupported", message: "The source rejected a tool's root schema." }
        : classifyUpstreamError(value,response.status);
    if (!diagnosticRedact) return reason;
    const error = value?.error ?? value, message = typeof error === "string" ? error : error?.message;
    if (typeof message !== "string") return reason;
    return { ...reason, diagnostic_message: boundedDiagnosticText(diagnosticRedact(message), { maxChars: 512 }) };
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
