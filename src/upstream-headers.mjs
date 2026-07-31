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
} = {}) {
  const out = {};
  const resolvedContentType = contentType
    ?? headerValue(headers, "content-type")
    ?? defaultContentType;
  if (resolvedContentType) out["Content-Type"] = resolvedContentType;

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
