import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { accessSettingsPath, readAccessSettings, updateAccessSettings, checkedApi, checkedAccessSettings, accessError, CLIENT_IDS, CLIENT_NAMES } from "./access-settings.mjs";
import { createApiSecretStore, checkedApiKey } from "./api-secrets.mjs";
import { createApiProvider } from "./providers/api.mjs";
import { readClientGatewayKeys, gatewayClient } from "./client-gateway-keys.mjs";
import { createClaudeGatewayHandler } from "./claude-gateway.mjs";
import { configureClaudeClients, restoreClaudeClients, inspectClaudeDesktopPolicy } from "./claude-client-config.mjs";
import { configureCodexApi } from "./codex-api-config.mjs";
import { autoReviewReasoningEfforts } from "./models.mjs";
import { createRequestAdmission } from "./request-admission.mjs";
import { createConversationSourceGuard } from "./conversation-source-guard.mjs";
import { compileClientModels, sourceModels, codexClientCatalog } from "./client-model-plan.mjs";
import { currentRequestContext } from "./request-context.mjs";
import { claudeSharedCapabilityPlan, syncClaudeCapabilities, inspectClaudeCapabilitySupport, inspectClaudeCapabilityConfiguration } from "./claude-capability-config.mjs";
import { deploymentModelId, resolveModelCapabilities, deploymentRevision } from "./model-capabilities.mjs";

