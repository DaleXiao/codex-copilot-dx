import { terminalCell } from "./terminal-text.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";
import { currentRequestContext } from "./request-context.mjs";
import { isProviderId } from "./provider-metadata.mjs";

const DEFAULT_RECENT_FAILURES = 10;

function safeIdentifier(value, fallback = "unknown") {
  const text = redactDiagnosticText(terminalCell(value, { fallback }));
  return text.slice(0, 200);
}

function safeFailureMessage(value) {
  let text = terminalCell(value, { fallback: "Response failed without an error message" });
  text = redactDiagnosticText(text);
  return text.slice(0, 500);
}

function upstreamRequestId(headers) {
  if (!headers?.get) return null;
  for (const name of ["x-request-id", "x-github-request-id", "x-ms-request-id", "request-id", "x-correlation-id"]) {
    const value = headers.get(name);
    if (value) return safeIdentifier(value, "");
  }
  return null;
}

export function responseFailureDetails(event, eventType = event?.type, {
  model,
  headers,
  retried = false,
  retryPolicy = null,
  retrySkipped = null,
  provider = currentRequestContext()?.provider,
} = {}) {
  const response = event?.response && typeof event.response === "object" ? event.response : event;
  const error = response?.error && typeof response.error === "object"
    ? response.error
    : event?.error && typeof event.error === "object"
      ? event.error
      : event;
  return {
    at: new Date().toISOString(),
    request_id: currentRequestContext()?.requestId || null,
    ...(isProviderId(provider) ? { provider } : {}),
    event_type: safeIdentifier(eventType || "response.failed"),
    model: safeIdentifier(response?.model || model),
    code: safeIdentifier(error?.code || "unknown_error"),
    message: safeFailureMessage(error?.message),
    response_id: response?.id ? safeIdentifier(response.id, "") : null,
    upstream_request_id: upstreamRequestId(headers),
    retried: Boolean(retried),
    retry_policy: retryPolicy ? safeIdentifier(retryPolicy, "") : null,
    retry_skipped: retrySkipped ? safeIdentifier(retrySkipped, "") : null,
  };
}

export function responseFailureText(event, eventType = event?.type) {
  const response = event?.response && typeof event.response === "object" ? event.response : event;
  const error = response?.error && typeof response.error === "object"
    ? response.error
    : event?.error && typeof event.error === "object"
      ? event.error
      : event;
  return JSON.stringify({ error: { code: error?.code, message: error?.message } });
}

export function formatResponseFailureLog(details) {
  const fields = [
    `Responses ${details.event_type}`,
    `model=${details.model}`,
    `code=${details.code}`,
    details.response_id ? `response_id=${details.response_id}` : null,
    details.upstream_request_id ? `upstream_request_id=${details.upstream_request_id}` : null,
    details.retried ? `retry=${details.retry_policy || "yes"}` : null,
    details.retry_skipped ? `retry_skipped=${details.retry_skipped}` : null,
    `message=${details.message}`,
  ].filter(Boolean);
  return fields.join(" ");
}

export function createResponseFailureDiagnostics({
  maxEntries = DEFAULT_RECENT_FAILURES,
  now = () => new Date().toISOString(),
} = {}) {
  const recent = [];
  let total = 0;
  let retried = 0;
  const copy = entry => ({ ...entry,
    ...(entry.request_options ? { request_options: { ...entry.request_options } } : {}),
    ...(entry.attempt_timings ? { attempt_timings: entry.attempt_timings.map(attempt => ({ ...attempt })) } : {}),
  });
  return {
    record(details) {
      total += 1;
      if (details.retried) retried += 1;
      recent.push(copy({ ...details, at: now() }));
      if (recent.length > maxEntries) recent.splice(0, recent.length - maxEntries);
    },
    snapshot() {
      return {
        total,
        retried,
        recent: recent.map(copy),
      };
    },
  };
}

