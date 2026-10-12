import { redactDiagnosticText } from "./diagnostic-text.mjs";

export function operationError(code, message, { status = null, retryAt = null } = {}) {
  return Object.assign(new Error(message), { code, status, retryAt });
}

export function operationErrorDetails(error) {
  const code = String(error?.code || error?.cause?.code || "unknown");
  let source = "unknown";
  if (/proxy/i.test(code)) source = "proxy";
  else if (/cert|tls|ssl/i.test(code)) source = "tls";
  else if (/timeout|abort/i.test(code) || error?.name === "AbortError" || error?.name === "TimeoutError") source = "timeout";
  else if (/limit|429/.test(code)) source = "rate_limit";
  else if (/config|format|route|redirect/.test(code)) source = "configuration";
  else if (/HTTP|http/.test(code)) source = "upstream";
  else if (/ENOTFOUND|ECONN|EAI_/.test(code)) source = "network";
  return { code: /^[A-Za-z0-9_-]{1,80}$/.test(code) ? code : "unknown", source,
    message: redactDiagnosticText(String(error?.message || "Operation failed")).slice(0, 400),
    status: Number.isInteger(error?.status) ? error.status : null };
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
