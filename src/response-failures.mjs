import { terminalCell } from "./terminal-text.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";
import { currentRequestContext } from "./request-context.mjs";
import { isProviderId } from "./provider-metadata.mjs";
import { transportErrorDetails } from "./operation-error.mjs";

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
  if (Number.isSafeInteger(body.max_tokens) && body.max_tokens >= 0) result.max_tokens = body.max_tokens;
  if (Array.isArray(body.tools)) result.tools = body.tools.length;
  if (Array.isArray(body.input)) result.input_items = body.input.length;
  return result;
}

export function createHttpFailureDiagnostics({ maxEntries = 20, now } = {}) {
  const all = createResponseFailureDiagnostics({ maxEntries, now });
  const actionable = createResponseFailureDiagnostics({ maxEntries, now });
  const protocol = createResponseFailureDiagnostics({ maxEntries: 8, now });
  const capability = createResponseFailureDiagnostics({ maxEntries: 20, now });
  const routes = createResponseFailureDiagnostics({ maxEntries: 8, now });
  const counts = { inference: 0, capability: 0, protocol: 0, route: 0, other: 0 };
  return {
    record(details) {
      all.record(details);
      const accessNotice = details.reason === "ccdx_model_not_selected" || details.reason === "ccdx_client_source_disabled";
      const category = accessNotice || details.route === "messages_count_tokens" ? "capability"
        : ["responses", "responses_compact", "messages"].includes(details.route) ? "inference"
        : details.route === "image_mcp" && details.http_status === 405 ? "protocol"
          : details.route === "not_found" ? "route" : "other";
      counts[category]++;
      if ((category === "inference" || category === "other") && !accessNotice) actionable.record(details);
      if (category === "capability") {
        capability.record(details);
        if (!accessNotice && ![404, 405, 501].includes(details.http_status)) actionable.record(details);
      }
      if (category === "protocol") protocol.record(details);
      if (category === "route") routes.record(details);
    },
    snapshot() { return { ...all.snapshot(), by_category: { ...counts },
      actionable_recent: actionable.snapshot().recent, capability_recent: capability.snapshot().recent,
      protocol_recent: protocol.snapshot().recent, route_recent: routes.snapshot().recent }; },
  };
}

export function buildHttpFailureDetails({ statusCode, route, requestId, model, code, origin, headers, model_error,
  error_body, error_type, parameter, diagnostic_message, method, target, request_options, upstream_attempts, attempt_timings, requested_model, provider,
  application, reason, capability_cached, shared_upstream, transport }) {
  if (!reason && code === "ccdx_client_source_disabled" && upstream_attempts === 0 && origin !== "upstream_http") {
    reason = code;origin = "client_validation";
  }
  const reasons = { ccdx_model_not_selected: "This model is not selected for this app.",
    ccdx_model_ambiguous: "This model name matches multiple sources. Select its source-specific entry.",
    ccdx_model_catalog_unavailable: "The selected model is not currently available in its source catalog.",
    ccdx_client_source_disabled: "This app or its model source is turned off." };
  for (const prefix of ["source_changed", "prefix_changed"]) {
    reasons[`${prefix}_tool_call_pending`] = "A tool call is still waiting for its result. Finish the current turn before switching.";
    reasons[`${prefix}_tool_result_unmatched`] = "A tool result has no matching call. Restore complete history before switching.";
    reasons[`${prefix}_tool_history_invalid`] = "The tool history is incomplete. Restore complete history before switching.";
    reasons[`${prefix}_active_tool_turn`] = prefix === "prefix_changed" ? "History changed during a tool turn. Finish the current turn before switching."
      : "A tool turn is still active on the previous source. Finish it before switching.";
  }
  const message = (Object.hasOwn(reasons, reason) ? reasons[reason] : null) || (route === "messages_count_tokens" && statusCode === 404 ? "The source's token-count endpoint returned HTTP 404. Message generation is separate."
    : code === "ccdx_api_network_unavailable" ? "Connection to the model source failed."
      : origin === "client_validation" ? "The request was rejected locally before an upstream call."
      : error_body === "empty" ? "Upstream returned no error details." : "HTTP request failed; original response was preserved.");
  const details = responseFailureDetails({ model, error: { code: typeof code === "string" && /^[a-z\d_.:-]{1,80}$/i.test(code) ? code : `http_${statusCode}`,
    message: model_error ? "The model source reported an error; the original HTTP response was preserved." : message } }, model_error ? "model.error" : "http.error", { headers, provider });
  return { ...details, request_id: requestId, http_status: statusCode, route,
    origin: origin || (route === "not_found" ? "route" : "unclassified"), local_message: true,
    ...(error_body ? { error_body } : {}), ...(error_type ? { error_type } : {}), ...(parameter ? { parameter } : {}),
    ...(diagnostic_message ? { diagnostic_message } : {}),
    ...(method ? { method } : {}), ...(target ? { target } : {}),
    ...(request_options ? { request_options } : {}),
    ...(attempt_timings ? { attempt_timings } : {}),
    ...(requested_model ? { requested_model, request_kind: requested_model === "codex-auto-review" ? "auto_review" : "unknown" } : {}),
    ...(["codex_app", "codex_cli", "codex", "claude_app", "claude_code", "claude", "api"].includes(application) ? { application } : {}),
    ...(Object.hasOwn(reasons, reason) ? { reason } : {}),
    ...(capability_cached === true ? { capability_cached: true } : {}), ...(shared_upstream === true ? { shared_upstream: true } : {}),
    ...(transport ? { transport: transportErrorDetails({ transport }) } : {}),
    ...(Number.isSafeInteger(upstream_attempts) ? { upstream_attempts } : {}) };
}
