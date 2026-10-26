import { createHash, randomUUID } from "node:crypto";
import { createM365Auth, m365Error } from "./m365-auth.mjs";
import { m365Paths, m365AccountKey, readM365Account, readM365Json, writeM365Binding } from "../m365-settings.mjs";
import { MAX_UPSTREAM_ERROR_BODY_BYTES, MAX_UPSTREAM_MODEL_CATALOG_BYTES, readBoundedResponseText } from "../http-transport.mjs";
import { prepareResponsesPayload, summarizeReqBody } from "../image-optimization.mjs";
import { enforceResponsesPayloadByteBudget } from "../responses-byte-budget.mjs";
import { createRoutePlan } from "../route-plan.mjs";
import { CODEX_AUTO_REVIEW_MODEL } from "../models.mjs";
import { currentRequestContext } from "../request-context.mjs";
import { markRequestObservation, markUpstreamHeaders, markUpstreamStarted } from "../stream-performance.mjs";
import { requestOptionsEvidence } from "../response-failures.mjs";
import { status } from "../status.mjs";
import { redactDiagnosticText } from "../diagnostic-text.mjs";
import { removeNativeImageTools } from "../responses-image-tools.mjs";
import { resolveClaudeModel } from "../claude-models.mjs";
import { modelReasoningEfforts } from "../provider-metadata.mjs";
import { limitM365CacheTtl } from "./m365-messages-policy.mjs";
import { createM365ConversationGuard } from "./m365-conversation-accounts.mjs";
import { catalogFailure, m365CatalogDiagnostic } from "./m365-catalog-diagnostic.mjs";
import { m365NetworkDiagnostic } from "./m365-network-diagnostic.mjs";

export const M365_API_BASE = "https://df.loki.delve.office.com/api/v1/llmapi";
const SOFT_TTL_MS = 2 * 60 * 60 * 1000;
const HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const protocolError = (code, message, statusCode = 400) => Object.assign(new Error(message), {
  code, statusCode, jsonBody: { error: { code, message, type: statusCode === 400 ? "invalid_request_error" : "upstream_error" } },
});

export function m365Headers(token, { headers = {}, conversationId, stream = false } = {}) {
  const out = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: stream ? "text/event-stream" : "application/json",
    "X-ClientType": "GitHub", "X-ClientVersion": "1.0.0", "X-Llm-Api-Version": "2026-09-28", "X-ClientScenario": "Code",
    "X-ClientFeature": "LlmApiProxy", "X-ClientCorrelationId": randomUUID(), "X-ClientCallId": randomUUID() };
  if (conversationId) out["X-ConversationId"] = conversationId;
  for (const name of ["anthropic-version", "anthropic-beta"]) {
    const value = headers[name];
    if (typeof value === "string" && value.length < 8192 && !/[\r\n]/.test(value)) out[name] = value;
  }
  return out;
}

