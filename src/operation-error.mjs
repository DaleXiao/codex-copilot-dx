import { boundedDiagnosticText } from "./diagnostic-text.mjs";

const TRANSPORT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPERM", "EACCES",
  "EPROTO", "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID",
  "ERR_INVALID_ARG_TYPE", "ERR_INVALID_CHAR", "ERR_INVALID_PROTOCOL", "ERR_HTTP_INVALID_HEADER_VALUE", "ERR_HTTP_CONTENT_LENGTH_MISMATCH", "ERR_STREAM_PREMATURE_CLOSE",
  "HPE_INVALID_CONSTANT", "HPE_INVALID_STATUS", "HPE_INVALID_HEADER_TOKEN", "HPE_UNEXPECTED_CONTENT_LENGTH", "HPE_INVALID_CONTENT_LENGTH", "HPE_INVALID_CHUNK_SIZE", "HPE_HEADER_OVERFLOW",
]);
const TRANSPORT_PHASES = new Set(["request", "dns", "connect", "tls", "response", "unknown"]);

// Project only local error codes and fixed phases, never raw errors, URLs or headers.
export function transportErrorDetails(error) {
  const value = error?.transport;
  const code = [value?.code, error?.code, error?.cause?.code].find(code => TRANSPORT_CODES.has(code)) || "unknown";
  return { code, phase: TRANSPORT_PHASES.has(value?.phase) ? value.phase : "unknown",
    reused_socket: typeof value?.reused_socket === "boolean" ? value.reused_socket : null };
}

export function operationError(code, message, { status = null, retryAt = null } = {}) {
  return Object.assign(new Error(message), { code, status, retryAt });
}

export function operationErrorDetails(error, { reason } = {}) {
  const code = String(reason || error?.code || error?.cause?.code || "unknown");
  const status = Number.isInteger(error?.status) ? error.status : Number.isInteger(error?.statusCode) ? error.statusCode : null;
  let source = "unknown";
  if (["client_aborted", "client_closed", "cancelled"].includes(code)) source = "cancelled";
  else if (/proxy/i.test(code)) source = "proxy";
  else if (/cert|tls|ssl/i.test(code)) source = "tls";
  else if (/timeout|timed_out/i.test(code) || error?.name === "TimeoutError") source = "timeout";
  else if (/abort/i.test(code) || error?.name === "AbortError") source = "aborted";
  else if (status === 429 || /limit|429/.test(code)) source = "rate_limit";
  else if (status === 401) source = "authentication";
  else if (status === 403) source = "access_denied";
  else if (/config|format|route|redirect/.test(code)) source = "configuration";
  else if (/ENOTFOUND|ECONN|EAI_/.test(code)) source = "network";
  else if (/HTTP|http/.test(code) || status >= 400) source = "upstream";
  return { code: /^[A-Za-z0-9_-]{1,80}$/.test(code) ? code : "unknown", source,
    message: boundedDiagnosticText(error?.message || "Operation failed", { maxChars: 400 }),
    status };
}

// Error classifiers consume decoded string fields; responses retain their
// original bytes. Only escaped, bounded JSON errors need this extra work.
export function errorEvidenceText(value) {
  const text = String(value || "");
  if (!text.includes("\\u") || text.length > 16 * 1024) return text;
  try {
    const strings = [];
    const visit = (node, depth) => {
      if (depth > 4 || strings.length >= 32) return;
      if (typeof node === "string") strings.push(node);
      else if (node && typeof node === "object") for (const child of Object.values(node)) visit(child, depth + 1);
    };
    visit(JSON.parse(text), 0);
    return `${text}\n${strings.join("\n")}`;
  } catch { return text; }
}