export function upstreamErrorEvidence(text, { includeMessage = false } = {}) {
  const errorBody = !String(text || "").trim() ? "empty" : "unstructured";
  let error;
  try { const parsed = JSON.parse(text); error = parsed?.error; } catch {}
  if (!error || typeof error !== "object" || Array.isArray(error)) return { error_body: errorBody,
    ...(includeMessage && errorBody !== "empty" ? { diagnostic_message: safeFailureMessage(typeof error === "string" ? error : text) } : {}) };
  const technical = value => typeof value === "string" && /^[a-z\d_.:-]{1,80}$/i.test(value)
    && redactDiagnosticText(value) === value ? value : undefined;
  const param = typeof error.param === "string" && error.param.length <= 160
    && /^(?:model|input|tools|tool_choice|reasoning|text|temperature|top_p|max_output_tokens|service_tier|store|stream|include|previous_response_id|parallel_tool_calls)(?:\.[a-z_][a-z\d_]*|\[\d+\])*$/i.test(error.param)
    ? error.param : undefined;
  return { error_body: "structured", code: technical(error.code), error_type: technical(error.type),
    parameter: param, ...(includeMessage && typeof error.message === "string" ? { diagnostic_message: safeFailureMessage(error.message) } : {}) };
}

export function requestOptionsEvidence(body) {
  const result = {};
  if (!body || typeof body !== "object") return result;
  if (["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(body.reasoning?.effort)) result.reasoning_effort = body.reasoning.effort;
  if (["auto", "default", "flex", "priority", "scale"].includes(body.service_tier)) result.service_tier = body.service_tier;
  if (["text", "json_object", "json_schema"].includes(body.text?.format?.type)) result.output_format = body.text.format.type;
  if (Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens >= 0) result.max_output_tokens = body.max_output_tokens;
  if (Array.isArray(body.tools)) result.tools = body.tools.length;
  if (Array.isArray(body.input)) result.input_items = body.input.length;
  return result;
}

export function createHttpFailureDiagnostics({ maxEntries = 20, now } = {}) {
  const all = createResponseFailureDiagnostics({ maxEntries, now });
  const actionable = createResponseFailureDiagnostics({ maxEntries, now });
  const protocol = createResponseFailureDiagnostics({ maxEntries: 8, now });
  const counts = { inference: 0, protocol: 0, route: 0, other: 0 };
  return {
    record(details) {
      all.record(details);
      const category = ["responses", "responses_compact", "messages", "messages_count_tokens"].includes(details.route) ? "inference"
        : details.route === "image_mcp" && details.http_status === 405 ? "protocol"
          : details.route === "not_found" ? "route" : "other";
      counts[category]++;
      if (category === "inference" || category === "other") actionable.record(details);
      if (category === "protocol") protocol.record(details);
    },
    snapshot() { return { ...all.snapshot(), by_category: { ...counts },
      actionable_recent: actionable.snapshot().recent, protocol_recent: protocol.snapshot().recent }; },
  };
}

export function buildHttpFailureDetails({ statusCode, route, requestId, model, code, origin, headers,
  error_body, error_type, parameter, diagnostic_message, method, target, request_options, upstream_attempts, attempt_timings, requested_model, provider }) {
  const details = responseFailureDetails({ model, error: { code: typeof code === "string" && /^[a-z\d_.:-]{1,80}$/i.test(code) ? code : `http_${statusCode}`,
    message: error_body === "empty" ? "Upstream returned no error details." : "HTTP request failed; original response was preserved." } }, "http.error", { headers, provider });
  return { ...details, request_id: requestId, http_status: statusCode, route,
    origin: origin || (route === "not_found" ? "route" : "unclassified"), local_message: true,
    ...(error_body ? { error_body } : {}), ...(error_type ? { error_type } : {}), ...(parameter ? { parameter } : {}),
    ...(diagnostic_message ? { diagnostic_message } : {}),
    ...(method ? { method } : {}), ...(target ? { target } : {}),
    ...(request_options ? { request_options } : {}),
    ...(attempt_timings ? { attempt_timings } : {}),
    ...(requested_model ? { requested_model, request_kind: requested_model === "codex-auto-review" ? "auto_review" : "unknown" } : {}),
    ...(Number.isSafeInteger(upstream_attempts) ? { upstream_attempts } : {}) };
}