const validObject = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
export function createConnectionRuntime({ legacy, home, env = process.env, platform = process.platform, corePort = 2026,
  secretStore, createApi = createApiProvider, configureClaude = configureClaudeClients, restoreClaude = restoreClaudeClients,
  configureCodex = configureCodexApi, inspectDesktop = inspectClaudeDesktopPolicy, clientAccessChanged, log = () => {} } = {}) {
  const options = { home, env, platform }, secrets = secretStore || createApiSecretStore(options);
  const guardConversation = createConversationSourceGuard(options), acquireClaudeRequest = createRequestAdmission({ maxBytes: 16 * 1024 * 1024, maxQueued: 8 });
  let settings = readAccessSettings(options), managed = fs.existsSync(accessSettingsPath(options)), serial = Promise.resolve(), keys, closed = false;
  const instances = new Map(), active = new Map(), retired = new Set(), handlers = new Map(), summaries = new WeakMap(), sourceSecrets = new WeakMap(), setup = {}, lastClients = {};
  const retiredSecrets = new Map(), cleanups = new Set(), plans = new Map(), discoveries = new Map();
  const capabilitySupport = inspectClaudeCapabilitySupport(options);
  let sharedSync = null, syncFlight = null, syncAgain = false;
  function cleanSecrets(id) {
    const refs = retiredSecrets.get(id);if (!refs) return;
    for (const ref of refs) {
      if ([...active.keys()].some(source => sourceSecrets.get(source) === ref)) continue;
      refs.delete(ref);
      const task = secrets.remove(ref).catch(() => { log("warn", "Previous API credential cleanup needs review"); }).finally(() => cleanups.delete(task));cleanups.add(task);
    }
    if (!refs.size) retiredSecrets.delete(id);
  }
  const identities = () => keys ||= readClientGatewayKeys(options);
  const enabled = id => id?.startsWith("api_") ? settings.apis.find(api => api.id === id)?.enabled === true : settings.providers[id] === true;
  const binding = id => managed ? settings.clients[id] : { ...settings.clients[id], source: id === "codex" ? legacy.selection().codex : legacy.snapshot().m365.enabled ? "m365" : null };
  // GitHub-only selections retain the existing native loopback access contract.
  // Any other deployment still requires the private per-client credential.
  const codexRequiresKey = () => !Array.isArray(binding("codex").deployments)
    || !binding("codex").deployments.length || binding("codex").deployments.some(item => item.source !== "github");
  function requireCodexKey(req) {
    if (gatewayClient(req.headers, identities()) === "codex") return;
    // An old native process may still send its ChatGPT bearer. A local access
    // denial must not trigger recovery/replacement of that unrelated sign-in.
    throw accessError("ccdx_client_credential_required", req.headers?.authorization ? 403 : 401);
  }
  const permitted = (id, source) => binding(id)?.enabled && binding(id).allowed.includes(source) && enabled(source);
  function getSource(id) {
    if (!id?.startsWith("api_")) return legacy.source(id);
    const config = settings.apis.find(value => value.id === id);if (!config) return null;
    const previous = instances.get(id);if (previous?.config === config) return previous.source;
    const signature = JSON.stringify(config);
    if (previous?.signature === signature) return previous.source;
    const source = createApi({ config, secrets, env, platform });instances.set(id, { signature, source, config });sourceSecrets.set(source, config.secret_ref);
    if (previous) retire(previous.source);return source;
  }
  function plan(id) {
    const selected = binding(id), definitions = selected.allowed.filter(enabled).map(source => getSource(source)).filter(Boolean);
    const cached = plans.get(id), stamps = definitions.map(source => [source, source.registry?.generation, source.registry?.models, source.profileId()]);
    if (cached?.binding === selected && cached.stamps.length === stamps.length && stamps.every((stamp, index) => stamp.every((value, at) => cached.stamps[index][at] === value))) return cached.value;
    const value = compileClientModels({ client: id, binding: selected, source: getSource, enabled,
      names: Object.fromEntries([["github", "GitHub Copilot"], ["m365", "Microsoft 365"], ...settings.apis.map(api => [api.id, api.name])]),
      desktopEffortAliases: capabilitySupport.app });
    plans.set(id, { binding: selected, stamps, value });return value;
  }
  function resolveDeployment(id, model) {
    const value = plan(id), record = value.routes.get(model);
    if (!record) throw accessError("ccdx_api_model_unavailable");
    const provider = requireSource(id, record.source);
    if (provider !== record.provider) { plans.delete(id);return resolveDeployment(id, model); }
    return record;
  }
  function retire(source) { if (active.get(source)) retired.add(source);else source.close(); }
  function track(source) {
    const finishLegacy = legacy.track(source);active.set(source, (active.get(source) || 0) + 1);let done = false;
    return () => {
      if (done) return;done = true;finishLegacy?.();const count = (active.get(source) || 1) - 1;
      if (count) active.set(source, count);else { active.delete(source);if (retired.delete(source)) source.close();cleanSecrets(source.id); }
    };
  }
  function editable() {
    if (managed) return structuredClone(settings);
    const next = structuredClone(settings);next.providers.m365 = legacy.snapshot().m365.enabled === true;
    for (const id of CLIENT_IDS) next.clients[id].source = binding(id).source;
    return next;
  }
  function save(next) {
    plans.clear();
    settings = structuredClone(updateAccessSettings(current => {
      if (JSON.stringify(current) !== JSON.stringify(settings)) throw accessError("ccdx_connections_conflict", 409);return next;
    }, options));managed = true;
    for (const [id, item] of instances) {
      const current = settings.apis.find(api => api.id === id);
      if (!current?.enabled || JSON.stringify(current) !== item.signature) { instances.delete(id);retire(item.source); }else item.config = current;
    }
  }
  function summary(api) {
    if (!summaries.has(api)) summaries.set(api, { model_count: api.models.length, codex_model_count: api.models.filter(model => model.protocols.includes("responses")).length, protocols: Object.keys(api.endpoints) });
    return summaries.get(api);
  }
  function snapshot(compact = false) {
    const state = legacy.snapshot(), config = managed ? settings : editable();
    return structuredClone({ source: "connections", providers: [
      { id: "github", name: "GitHub Copilot", enabled: config.providers.github, builtin: true, protocols: ["responses"] },
      { id: "m365", name: "Microsoft 365", enabled: config.providers.m365, builtin: true, protocols: ["messages", "responses"] },
      ...config.apis.map(api => { const { secret_ref, ...publicApi } = api;return { ...(compact ? { id: api.id, name: api.name, enabled: api.enabled } : publicApi),
        ...summary(api), ...(compact ? {} : { deployment_revision: deploymentRevision(api, env) }), discovery: discoveries.get(api.id) || null, builtin: false, key_saved: api.key_env ? Boolean(env[api.key_env]) : Boolean(secret_ref) }; }),
    ], clients: CLIENT_IDS.map(id => ({ id, name: CLIENT_NAMES[id], ...config.clients[id], setup: setup[id] || null,
      observed_at: lastClients[id] || null, ...(compact ? {} : { model_plan: { default_model: plan(id).defaultModel,
        models: plan(id).models.map(model => ({ source: model.source_id, id: model.id, public_id: model.public_id, route_id: model.route_id, capability: model.capability })),
        available: config.clients[id].allowed.filter(enabled).flatMap(source => sourceModels(getSource(source), id).map(model => ({ source, id: model.id,
          route_id: deploymentModelId(source, model.id), capability: model.capability || resolveModelCapabilities(model, { builtin: true }) }))), sync: sharedSync, support: capabilitySupport } }) })), managed, m365_state: state.m365.state });
  }
  async function syncClients() {
    syncAgain = true;if (syncFlight) return syncFlight;
    syncFlight = (async () => { do { syncAgain = false;await performClientSync(); } while (syncAgain && !closed); })();
    try { return await syncFlight; } finally { syncFlight = null; }
  }
  async function performClientSync() {
    if (!managed || closed) return;
    const codex = binding("codex");
    try { if (codex.enabled && codex.auto_sync === false) setup.codex = "manual_sync";else setup.codex = configureCodex({ ...options, ...(codex.enabled && (Array.isArray(codex.deployments) || codex.source?.startsWith("api_"))
      ? { baseUrl: `http://127.0.0.1:${corePort}/v1`, apiKey: identities().codex, model: plan("codex").defaultModel || codex.model } : { restore: true }) }).state; }
    catch { setup.codex = "configuration_unavailable"; }
    if (!settings.claude_private_keys) return;
    let desktopManaged;
    for (const id of ["claude_app", "claude_code"]) {
      const selected = binding(id), compiled = plan(id), source = selected.source && permitted(id, selected.source) ? getSource(selected.source) : null;
      try {
        if (!selected.enabled || !compiled.models.length) { const result = restoreClaude({ ...options, client: id });setup[id] = result.preserved ? "preserved" : "not_configured";continue; }
        if (selected.auto_sync === false) { setup[id] = "manual_sync";continue; }
        if (id === "claude_app") desktopManaged ??= await inspectDesktop(options);
        const m365Only = compiled.models.every(model => model.source_id === "m365");
        if (id === "claude_code" && !m365Only) restoreClaude({ ...options, client: id, fields: ["env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"] });
        const result = configureClaude({ ...options, client: id, profileName: "CCDX", desktopAliases: id === "claude_app" && source?.id.startsWith("api_"), disableExperimentalBetas: m365Only, desktopManaged: id === "claude_app" ? desktopManaged : false,
          baseUrl: `http://127.0.0.1:${corePort}/anthropic`, apiKey: identities()[id], models: compiled.models, defaultModel: Array.isArray(selected.deployments) ? compiled.defaultModel : undefined });
        setup[id] = result[id === "claude_app" ? "app" : "code"] || "not_configured";
      } catch { setup[id] = "configuration_unavailable"; }
    }
    const shared = claudeSharedCapabilityPlan({ app: setup.claude_app === "configured" ? plan("claude_app").models : [],
      code: setup.claude_code === "configured" ? plan("claude_code").models : [], support: capabilitySupport });
    if (["claude_app", "claude_code"].some(id => setup[id] === "manual_sync")) {
      sharedSync = { ...shared, state: "partially_preserved", limitations: [...shared.limitations, { code: "manual_sync" }] };return;
    }
    try { sharedSync = { ...shared, ...syncClaudeCapabilities(shared, options) }; }
    catch { sharedSync = { state: "configuration_unavailable", limitations: shared.limitations }; }
  }
  function requireSource(clientId, id) {
    if (!permitted(clientId, id)) throw accessError("ccdx_client_source_disabled", 503);
    if (id === "m365" && legacy.snapshot().m365.account_change_in_flight) throw accessError("m365_account_busy", 409);
    const source = getSource(id);if (!source) throw accessError("ccdx_api_not_ready", 503);return source;
  }
  function validateConversation(body, headers, source, client = "codex") {
    if (!body || typeof body !== "object" || Array.isArray(body)) return;
    if (managed && (binding(client).history_isolation || source?.id.startsWith("api_"))) guardConversation(client, source.profileId(client === "codex" ? "responses" : "messages"), body, headers, identities()[client]);
  }
  async function change(input) {
    if (closed) throw accessError("ccdx_connections_closed", 503);
    if (!validObject(input, ["operation", "id", "config", "key", "allowed", "source", "enabled", "replacements", "model", "auto_review_model", "auto_review_effort", "deployments", "default_model", "auto_sync"])) throw accessError("ccdx_connections_action_invalid");
    const next = editable();let freshRef, previousRef;
    if (input.operation === "save_api") {
      const existing = next.apis.find(api => api.id === input.id);
      if (!existing && next.apis.length >= 16) throw accessError("ccdx_api_limit");
      if (!validObject(input.config, ["name", "base_url", "endpoints", "auth_header", "models", "key_env"])) throw accessError("ccdx_api_config_invalid");
      const id = existing?.id || "api_" + randomBytes(8).toString("hex");
      if (input.key !== undefined && input.key !== "") { checkedApiKey(input.key);freshRef = randomBytes(16).toString("hex"); }
      if (input.config.key_env && freshRef || !input.config.key_env && !freshRef && !existing?.secret_ref) throw accessError("ccdx_api_key_invalid");
      const config = checkedApi({ ...input.config, id, enabled: existing?.enabled ?? true, ...(!input.config.key_env ? { secret_ref: freshRef || existing.secret_ref } : {}) });
      if (!Array.isArray(input.allowed) || input.allowed.some(id => !CLIENT_IDS.includes(id))) throw accessError("ccdx_connections_action_invalid");
      for (const id of CLIENT_IDS) {
        const c = next.clients[id];if (c.deployments?.some(item => item.source === config.id && (!input.allowed.includes(id)
          || !config.models.some(model => model.id === item.model && model.protocols.includes(id === "codex" ? "responses" : "messages"))))) throw accessError("ccdx_source_in_use", 409);
        if (c.source === config.id && !input.allowed.includes(id)) throw accessError("ccdx_source_in_use", 409);
        if (c.source === config.id && c.enabled && !Array.isArray(c.deployments) && (!config.models.some(model => model.protocols.includes(id === "codex" ? "responses" : "messages"))
          || id === "codex" && [c.model, c.auto_review_model].filter(Boolean).some(value => !config.models.some(model => model.id === value && model.protocols.includes("responses"))))) throw accessError("ccdx_api_model_unavailable");
        if (input.allowed.includes(id) && !config.endpoints[id === "codex" ? "responses" : "messages"]) throw accessError("ccdx_api_protocol_required");
        c.allowed = [...new Set([...c.allowed.filter(value => value !== config.id), ...(input.allowed.includes(id) ? [config.id] : [])])];
      }
      if (existing) { previousRef = existing.secret_ref;next.apis[next.apis.indexOf(existing)] = config; } else next.apis.push(config);
      checkedAccessSettings(next);
      try { if (freshRef) await secrets.set(freshRef, input.key);save(next); } catch (error) { if (freshRef) await secrets.remove(freshRef).catch(() => {});throw error; }
    } else if (["client", "preview_client"].includes(input.operation)) {
      if (!CLIENT_IDS.includes(input.id) || typeof input.enabled !== "boolean" || !Array.isArray(input.allowed)
        || input.source !== null && input.source !== undefined && !input.allowed.includes(input.source)) throw accessError("ccdx_connections_action_invalid");
      const old = next.clients[input.id], retained = { ...old };if (old.source !== input.source || Array.isArray(old.deployments) && input.deployments === null) for (const key of ["model", "auto_review_model", "auto_review_effort"]) delete retained[key];
      next.clients[input.id] = { ...retained, enabled: input.enabled, allowed: input.allowed, source: input.enabled ? input.source ?? old.source : null,
        ...(input.deployments !== undefined ? { deployments: input.deployments, default_model: input.default_model ?? null, auto_sync: input.auto_sync ?? true }
          : old.source !== input.source ? { deployments: null, default_model: null } : {}),
        ...(input.model ? { model: input.model } : {}), ...(input.auto_review_model ? { auto_review_model: input.auto_review_model } : {}),
        ...(input.auto_review_effort !== undefined ? { auto_review_effort: input.auto_review_effort } : {}) };
      if (input.id !== "codex") next.claude_private_keys = true;
      if (old.source !== input.source) next.clients[input.id].history_isolation = true;
      const c = next.clients[input.id];
      if (Array.isArray(input.deployments)) {
        checkedAccessSettings(next);
        for (const item of c.deployments || []) {
          if (!enabled(item.source) || !sourceModels(getSource(item.source), input.id).some(model => model.id === item.model)) throw accessError("ccdx_api_model_unavailable");
        }
        const names = Object.fromEntries(next.apis.map(api => [api.id, api.name]));
        const compiled = compileClientModels({ client: input.id, binding: c, source: getSource, enabled, names, desktopEffortAliases: capabilitySupport.app });
        if (c.default_model && !compiled.routes.has(c.default_model)) throw accessError("ccdx_api_model_unavailable");
        c.default_model = compiled.routes.get(compiled.defaultModel)?.model.route_id || null;c.source = c.enabled ? compiled.routes.get(c.default_model)?.source || null : null;
        c.history_isolation = true;
        if (input.id === "codex") {
          c.model = compiled.routes.get(c.default_model)?.upstreamModel;
          const review = compiled.routes.get(old.auto_review_model) || [...compiled.routes.values()].find(record => record.source === old.source && record.upstreamModel === old.auto_review_model);
          if (c.default_model) c.auto_review_model = review?.source === c.source ? review.model.route_id : c.default_model;else delete c.auto_review_model;
          if (review?.source === c.source && old.auto_review_effort !== undefined) c.auto_review_effort = old.auto_review_effort;else delete c.auto_review_effort;
        }
      }
      if (c.source && !Array.isArray(input.deployments)) {
        if (!enabled(c.source)) throw accessError("ccdx_client_source_disabled", 503);
        const target = getSource(c.source), family = input.id === "codex" ? "gpt" : "claude";
        const api = settings.apis.find(api => api.id === c.source);if (api?.key_env && !env[api.key_env]) throw accessError("ccdx_api_environment_key_missing", 503);
        if (input.id !== "codex" && c.source === "github" || c.source !== "github" && !target?.models(family).length) throw accessError("ccdx_api_model_unavailable");
        if (input.id === "codex" && c.source !== "github") {
          const previous = c.source === "m365" ? legacy.selection().m365 : null;
          c.model = input.model || previous?.model || target.models("gpt")[0].id;c.auto_review_model = input.auto_review_model || previous?.auto_review_model || c.model;
          if (![c.model, c.auto_review_model].every(id => target.models("gpt").some(model => model.id === id))) throw accessError("ccdx_api_model_unavailable");
          const efforts = api ? api.models.find(model => model.id === c.auto_review_model)?.reasoning_efforts || []
            : autoReviewReasoningEfforts(target.models("gpt").find(model => model.id === c.auto_review_model));
          if (c.auto_review_effort !== undefined && c.auto_review_effort !== null && !efforts.includes(c.auto_review_effort)) throw accessError("ccdx_api_effort_unavailable");
        }
      }
      if (input.operation === "preview_client") {
        const proposed = compileClientModels({ client: input.id, binding: c, source: getSource, enabled, desktopEffortAliases: capabilitySupport.app });
        const shared = input.id === "codex" ? null : claudeSharedCapabilityPlan({ app: input.id === "claude_app" ? proposed.models : plan("claude_app").models,
          code: input.id === "claude_code" ? proposed.models : plan("claude_code").models, support: capabilitySupport });
        return { ...snapshot(), preview: { models: proposed.models.map(model => ({ source: model.source_id, id: model.id, public_id: model.public_id, capability: model.capability })),
          shared, current: input.id === "codex" ? null : inspectClaudeCapabilityConfiguration(proposed.models, options), saved: false } };
      }
      save(next);
    } else if (input.operation === "provider") {
      if (typeof input.enabled !== "boolean" || !["github", "m365", ...next.apis.map(api => api.id)].includes(input.id)) throw accessError("ccdx_connections_action_invalid");
      if (input.id === "m365" && input.enabled && env.CCDX_M365 === "0") throw accessError("ccdx_provider_environment_disabled", 409);
      if (input.id === "m365" && !input.enabled && legacy.snapshot().m365.claude.requests?.active > 0) throw accessError("ccdx_source_busy", 409);
      if (!input.enabled) {
        const affected = CLIENT_IDS.filter(id => next.clients[id].source === input.id && next.clients[id].enabled);
        if (affected.some(id => id !== "codex")) next.claude_private_keys = true;
        if (affected.length && !validObject(input.replacements, affected)) throw accessError("ccdx_source_in_use", 409);
        for (const id of affected) {
          const replacement = input.replacements[id];
          if (replacement !== null && (replacement === input.id || !permitted(id, replacement) || replacement !== "github" && !getSource(replacement)?.models(id === "codex" ? "gpt" : "claude").length)) throw accessError("ccdx_connections_action_invalid");
          next.clients[id].source = replacement;
          next.clients[id].history_isolation = true;
        }
      }
      if (!input.enabled) for (const id of CLIENT_IDS) {
        const c = next.clients[id];if (!Array.isArray(c.deployments)) continue;
        const had = c.deployments.some(item => item.source === input.id);if (!had) continue;
        c.deployments = c.deployments.filter(item => item.source !== input.id);
        if (input.replacements && Object.hasOwn(input.replacements, id)) {
          const replacement = input.replacements[id];
          if (!replacement) c.deployments = [];
          else if (!c.deployments.some(item => item.source === replacement)) {
            const model = sourceModels(getSource(replacement), id)[0];if (model) c.deployments.push({ source: replacement, model: model.id });
          }
          c.default_model = c.deployments.find(item => item.source === replacement) ? deploymentModelId(replacement, c.deployments.find(item => item.source === replacement).model) : null;
        }
      }
      if (input.id.startsWith("api_")) next.apis.find(api => api.id === input.id).enabled = input.enabled;else next.providers[input.id] = input.enabled;
      save(next);
      if (input.id === "m365") {
        if (input.enabled) await legacy.action({ action: "on" });
        else {
          const source = await legacy.pauseM365();if (source) retire(source);
        }
      }
    } else if (input.operation === "discover") {
      if (!settings.apis.some(api => api.id === input.id && api.enabled)) throw accessError("ccdx_client_source_disabled", 503);
      try {
        const models = await getSource(input.id).discover({ signal: AbortSignal.timeout(20000) });
        const byId = new Map(models.map(model => [model.id, model]));
        const config = next.apis.find(api => api.id === input.id);
        for (const model of config.models) if (byId.get(model.id)?.metadata) model.metadata = byId.get(model.id).metadata;
        config.checked_at = new Date().toISOString();save(next);
        discoveries.set(input.id, { state: "ready", checked_at: config.checked_at });await syncClients();
        return { ...snapshot(), discovered: models };
      } catch (error) { discoveries.set(input.id, { state: "stale", code: error.code || "ccdx_api_catalog_unavailable", checked_at: new Date().toISOString() });throw error; }
    } else throw accessError("ccdx_connections_action_invalid");
    await syncClients();
    if (input.operation === "client" && input.id === "codex") await clientAccessChanged?.(binding("codex").enabled);
    if (previousRef && (freshRef || input.config?.key_env)) { if (!retiredSecrets.has(input.id)) retiredSecrets.set(input.id, new Set());retiredSecrets.get(input.id).add(previousRef);cleanSecrets(input.id); }
    return snapshot();
  }
  return {
    ...legacy,
    source: getSource,
    connections: snapshot,
    syncClients,
    manageConnections(input) { if (!input) return Promise.resolve(snapshot());const job = serial.then(() => change(input));serial = job.catch(() => {});return job; },
    async start() { const old = legacy.start();if (managed) await syncClients();const result = await old;if (managed) await syncClients();return result; },
    refresh() { return !managed || settings.providers.m365 ? legacy.refresh() : Promise.resolve(); },
    selection() { return { ...legacy.selection(), codex: binding("codex").enabled ? binding("codex").source : null }; },
    providerPreference(id) {
      const c = settings.clients.codex;
      return managed && c.source === id && c.auto_review_model ? { ...c, auto_review_model: plan("codex").routes.get(c.auto_review_model)?.upstreamModel || c.auto_review_model } : legacy.selection().m365;
    },
    snapshot() {
      const result = legacy.snapshot();if (!managed) return result;
      const performance = legacy.claudePerformance.snapshot(), totals = performance.by_route.messages.terminal_outcomes.totals;
      const ms = performance.by_route.messages.by_provider.m365;
      const m365Requests = ms ? { ...ms.terminal_outcomes.totals, active: ms.active, total: ms.requests,
        performance: { by_route: { messages: { by_provider: { m365: ms }, terminal_outcomes: ms.terminal_outcomes } },
          active_total: ms.active, active_requests: performance.active_requests.filter(row => row.provider === "m365"),
          recent_requests: performance.recent_requests.filter(row => row.provider === "m365") } } : null;
      return { ...result, codex_provider: this.selection().codex, connections: snapshot(true),
        m365: { ...result.m365, ...(binding("codex").source === "m365" ? { preference: this.providerPreference(binding("codex").source) } : {}), claude: { ...result.m365.claude, requests: m365Requests,
          clients: Object.fromEntries([["app", "claude_app"], ["code", "claude_code"]].map(([short, id]) => [short, binding(id).enabled && binding(id).source === "m365" ? setup[id] || result.m365.claude.clients[short] : "not_selected"])) } },
        claude: { base_url: `http://127.0.0.1:${corePort}/anthropic`, gateway: CLIENT_IDS.some(id => id !== "codex" && binding(id).enabled && permitted(id, binding(id).source)) ? "running" : "unavailable",
          clients: { app: setup.claude_app || "not_configured", code: setup.claude_code || "not_configured" },
          requests: { ...totals, active: performance.active_total, total: Object.values(totals).reduce((sum, value) => sum + value, 0) + performance.active_total, performance } },
        ...Object.fromEntries(settings.apis.map(api => [api.id, { preference: this.providerPreference(binding("codex").source) }])) };
    },
    current(req) {
      if (!managed) return legacy.current();
      const c = binding("codex"), compiled = plan("codex");
      const source = requireSource("codex", Array.isArray(c.deployments) ? compiled.routes.get(compiled.defaultModel)?.source : c.source);
      if (Array.isArray(c.deployments) && req?.method === "GET") {
        if (codexRequiresKey()) requireCodexKey(req);
        return { ...source, registry: { models: { data: compiled.models.map(model => ({ ...model, id: model.public_id })) } },
          client: { ...source.client, listModels: async () => ({ status: 200, body: JSON.stringify({ data: compiled.models.map(model => ({ ...model, id: model.public_id })) }) }) },
          codexCatalog: codexClientCatalog(compiled, getSource) };
      }
      if (source?.id.startsWith("api_") && req) requireCodexKey(req);
      return source;
    },
    hasModelBindings(client = "codex") { return managed && Array.isArray(binding(client).deployments); },
    resolveCodex(body, req) {
      if (!managed || !Array.isArray(binding("codex").deployments)) return null;
      if (codexRequiresKey()) requireCodexKey(req);
      const requested = body.model === "codex-auto-review" ? binding("codex").auto_review_model || plan("codex").defaultModel : body.model;
      if (body.model === "codex-auto-review") {
        delete body.service_tier;
        if (binding("codex").auto_review_effort) body.reasoning = { ...body.reasoning, effort: binding("codex").auto_review_effort };
      }
      const record = resolveDeployment("codex", requested), context = currentRequestContext();
      if (context) {
        context.finishProvider?.();context.finishProvider = track(record.provider);context.provider = record.provider.id;
        context.streamPerformance?.setProvider?.(record.provider.id);
        Object.assign(context, this.historyContext(req.headers, record.provider));
      }
      body.model = record.upstreamModel;return record.provider;
    },
    track,
    validateConversation,
    historyContext(headers, target) {
      if (!target.id.startsWith("api_")) return legacy.historyContext(headers, target);
      // Opaque Responses state never transfers to another API/key/configuration.
      return { historyNamespace: target.profileId() };
    },
    async handleClaude(req, res) {
      if (!managed) return legacy.handleClaude(req, res);
      if (!settings.claude_private_keys) {
        if (["claude_app", "claude_code"].every(id => permitted(id, "m365") && binding(id).source === "m365")) return legacy.handleClaude(req, res);
        throw accessError("ccdx_client_source_disabled", 503);
      }
      const id = gatewayClient(req.headers, identities());
      if (!id || id === "codex") throw accessError("ccdx_client_credential_required", 401);
      const compiled = plan(id);if (!binding(id).enabled || !compiled.models.length) throw accessError("ccdx_client_source_disabled", 503);
      // A request resolves once after its bounded body read. Its source and
      // capability snapshot stay pinned while catalogs/configuration change.
      const catalog = { id: "connections", configuredModels: true, models: () => compiled.models };
      let cached = handlers.get(id);
      if (cached?.compiled !== compiled) {
      const handler = createClaudeGatewayHandler({ provider: catalog, acquireRequest: acquireClaudeRequest, apiKey: identities()[id], env, log, performance: legacy.claudePerformance,
        desktopAliases: id === "claude_app",
        resolveRequest(body) {
          const record = resolveDeployment(id, body.model), finish = track(record.provider);
          return { provider: record.provider, model: record.upstreamModel, capability: record.model.capability, finish };
        },
        validateConversation: (body, headers, source) => validateConversation(body, headers, source, id),
        onRequest() { lastClients[id] = new Date().toISOString(); } });
      cached = { compiled, handler };handlers.set(id, cached);
      }
      const headers = req.headers;req.headers = { ...headers, "x-ccdx-client": id === "claude_app" ? "claude-app" : "claude-code" };
      try { return await cached.handler(req, res); } finally { req.headers = headers; }
    },
    dashboardProviders() {
      const builtins = legacy.dashboardProviders();if (!managed) return builtins.filter(source => source.enabled);
      const definitions = snapshot(true).providers, performance = legacy.claudePerformance.snapshot();
      return definitions.filter(item => item.enabled).map(item => {
        const old = builtins.find(source => source.id === item.id), source = item.builtin ? null : getSource(item.id);
        const clients = CLIENT_IDS.filter(id => binding(id).enabled && binding(id).allowed.includes(item.id)
          && (id === "codex" ? item.protocols.includes("responses") : item.protocols.includes("messages"))).map(id => ({ id, name: CLIENT_NAMES[id], selected: binding(id).deployments?.some(model => model.source === item.id) || binding(id).source === item.id,
          state: setup[id] || old?.clients?.find(client => client.id === id)?.state || "unknown", gateway: binding(id).deployments?.some(model => model.source === item.id) || binding(id).source === item.id ? "running" : "standby", last_request_at: lastClients[id] || null }));
        return { ...old, id: item.id, name: item.name, enabled: true, generation: old?.generation || source?.registry.generation || 1,
          state: old?.state || "configured", auth: old?.auth || { state: "saved", token_cached: false },
          selection: { codex: clients.some(client => client.id === "codex"), models_required: item.id !== "github" }, clients,
          models: old?.models || { count: item.model_count, source: "configured" },
          requests: performance.by_route.messages.by_provider[item.id] ? { ...performance.by_route.messages.by_provider[item.id].terminal_outcomes.totals,
            active: performance.by_route.messages.by_provider[item.id].active, total: performance.by_route.messages.by_provider[item.id].requests } : null };
      });
    },
    dashboardCatalog(input = {}) {
      if (!input.provider?.startsWith("api_")) return legacy.dashboardCatalog(input);
      if (!enabled(input.provider)) throw accessError("ccdx_client_source_disabled", 503);
      return getSource(input.provider).publicCatalog(CLIENT_IDS.filter(id => binding(id).enabled && binding(id).allowed.includes(input.provider)));
    },
    async action(input) {
      if (managed && input.action === "auto-review" && Array.isArray(binding("codex").deployments)) {
        const c = binding("codex"), compiled = plan("codex");
        if (!c.enabled || input.provider !== c.source) throw accessError("ccdx_client_source_mismatch", 409);
        const record = [...compiled.routes.values()].find(record => record.source === input.provider && record.upstreamModel === input.model);
        if (!record) throw accessError("ccdx_api_model_unavailable");
        if (input.effort && !record.model.capability.values.reasoning_efforts?.includes(input.effort)) throw accessError("ccdx_api_effort_unavailable");
        const next = editable();next.clients.codex.auto_review_model = record.model.route_id;next.clients.codex.auto_review_effort = input.effort || null;save(next);return this.snapshot();
      }
      if (managed && input.action === "auto-review" && input.provider && input.provider !== this.selection().codex) throw accessError("ccdx_client_source_mismatch", 409);
      if (managed && input.action === "auto-review" && (!binding("codex").enabled || !binding("codex").source)) throw accessError("ccdx_client_source_disabled", 503);
      if (managed && ["on", "off", "remove"].includes(input.action)) {
        if (input.action === "remove" && legacy.snapshot().m365.active_requests > 0) throw accessError("ccdx_source_busy", 409);
        const replacements = Object.fromEntries(CLIENT_IDS.filter(id => binding(id).source === "m365" && binding(id).enabled).map(id => [id, null]));
        await this.manageConnections({ operation: "provider", id: "m365", enabled: input.action === "on", replacements });
        if (input.action === "remove") legacy.removeM365SavedProfile();return this.snapshot();
      }
      if (managed && input.action === "switch" && !binding("codex").enabled) throw accessError("ccdx_client_source_disabled", 503);
      const { history_isolation, ...clientInput } = binding("codex");
      if (input.action === "switch" && input.provider?.startsWith("api_")) { await this.manageConnections({ operation: "client", id: "codex", ...clientInput, deployments: null, default_model: null, source: input.provider,
        model: input.model, auto_review_model: input.auto_review_model, auto_review_effort: input.auto_review_effort });return this.snapshot(); }
      if (input.action === "auto-review" && managed && binding("codex").source !== "github") { await this.manageConnections({ operation: "client", id: "codex", ...clientInput, auto_review_model: input.model, auto_review_effort: input.effort });return this.snapshot(); }
      if (input.action === "auto-review" && managed && legacy.selection().codex !== "github") await legacy.action({ action: "switch", provider: "github" });
      if (managed && input.action === "switch" && !permitted("codex", input.provider)) throw accessError("ccdx_client_source_disabled", 503);
      const result = await legacy.action(input);
      if (managed && input.action === "switch") { const next = editable();if (next.clients.codex.source !== input.provider) next.clients.codex.history_isolation = true;next.clients.codex.source = input.provider;next.clients.codex.deployments = null;next.clients.codex.default_model = null;for (const key of ["model", "auto_review_model", "auto_review_effort"]) delete next.clients.codex[key];if (input.provider === "m365") Object.assign(next.clients.codex, legacy.selection().m365);save(next);await syncClients(); }
      return result;
    },
    async close() { closed = true;await serial;await syncFlight;for (const { source } of instances.values()) source.close();for (const source of retired) source.close();active.clear();for (const id of retiredSecrets.keys()) cleanSecrets(id);await Promise.allSettled([...cleanups]);secrets.close();await legacy.close(); },
  };
}
