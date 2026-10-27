// The server body is inspected once. Only fixed causes and bounded IDs survive.
const causes = Object.freeze({
  sign_in_rejected: "Microsoft 365 rejected the sign-in. Check account access.",
  entra_access_disabled: "Copilot CLI Entra access is not enabled for this account.",
  access_denied: "Microsoft 365 denied access to the model list.",
  rate_limited: "Microsoft 365 limited model-list checks. Try again later.",
  service_unavailable: "Microsoft 365 could not serve the model list.",
  catalog_rejected: "Microsoft 365 rejected the model-list request.",
});

const date = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) ? value : null;

export function m365CatalogDiagnostic(value) {
  if (!value || value.stage !== "catalog" || !Object.hasOwn(causes, value.cause_code)
    || !Number.isInteger(value.http_status) || value.http_status < 400 || value.http_status > 599) return null;
  return { stage: "catalog", cause_code: value.cause_code, http_status: value.http_status,
    checked_at: date(value.checked_at), last_success_at: date(value.last_success_at),
    request_id: typeof value.request_id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value.request_id)
      && !/^(?:github_pat_|gh[pousr]_|sk-|eyJ)/.test(value.request_id) ? value.request_id : null };
}

export function m365CatalogMessage(value) {
  const diagnostic = m365CatalogDiagnostic(value);
  return diagnostic ? causes[diagnostic.cause_code] : null;
}

export function catalogFailure(response, body, { checkedAt, lastSuccessAt } = {}) {
  let message;
  try { const value = JSON.parse(body);message = value?.error?.message ?? value?.message; } catch { /* Unrecognized bodies get the HTTP category only. */ }
  const code = response.status;
  const cause_code = code === 401 ? "sign_in_rejected"
    : code === 403 ? typeof message === "string" && /^Copilot CLI Entra access is not enabled for this user\.?$/i.test(message.trim())
      ? "entra_access_disabled" : "access_denied"
      : code === 429 ? "rate_limited" : code >= 500 ? "service_unavailable" : "catalog_rejected";
  return m365CatalogDiagnostic({ stage: "catalog", cause_code, http_status: code, checked_at: checkedAt,
    last_success_at: lastSuccessAt, request_id: response.headers.get("request-id") || response.headers.get("x-ms-request-id") });
}

export function m365CatalogRead(value) {
  if (!value || !["network", "cache"].includes(value.source) || !date(value.checked_at)
    || !["total", "claude", "gpt", "filtered"].every(key => Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 1000)
    || value.claude + value.gpt + value.filtered !== value.total) return null;
  const identifier = id => typeof id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(id) && !/^(?:github_pat_|gh[pousr]_|sk-|eyJ)/.test(id) ? id : null;
  return { source: value.source, checked_at: value.checked_at, total: value.total, claude: value.claude, gpt: value.gpt, filtered: value.filtered,
    request_id: identifier(value.request_id), client_correlation_id: identifier(value.client_correlation_id),
    http_status: value.source === "network" && value.http_status === 200 ? 200 : null,
    local_cache_used: value.source === "cache", http_revalidation_requested: value.source === "network" && value.http_revalidation_requested === true,
    response_age_seconds: Number.isSafeInteger(value.response_age_seconds) && value.response_age_seconds >= 0 && value.response_age_seconds <= 604800 ? value.response_age_seconds : null };
}
