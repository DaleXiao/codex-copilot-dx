import { createHash } from "node:crypto";
import { createRoutePlan } from "../route-plan.mjs";
import { accessError } from "../access-settings.mjs";
import { publicModelCatalog } from "../provider-metadata.mjs";
import { resolveClaudeModel } from "../claude-models.mjs";
import { prepareResponsesPayload } from "../image-optimization.mjs";
import { enforceResponsesPayloadByteBudget } from "../responses-byte-budget.mjs";
import { MAX_UPSTREAM_MODEL_CATALOG_BYTES, readBoundedResponseText } from "../http-transport.mjs";
import { markUpstreamHeaders } from "../stream-performance.mjs";
import { createApiNetwork } from "./api-network.mjs";
import { checkedApiKey } from "../api-secrets.mjs";
import { transportErrorDetails } from "../operation-error.mjs";
import { resolveModelCapabilities, deploymentRevision, constrainModelRequest } from "../model-capabilities.mjs";
import { apiModelMetadata } from "./api-model-metadata.mjs";
import { markRequestObservation, markUpstreamStarted } from "../stream-performance.mjs";
import { createAbortAwareSingleflight } from "../bounded-result-cache.mjs";
import { createApiTokenCounter } from "./api-token-count.mjs";
import { apiModelDisplay } from "../api-model-display.mjs";