export function m365ConversationId(body, headers = {}, profile = "m365") {
  let session = headers["x-conversation-id"] || headers["session_id"] || headers["session-id"] || headers["x-claude-code-session-id"];
  if (!session && typeof body?.metadata?.user_id === "string") {
    try { session = JSON.parse(body.metadata.user_id)?.session_id; } catch {
      session = /(?:^|_)session_([\w-]{8,128})$/.exec(body.metadata.user_id)?.[1];
    }
  }
  if (typeof session !== "string" || !session || session.length > 512 || /[\u0000-\u001f\u007f]/.test(session)) return randomUUID();
  const value = createHash("sha256").update(`${profile}\0${session}`).digest("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

export function m365Catalog(payload) {
  if (!payload || !Array.isArray(payload.data) || payload.data.length > 1000) throw m365Error("m365_catalog_invalid");
  const seen = new Set();
  for (const model of payload.data) {
    if (!model || typeof model.id !== "string" || !/^[A-Za-z0-9][\w.-]{0,127}$/.test(model.id)
      || seen.has(model.id) || !Array.isArray(model.supported_endpoints)) throw m365Error("m365_catalog_invalid");
    seen.add(model.id);
  }
  return { data: payload.data };
}

export function m365Models(catalog, family) {
  return (catalog?.data || []).filter(model => typeof model?.publisher === "string" && model.model_picker_enabled !== false
    && (!model.policy?.state || model.policy.state === "enabled")).filter(model => family === "claude"
    ? model.id.startsWith("claude-") && model.publisher?.toLowerCase() === "anthropic" && model.supported_endpoints.includes("/v1/messages")
    : model.id.startsWith("gpt-") && model.publisher?.toLowerCase() === "openai"
      && model.supported_endpoints.some(endpoint => endpoint === "/responses" || endpoint === "/v1/responses"));
}

export function createM365Provider({ home, env = process.env, account: accountOverride, persist = true,
  auth = createM365Auth({ home, env, account: accountOverride }), fetchImpl,
  createNetwork, now = Date.now, log = (kind, message) => console.log(status(kind, message)), onCatalog = () => {} } = {}) {
  const paths = m365Paths({ home });
  const guardConversation = createM365ConversationGuard({ home });
  let catalog = null, account = null, catalogAt = 0, state = "idle", reason = null, flight = null, controller = null, generation = 0;
  let network = null, networkFlight = null, cacheTtlAdjustments = 0;
  let networkDiagnostic = null, catalogDiagnostic = null;
  const registry = { models: null, source: "unavailable", cacheState: "none", cacheSavedAtMs: null,
    refreshInFlight: false, generation: 0, lastError: null, lastErrorAtMs: null };
  const profile = () => account ? `m365:${m365AccountKey(account)}` : "m365:unavailable";
  async function transport(signal) {
    if (network?.healthy()) return network.fetch;
    if (!networkFlight) {
      const pending = (async () => {
        network?.close();network = null;
        const start = createNetwork || (await import("./m365-network.mjs")).createM365Network;
        const opened = await start({ env, signal });
        if (state === "disabled") { opened.close();throw m365Error("m365_disabled"); }
        network = opened;networkDiagnostic = null;return opened.fetch;
      })().finally(() => { if (networkFlight === pending) networkFlight = null; });
      networkFlight = pending;
    }
    return networkFlight;
  }
  function applyCatalog(value, source, savedAt) {
    catalog = m365Catalog(value);catalogAt = savedAt;
    registry.models = { data: m365Models(catalog, "gpt").map(model => ({ ...model,
      vendor: "OpenAI", model_picker_enabled: true, policy: { state: "enabled" } })) };
    registry.source = source;registry.cacheSavedAtMs = savedAt;registry.cacheState = now() - savedAt < SOFT_TTL_MS ? "fresh" : "stale";
  }
  try {
    account = accountOverride || readM365Account({ home });
    const saved = readM365Json(paths.catalog);
    if (account && saved?.account_key === m365AccountKey(account) && Number.isFinite(saved.saved_at)
      && now() - saved.saved_at < HARD_TTL_MS) applyCatalog(saved.models, "cache", saved.saved_at);
  } catch { reason = "m365_cache_unavailable"; }

  async function request(endpoint, body, options = {}) {
    if (state === "disabled") throw m365Error("m365_disabled");
    if (!["/models", "/responses", "/v1/responses", "/v1/messages", "/v1/messages/count_tokens"].includes(endpoint)) throw m365Error("m365_endpoint_invalid");
    const credential = await auth.getToken({ signal: options.signal });
    if (account && m365AccountKey(credential.account) !== m365AccountKey(account)) throw m365Error("m365_account_changed");
    const requestHeaders = m365Headers(credential.token, { ...options,
      conversationId: body ? m365ConversationId(body, options.headers, m365AccountKey(credential.account)) : undefined,
      stream: body?.stream === true });
    const serialized = body ? options.bodyText ?? JSON.stringify(body) : undefined;
    if (serialized !== undefined) requestHeaders["Content-Length"] = String(Buffer.byteLength(serialized));
    options.onUpstreamStart?.();
    if (body) { markUpstreamStarted(body.stream === true);if (!options.countTokens) markRequestObservation({ max_output_tokens_sent: endpoint.includes("messages") ? body.max_tokens : body.max_output_tokens }); }
    try {
      const send = fetchImpl || await transport(options.signal);
      const response = await send(`${M365_API_BASE}${endpoint}`, { method: body ? "POST" : "GET", headers: requestHeaders,
        ...(serialized !== undefined ? { body: serialized } : {}), signal: options.signal, redirect: "manual" });
      if (response.ok) return response;
      const raw = await readBoundedResponseText(response, { maxBytes: MAX_UPSTREAM_ERROR_BODY_BYTES, label: "M365 error", signal: options.signal });
      const safe = raw.split(credential.token).join("[redacted]");
      const headers = new Headers(response.headers);headers.delete("content-length");headers.delete("content-encoding");
      return new Response(safe, { status: response.status, headers });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason || error;
      throw Object.assign(new Error(redactDiagnosticText(String(error.message).split(credential.token).join("[redacted]"))), {
        code: /^m365_[a-z0-9_]+$/.test(error.code || "") ? error.code : "m365_network_error", statusCode: 502,
        network_diagnostic: m365NetworkDiagnostic(error.network_diagnostic) });
    }
  }

  function refresh() {
    if (state === "disabled") return Promise.reject(m365Error("m365_disabled"));
    if (flight) return flight;
    const current = ++generation;
    state = "checking";registry.refreshInFlight = true;registry.generation = current;
    controller = new AbortController();
    const signal = controller.signal, timer = setTimeout(() => controller.abort(), 30000);
    const pending = (async () => {
      const credential = await auth.getToken({ signal });
      const response = await request("/models", null, { signal });
      const raw = await readBoundedResponseText(response, { maxBytes: MAX_UPSTREAM_MODEL_CATALOG_BYTES, label: "M365 model catalog", signal });
      if (!response.ok) throw Object.assign(m365Error(`m365_catalog_http_${response.status}`), {
        catalog_diagnostic: catalogFailure(response, raw, { checkedAt: new Date(now()).toISOString(),
          lastSuccessAt: catalogAt ? new Date(catalogAt).toISOString() : null }) });
      let value;try { value = m365Catalog(JSON.parse(raw)); } catch { throw m365Error("m365_catalog_invalid"); }
      if (current !== generation || signal.aborted) throw m365Error("m365_refresh_cancelled");
      const savedAt = now();
      const nextAccount = { ...credential.account, ...(account?.history_isolation ? { history_isolation: true } : {}) };
      if (persist) writeM365Binding(nextAccount, { account_key: m365AccountKey(nextAccount), saved_at: savedAt, models: value }, { home, expectedAccount: account });
      account = nextAccount;
      applyCatalog(value, "live", savedAt);catalogDiagnostic = null;state = "ready";reason = null;registry.lastError = null;registry.lastErrorAtMs = null;
      try { await onCatalog(value); } catch { log("warn", "M365 models are ready; optional client configuration could not be updated"); }
      return value;
    })().catch(error => {
      if (current === generation) {
        state = "unavailable";reason = /^m365_[a-z0-9_]+$/.test(error.code || "") ? error.code : "m365_unavailable";
        networkDiagnostic = m365NetworkDiagnostic(error.network_diagnostic);
        catalogDiagnostic = m365CatalogDiagnostic(error.catalog_diagnostic);
        registry.lastError = reason;registry.lastErrorAtMs = now();
      }
      throw error;
    }).finally(() => { clearTimeout(timer);if (flight === pending) { flight = null;controller = null;registry.refreshInFlight = false; } });
    flight = pending;
    return pending;
  }

  function selectedModel(id, family) {
    const models = m365Models(catalog, family);
    const model = family === "claude" ? resolveClaudeModel(models, id) : models.find(entry => entry.id === id);
    if (!model) throw protocolError("m365_model_unavailable", `Model ${String(id).slice(0, 128)} is not available from Microsoft 365. Select a model from its current catalog.`);
    return model;
  }

  const client = {
    async listModels({ signal } = {}) {
      signal?.throwIfAborted();
      if (!catalog) await refresh();
      else if (now() - catalogAt >= SOFT_TTL_MS && !flight) void refresh().catch(() => {});
      signal?.throwIfAborted();
      if (!registry.models) throw m365Error(reason || "m365_catalog_unavailable");
      return { status: 200, body: JSON.stringify(registry.models) };
    },
    getCachedModelEndpoints: id => catalog?.data.find(model => model.id === id)?.supported_endpoints || null,
    cacheModelEndpoints() {},
    async responses(body, options = {}) {
      const model = selectedModel(body.model, "gpt");
      if (account) guardConversation(account, body, currentRequestContext()?.clientHeaders || options.headers);
      const prepared = await prepareResponsesPayload(body, { ...options.payloadOptions, assertActive: options.assertActive,
        currentInputStart: options.currentInputStart || 0, signal: options.signal,
        profiles: options.payloadPrepared ? [] : options.payloadOptions?.profiles,
        skipInitialOptimization: options.payloadPrepared || options.payloadOptions?.skipInitialOptimization });
      const final = enforceResponsesPayloadByteBudget(body, prepared, { assertActive: options.assertActive });
      const summary = final.stage === prepared.stage ? prepared.summary : summarizeReqBody(body);
      markRequestObservation({ payload_bytes: final.bodyBytes, images: summary.images });
      const context = currentRequestContext();if (context) context.requestOptions = requestOptionsEvidence(body);
      log("info", `responses provider=m365 payload bytes=${final.bodyBytes} input_items=${summary.items} images=${summary.images}`);
      return request(model.supported_endpoints.includes("/responses") ? "/responses" : "/v1/responses", body,
        { ...options, headers: context?.clientHeaders, bodyText: final.bodyText });
    },
    responsesCompact(body, options) { return client.responses(body, options); },
    chatCompletions() { throw protocolError("m365_protocol_unsupported", "Microsoft 365 Codex routing requires native Responses"); },
    async messages(body, options = {}) {
      if (catalog && now() - catalogAt >= SOFT_TTL_MS && !flight) void refresh().catch(() => {});
      const model = selectedModel(body.model, "claude");
      if (account) guardConversation(account, body, options.headers);
      const efforts = modelReasoningEfforts(model);
      if (body.output_config?.effort !== undefined && efforts && !efforts.includes(body.output_config.effort)) {
        throw protocolError("m365_effort_unavailable", "The selected effort is not advertised by this model. Refresh its model list and select an available effort.");
      }
      const adjusted = limitM365CacheTtl(body);
      if (adjusted.changed && !cacheTtlAdjustments) log("info", "Microsoft 365 supports 5m prompt caching; 1h cache retention is capped to 5m. Content and breakpoints are unchanged.");
      cacheTtlAdjustments += adjusted.changed;
      return request(options.countTokens ? "/v1/messages/count_tokens" : "/v1/messages", model.id === adjusted.body.model ? adjusted.body : { ...adjusted.body, model: model.id }, options);
    },
    runtimeStatus: () => ({ ...auth.snapshot(), account_bound: Boolean(account), upstream_host: new URL(M365_API_BASE).hostname,
      model_endpoint_cache_entries: catalog?.data.length || 0, model_list_flights: flight ? 1 : 0 }),
  };
  return {
    id: "m365", client, registry, auth, refresh, profileId: profile,
    models: family => m365Models(catalog, family),
    catalog: () => catalog?.data || [],
    selectModel(body, { requestedModel, upstreamModel }) {
      selectedModel(upstreamModel, "gpt");
      if (requestedModel !== CODEX_AUTO_REVIEW_MODEL && body.service_tier === "priority") {
        throw protocolError("m365_priority_unverified", "Microsoft 365 does not advertise a verified fast tier. Select Standard or switch back to GitHub Copilot.");
      }
      return { upstreamModel, forceResponses: true };
    },
    route(_body, { upstreamModel, surface }) {
      return createRoutePlan({ disposition: "relay", origin: "m365", profile: profile(), protocol: "openai-responses", model: upstreamModel, surface });
    },
    // Loki rejects the native image_generation declaration; the independent
    // CCDX image functions/MCP remain available through their existing names.
    applyRequestPolicies: body => removeNativeImageTools(body),
    compatibility: {
      hasRetry: () => false, selectRetry: async () => null,
      async openResponse(context, upstream, options) {
        const resp = await upstream(context.body, { assertActive: options.assertPrepareActive, signal: options.signal,
          currentInputStart: context.currentInputStart, onUpstreamStart: options.onUpstreamStart });
        markUpstreamHeaders(resp.status);
        const errorText = resp.ok ? undefined : await readBoundedResponseText(resp, { maxBytes: MAX_UPSTREAM_ERROR_BODY_BYTES, label: "M365 response error", signal: options.signal });
        return { resp, reqContext: context, errorText, usedRetryPolicies: new Set() };
      },
    },
    commitSelection(expectedAccount) {
      if (!catalog || state !== "ready" || !account) throw m365Error("m365_not_ready");
      writeM365Binding(account, { account_key: m365AccountKey(account), saved_at: catalogAt, models: catalog }, { home, expectedAccount });
      persist = true;
    },
    snapshot: () => ({ ...auth.snapshot(), state, reason: reason || auth.snapshot().reason, account: account ? { login: account.login, tenant: account.tenant, selection_source: account.selection_source || "legacy" } : null,
      network: network?.snapshot() || null,
      network_diagnostic: networkDiagnostic ? { ...networkDiagnostic } : null,
      catalog_diagnostic: m365CatalogDiagnostic(catalogDiagnostic),
      cache_ttl_adjustments: cacheTtlAdjustments,
      models: { total: catalog?.data.length || 0, claude: m365Models(catalog, "claude").length, gpt: m365Models(catalog, "gpt").length,
        source: registry.source, refreshed_at: catalogAt ? new Date(catalogAt).toISOString() : null }, refresh_in_flight: Boolean(flight) }),
    close() { state = "disabled";generation += 1;controller?.abort();auth.reset();network?.close();network = null; },
  };
}
