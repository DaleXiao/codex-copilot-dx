import { redactDiagnosticText } from "./diagnostic-text.mjs";

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
    message: redactDiagnosticText(String(error?.message || "Operation failed")).slice(0, 400),
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