const paths = { messages: "/v1/messages", responses: "/v1/responses", chat: "/v1/chat/completions" };
export function apiCatalog(config, env = process.env) {
  const revision = deploymentRevision(config, env);
  return config.models.map(model => { const protocol_capabilities = Object.fromEntries(model.protocols.map(protocol => [protocol, resolveModelCapabilities(model, { revision, protocol })]));
    const capability = protocol_capabilities[model.protocols.includes("messages") ? "messages" : model.protocols[0]];return ({ id: model.id, name: model.id,
    supported_endpoints: model.protocols.map(api => paths[api]), model_picker_enabled: true, policy: { state: "enabled" },
    capability, protocol_capabilities }); });
}
export function createApiProvider({ config, secrets, env = process.env, platform = process.platform, networkFactory = createApiNetwork, modelDisplay = () => ({}) } = {}) {
  const catalog = apiCatalog(config, env);
  const fingerprint = config.key_env ? createHash("sha256").update(env[config.key_env] || "").digest("hex") : "";
  const generation = parseInt(createHash("sha256").update(JSON.stringify(config) + fingerprint).digest("hex").slice(0, 8), 16);
  const profiles = Object.fromEntries(["messages", "responses", "chat"].map(protocol => [protocol, `api:${config.id}:${createHash("sha256").update(JSON.stringify({
    endpoint: config.endpoints[protocol] ? new URL(config.endpoints[protocol]).href : null, key: config.secret_ref || fingerprint, auth: protocol === "messages" ? config.auth_header : "bearer",
  })).digest("hex").slice(0, 24)}`]));
  const profile = profiles.responses;
  const modelsUrl = config.base_url.replace(/\/+$/, "") + "/models", targets = [...Object.values(config.endpoints), modelsUrl];
  if (config.endpoints.messages) targets.push(config.endpoints.messages.replace(/\/+$/, "") + "/count_tokens");
  if (config.endpoints.responses) targets.push(config.endpoints.responses.replace(/\/+$/, "") + "/compact");
  let network, closed = false;
  const initialization = createAbortAwareSingleflight(), lifetime = new AbortController();
  const retiring = new Set();
  const registry = { models: { data: catalog.filter(model => model.supported_endpoints.includes(paths.responses)) }, source: "configured", generation };
  const getNetwork = async signal => {
    if (closed) throw accessError("ccdx_api_closed", 503);
    if (network && (network.healthy?.() ?? true)) return network;
    const previous = network;network = null;
    if (previous?.retire) {
      retiring.add(previous);
      void Promise.resolve(previous.retire()).then(() => retiring.delete(previous), () => { previous.close();retiring.delete(previous); });
    } else previous?.close();
    return initialization.run("network", sharedSignal => networkFactory({ targets, env, platform, signal: AbortSignal.any([sharedSignal, lifetime.signal]) })
      .then(value => { if (closed || sharedSignal.aborted) { value.close();throw accessError("ccdx_api_closed", 503); }network = value;return value; }), { signal });
  };
  const selected = (id, api) => {
    const model = api === "messages" ? resolveClaudeModel(catalog, id) : catalog.find(model => model.id === id);
    if (!model?.supported_endpoints.includes(paths[api])) throw accessError("ccdx_api_model_unavailable");return model;
  };
  async function request(url, body, options = {}, api = "responses") {
    if (closed) throw accessError("ccdx_api_closed", 503);
    if (config.key_env && !env[config.key_env]) throw accessError("ccdx_api_environment_key_missing", 503);
    const key = config.key_env ? checkedApiKey(env[config.key_env]) : await initialization.run("credential", () => secrets.get(config.secret_ref),
      { signal: options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal });
    const transport = await getNetwork(options.signal);
    const headers = { "Content-Type": "application/json", Accept: body?.stream ? "text/event-stream" : "application/json" };
    headers[api === "messages" && config.auth_header === "x-api-key" ? "x-api-key" : "Authorization"] = api === "messages" && config.auth_header === "x-api-key" ? key : `Bearer ${key}`;
    if (api === "messages") {
      headers["anthropic-version"] = "2023-06-01";
      for (const name of ["anthropic-version", "anthropic-beta"]) { const value = options.headers?.[name];if (typeof value === "string" && value.length < 8192 && !/[\r\n]/.test(value)) headers[name] = value; }
    }
    if (body && !options.countTokens) {
      const capability = catalog.find(model => model.id === body.model)?.protocol_capabilities[api];
      const constrained = constrainModelRequest(body, capability, api);
      if (constrained.body !== body) { body = constrained.body;options = { ...options, bodyText: undefined }; }
      markRequestObservation({ capability_revision: capability?.revision, capability_constraints: constrained.applied.join(",") || "none" });
      markRequestObservation({ context_window_tokens: capability?.values.context_window });
    }
    const serialized = body ? options.bodyText ?? JSON.stringify(body) : undefined;
    if (serialized !== undefined) headers["Content-Length"] = String(Buffer.byteLength(serialized));
    options.onUpstreamStart?.();
    if (body && options.observeUpstream !== false) {
      markUpstreamStarted(body.stream === true);
      if (!options.countTokens) markRequestObservation({ max_output_tokens_sent: api === "messages" ? body.max_tokens : api === "chat" ? body.max_completion_tokens : body.max_output_tokens });
    }
    try {
      const result = await transport.fetch(url, { method: body ? "POST" : "GET", headers, body: serialized, signal: options.signal });
      if (result.status >= 300 && result.status < 400) { await result.body?.cancel();throw accessError("ccdx_api_redirect_refused", 502); }
      if (!result.ok) {
        await result.body?.cancel();const code = `ccdx_api_http_${result.status}`;
        const safeHeaders = { "Content-Type": "application/json" }, retry = result.headers.get("retry-after");
        if (/^\d{1,8}$/.test(retry || "")) safeHeaders["Retry-After"] = retry;
        else if (retry && Number.isFinite(Date.parse(retry))) safeHeaders["Retry-After"] = new Date(retry).toUTCString();
        return new Response(JSON.stringify({ type: "error", error: { type: "api_error", code, message: code } }), { status: result.status, headers: safeHeaders });
      }
      return result;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (error.code === "ccdx_api_redirect_refused") throw error;
      const failure = accessError("ccdx_api_network_unavailable", 502);
      Object.defineProperty(failure, "cause", { value: error });
      failure.transport = transportErrorDetails(error);failure.jsonBody.error.diagnostic = failure.transport;
      throw failure;
    }
  }
  const counter = createApiTokenCounter({ request: (body, options) => request(config.endpoints.messages.replace(/\/+$/, "") + "/count_tokens", body, options, "messages") });
  const client = {
    listModels: async () => ({ status: 200, body: JSON.stringify(registry.models) }),
    getCachedModelEndpoints: id => catalog.find(model => model.id === id)?.supported_endpoints || null,
    async responses(body, options = {}) {
      selected(body.model, "responses");
      const prepared = await prepareResponsesPayload(body, { ...options.payloadOptions, assertActive: options.assertActive,
        currentInputStart: options.currentInputStart || 0, signal: options.signal, profiles: options.payloadPrepared ? [] : options.payloadOptions?.profiles,
        skipInitialOptimization: options.payloadPrepared || options.payloadOptions?.skipInitialOptimization });
      const final = enforceResponsesPayloadByteBudget(body, prepared, { assertActive: options.assertActive });
      return request(config.endpoints.responses, body, { ...options, bodyText: final.bodyText });
    },
    responsesCompact(body, options = {}) { selected(body.model, "responses");return request(config.endpoints.responses.replace(/\/+$/, "") + "/compact", body, options); },
    chatCompletions(body, options = {}) { selected(body.model, "chat");return request(config.endpoints.chat, body, options, "chat"); },
    messages(body, options = {}) {
      const model = selected(body.model, "messages");
      const outgoing = model.id === body.model ? body : { ...body, model: model.id };
      return options.countTokens ? counter.count(outgoing, options) : request(config.endpoints.messages, outgoing, options, "messages");
    },
  };
  return {
    id: config.id, name: config.name, client, registry, configuredModels: true, defaultReviewEffort: null, profileId: (protocol = "responses") => profiles[protocol] || profile,
    models: family => catalog.filter(model => model.supported_endpoints.includes(family === "claude" ? paths.messages : paths.responses))
      .map(model => ({ ...model, capability: model.protocol_capabilities[family === "claude" ? "messages" : "responses"] })),
    catalog: () => catalog,
    publicCatalog(allowed = []) { return { source: "configured", checkedAt: config.checked_at || null, upstreamHost: new URL(config.base_url).hostname,
      advertised: catalog.length, models: publicModelCatalog(catalog.map(model => ({ ...model, ...modelDisplay(model.id) })), { maker: model => model.publisher || model.vendor || null,
        selectable: model => allowed.some(id => model.supported_endpoints.includes(id === "codex" ? paths.responses : paths.messages)),
        clients: model => allowed.filter(id => model.supported_endpoints.includes(id === "codex" ? paths.responses : paths.messages)) }).map(model => ({ ...model,
          capability: catalog.find(entry => entry.id === model.id)?.capability, auto_review_efforts: [...(catalog.find(entry => entry.id === model.id)?.protocol_capabilities.responses?.values.reasoning_efforts || [])] })) }; },
    async discover({ signal } = {}) {
      const models = [], ids = new Set(), checked_at = new Date().toISOString();let url = modelsUrl, bytes = 0;
      for (let page = 0; page < 25; page++) {
      const response = await request(url, undefined, { signal }, config.endpoints.responses ? "responses" : "messages");
      if (!response.ok) {
        await response.body?.cancel();const error = accessError(`ccdx_api_catalog_http_${response.status}`, response.status === 401 || response.status === 403 ? response.status : 502);
        const retry = response.headers.get("retry-after"), delay = /^\d{1,8}$/.test(retry || "") ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
        if (Number.isFinite(delay) && delay > 0) error.retryAfterMs = Math.min(delay, 86400000);throw error;
      }
      const text = await readBoundedResponseText(response, { maxBytes: MAX_UPSTREAM_MODEL_CATALOG_BYTES - bytes, label: "API model catalog", signal });bytes += Buffer.byteLength(text);
      let value;try { value = JSON.parse(text); } catch { throw accessError("ccdx_api_catalog_invalid", 502); }
      if (!Array.isArray(value.data) || models.length + value.data.length > 500) throw accessError("ccdx_api_catalog_invalid", 502);
      for (const model of value.data) { if (!model || typeof model.id !== "string" || !/^[\w][\w./:@+-]{0,159}$/.test(model.id) || model.id.includes("..") || model.id.includes("//") || ids.has(model.id)) throw accessError("ccdx_api_catalog_invalid", 502);ids.add(model.id); }
      // A catalog listing is not evidence that every model supports every API.
      models.push(...value.data.map(model => ({ id: model.id, display: apiModelDisplay(model), metadata: apiModelMetadata(model, { checked_at, deployment: deploymentRevision(config, env) }), protocols: Array.isArray(model.supported_endpoints)
        ? Object.entries(paths).filter(([, endpoint]) => model.supported_endpoints.includes(endpoint) || model.supported_endpoints.includes(endpoint.slice(3))).map(([api]) => api).filter(api => config.endpoints[api]) : [] })));
      if (value.has_more !== true) return models;
      // Follow only the native cursor on the configured origin, never an
      // upstream next-page URL that could disclose this source's credential.
      if (!value.data.length || value.last_id !== value.data.at(-1).id || bytes >= MAX_UPSTREAM_MODEL_CATALOG_BYTES) throw accessError("ccdx_api_catalog_invalid", 502);
      const next = new URL(modelsUrl);next.searchParams.set("after_id", value.last_id);url = next.href;
      }
      throw accessError("ccdx_api_catalog_limit", 502);
    },
    selectModel(_body, { upstreamModel }) { selected(upstreamModel, "responses");return { upstreamModel, forceResponses: true }; },
    route(_body, { upstreamModel, surface }) { return createRoutePlan({ disposition: "relay", origin: config.id, profile, protocol: "openai-responses", model: upstreamModel, surface }); },
    applyRequestPolicies() {},
    compatibility: { hasRetry: () => false, selectRetry: async () => null,
      async openResponse(context, upstream, options) {
        const resp = await upstream(context.body, { assertActive: options.assertPrepareActive, signal: options.signal, currentInputStart: context.currentInputStart, onUpstreamStart: options.onUpstreamStart });
        markUpstreamHeaders(resp.status);
        // Upstream errors may echo its key; never forward its error body.
        if (!resp.ok) { await resp.body?.cancel();const code = `ccdx_api_http_${resp.status}`;return { resp: new Response(JSON.stringify({ error: { code, message: code } }), { status: resp.status, headers: { "Content-Type": "application/json" } }), reqContext: context, errorText: code, usedRetryPolicies: new Set() }; }
        return { resp, reqContext: context, errorText: undefined, usedRetryPolicies: new Set() };
      } },
    close() { closed = true;lifetime.abort();network?.close();for (const previous of retiring) previous.close();retiring.clear(); },
  };
}
