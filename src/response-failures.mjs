import { terminalCell } from "./cli-table.mjs";

const DEFAULT_RECENT_FAILURES = 10;

function safeIdentifier(value, fallback = "unknown") {
  const text = terminalCell(value, { fallback });
  return text.slice(0, 200);
}

function safeFailureMessage(value) {
  let text = terminalCell(value, { fallback: "Response failed without an error message" });
  text = text
    .replace(/(encrypted(?: function output)? content\s+)[A-Za-z0-9+/_=-]{24,}/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9+/_=-]{96,}\b/g, "[redacted]");
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
} = {}) {
  const response = event?.response && typeof event.response === "object" ? event.response : event;
  const error = response?.error && typeof response.error === "object"
    ? response.error
    : event?.error && typeof event.error === "object"
      ? event.error
      : event;
  return {
    at: new Date().toISOString(),
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
  return {
    record(details) {
      total += 1;
      if (details.retried) retried += 1;
      recent.push({ ...details, at: now() });
      if (recent.length > maxEntries) recent.splice(0, recent.length - maxEntries);
    },
    snapshot() {
      return {
        total,
        retried,
        recent: recent.map((entry) => ({ ...entry })),
      };
    },
  };
}
