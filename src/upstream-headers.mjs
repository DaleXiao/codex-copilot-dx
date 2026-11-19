const REQUEST_ID_HEADERS = [
  "x-request-id",
  "x-github-request-id",
  "x-ms-request-id",
  "request-id",
  "x-correlation-id",
];

const SAFE_EXACT_HEADERS = new Set([
  "retry-after",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "ratelimit-policy",
  "openai-model",
  "openai-processing-ms",
  "traceparent",
]);

const SAFE_HEADER_PREFIXES = [
  "x-ratelimit-",
  "x-ms-ratelimit-",
];

function headerValue(headers, name) {
  const value = headers?.get?.(name);
  return typeof value === "string" && value.trim() ? value : null;
}

// Keep only a valid delay or an HTTP-date from an upstream rejection.
export function upstreamRetryAfter(headers) {
  const value = headerValue(headers, "retry-after")?.trim();
  if (!value) return null;
  if (/^\d{1,8}(?:\.\d{1,3})?$/.test(value)) return String(Math.ceil(Number(value)));
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toUTCString() === value ? value : null;
}

export function upstreamRejectionHeaders(status, headers) {
  const out = new Headers();
  if (status === 429 || status === 503) {
    const retry = upstreamRetryAfter(headers);
    if (retry !== null) out.set("Retry-After", retry);
  }
  for (const name of REQUEST_ID_HEADERS) {
    const id = headerValue(headers, name)?.trim();
    if (/^[A-Za-z0-9._:/-]{1,160}$/.test(id || "")) { out.set(name, id);break; }
  }
  return out;
}

function canonicalHeaderName(name) {
  return String(name).split("-").map((part) => (
    part ? `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}` : part
  )).join("-");
}

function isSafeMetadataHeader(name) {
  return SAFE_EXACT_HEADERS.has(name)
    || SAFE_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function safeUpstreamResponseHeaders(headers, {
  contentType,
  defaultContentType,
  allowReasoningIncluded = false,
} = {}) {
  const out = {};
  const resolvedContentType = contentType
    ?? headerValue(headers, "content-type")
    ?? defaultContentType;
  if (resolvedContentType) out["Content-Type"] = resolvedContentType;
  // Codex treats presence as true, even for a literal "false" value.
  // Native Responses callers opt in; never invent a declaration for other routes.
  if (allowReasoningIncluded && headerValue(headers, "x-reasoning-included")?.trim().toLowerCase() === "true") {
    out["X-Reasoning-Included"] = "true";
  }

  if (headers && typeof headers[Symbol.iterator] === "function") {
    for (const [rawName, value] of headers) {
      const name = String(rawName).toLowerCase();
      if (!isSafeMetadataHeader(name)) continue;
      out[canonicalHeaderName(name)] = value;
    }
  }

  for (const name of REQUEST_ID_HEADERS) {
    const value = headerValue(headers, name);
    if (value) {
      out["X-Upstream-Request-Id"] = value;
      break;
    }
  }
  return out;
}
