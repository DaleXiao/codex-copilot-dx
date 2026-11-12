import { createHash } from "node:crypto";
import { imageModelCatalog, imageModelSelection } from "./image-models.mjs";
import { CLIENT_IDS, CLIENT_NAMES } from "./access-settings.mjs";
import { publicModelCatalog } from "./provider-metadata.mjs";
import { sourceModels, clientModelExclusion } from "./client-model-plan.mjs";
import { deploymentModelId, resolveModelCapabilities, deploymentRevision } from "./model-capabilities.mjs";

export function createConnectionView({ legacy, env, binding, plan, getSource, enabled, editable, modelDisplay, discoveries,
  setup, credentialStates, lastClients, memoryModel, capabilitySupport, sharedSync, isManaged, getSettings, corePort, permitted }) {
  const summaries = new WeakMap();
  function summary(api) {
    if (!summaries.has(api))
      summaries.set(api, {
        model_count: api.models.length,
        codex_model_count: api.models.filter(model => model.protocols.includes("responses")).length,
        protocols: Object.keys(api.endpoints),
      });
    return summaries.get(api);
  }
  function imageModels() {
    const c = binding("codex");
    return imageModelSelection(enabled("github") && c.allowed.includes("github")
      ? imageModelCatalog(legacy.github?.registry?.models) : [], c.image_model);
  }
  function clientSnapshot(id, config, compact, readPlan) {
    const base = {
      id,
      name: CLIENT_NAMES[id],
      ...config.clients[id],
      setup: setup[id] || null,
      ...(credentialStates[id] ? { credential_state: credentialStates[id] } : {}),
      ...(id === "codex" ? { memory_model: memoryModel.snapshot() } : {}),
      observed_at: lastClients[id] || null,
    };
    if (compact) return base;
    const revision = clientRevision(id),
      compiled = readPlan(id);
    return {
      ...base,
      revision,
      model_plan: {
        ...(id === "codex" ? { image: imageModels() } : {}),
        default_model: compiled.defaultModel,
        default_unavailable: compiled.defaultUnavailable,
        models: compiled.models.map(model => ({
          source: model.source_id,
          id: model.id,
          display_name: model.display_name,
          public_id: model.public_id,
          route_id: model.route_id,
          capability: model.capability,
        })),
        unavailable: (config.clients[id].deployments || [])
          .filter(
            item => !compiled.models.some(model => model.source_id === item.source && model.id === item.model)
          )
          .map(item => ({
            source: item.source,
            id: item.model,
            route_id: deploymentModelId(item.source, item.model),
            reason: modelExclusion(id, item.source, item.model),
          })),
        available: config.clients[id].allowed
          .filter(enabled)
          .flatMap(source =>
            sourceModels(getSource(source), id).map(model => ({
              source,
              id: model.id,
              display_name: model.display_name || model.name || model.id,
              route_id: deploymentModelId(source, model.id),
              capability: model.capability || resolveModelCapabilities(model, { builtin: true }),
            }))
          ),
        sync: sharedSync(),
        support: capabilitySupport,
      },
    };
  }
  function modelExclusion(id, sourceId, modelId, model, selected = false) {
    if (!model) {
      const source = getSource(sourceId), raw = source?.catalog?.() || source?.registry?.models?.data || [];
      model = publicModelCatalog(raw.filter(value => value.id === modelId))[0];
    }
    return clientModelExclusion({ client: id, binding: binding(id), sourceId, sourceEnabled: enabled(sourceId), model, selected });
  }
  function catalogVisibility(catalog, sourceId) {
    if (!catalog || !Array.isArray(catalog.models)) return catalog;
    const selected = new Map(CLIENT_IDS.map(id => [id, new Set(plan(id).models.filter(model => model.source_id === sourceId).map(model => model.id))]));
    return { ...catalog, models: catalog.models.map(model => ({ ...model,
      client_visibility: CLIENT_IDS.map(id => ({ client: id,
        reason: modelExclusion(id, sourceId, model.id, model, selected.get(id).has(model.id) || id === "codex" && sourceId === "github" && model.kind === "image" && imageModels().selected_model === model.id) })) })) };
  }
  function snapshot(compact = false) {
    const state = legacy.snapshot(),
      config = isManaged() ? getSettings() : editable();
    const localPlans = new Map();
    const readPlan = id => {
      if (!localPlans.has(id)) localPlans.set(id, plan(id));
      return localPlans.get(id);
    };
    return structuredClone({
      source: "connections",
      providers: [
        {
          id: "github",
          name: "GitHub Copilot",
          enabled: config.providers.github,
          builtin: true,
          protocols: ["responses"],
        },
        {
          id: "m365",
          name: "Microsoft 365",
          enabled: config.providers.m365,
          builtin: true,
          protocols: ["messages", "responses"],
        },
        ...config.apis.map(api => {
          const { secret_ref, ...publicApi } = api,
            revision = compact ? null : deploymentRevision(api, env);
          return {
            ...(compact ? { id: api.id, name: api.name, enabled: api.enabled } : publicApi),
            ...summary(api),
            ...(compact
              ? {}
              : {
                  deployment_revision: revision,
                  model_display: Object.fromEntries(
                    api.models.map(model => [model.id, modelDisplay.get(api.id, revision, model.id)])
                  ),
                }),
            discovery: discoveries.get(api.id) || null,
            builtin: false,
            key_saved: api.key_env ? Boolean(env[api.key_env]) : Boolean(secret_ref),
          };
        }),
      ],
      clients: CLIENT_IDS.map(id => clientSnapshot(id, config, compact, readPlan)),
      ...(!compact
        ? {
            source_impacts: Object.fromEntries(
              ["github", "m365", ...config.apis.map(api => api.id)].map(id => [
                id,
                sourceImpact(id, readPlan),
              ])
            ),
          }
        : {}),
      managed: isManaged(),
      ...(!compact ? { management_version: 1 } : {}),
      m365_state: state.m365.state,
    });
  }
  const clientRevision = id =>
    createHash("sha256")
      .update(JSON.stringify(binding(id)))
      .digest("hex");
  function sourceImpact(source, readPlan = plan) {
    const clients = CLIENT_IDS.flatMap(id => {
      const c = binding(id);
      if (!c.enabled) return [];
      const explicit = Array.isArray(c.deployments),
        removed = explicit ? c.deployments.filter(item => item.source === source) : [];
      if (explicit ? !removed.length : c.source !== source) return [];
      const remaining = explicit ? c.deployments.length - removed.length : 0;
      const defaultSource =
        readPlan(id).routes.get(c.default_model)?.source ||
        removed.find(item => deploymentModelId(source, item.model) === c.default_model)?.source ||
        c.source;
      const default_affected = defaultSource === source;
      return [
        {
          id,
          removed: explicit ? removed.length : sourceModels(getSource(source), id).length,
          remaining,
          default_affected,
          needs_replacement: default_affected || remaining === 0,
        },
      ];
    });
    const api = getSettings().apis.find(item => item.id === source),
      profile = api ? deploymentRevision(api, env) : getSource(source)?.profileId();
    return {
      clients,
      revision: createHash("sha256")
        .update(JSON.stringify([source, enabled(source), profile, CLIENT_IDS.map(id => binding(id))]))
        .digest("hex"),
    };
  }
  const methods = {
    snapshot() {
      const result = legacy.snapshot();
      if (!isManaged()) return result;
      const performance = legacy.claudePerformance.snapshot(),
        totals = performance.by_route.messages.terminal_outcomes.totals;
      const ms = performance.by_route.messages.by_provider.m365;
      const m365Requests = ms
        ? {
            ...ms.terminal_outcomes.totals,
            active: ms.active,
            total: ms.requests,
            performance: {
              by_route: { messages: { by_provider: { m365: ms }, terminal_outcomes: ms.terminal_outcomes } },
              active_total: ms.active,
              active_requests: performance.active_requests.filter(row => row.provider === "m365"),
              recent_requests: performance.recent_requests.filter(row => row.provider === "m365"),
            },
          }
        : null;
      return {
        ...result,
        codex_provider: this.selection().codex,
        connections: snapshot(true),
        m365: {
          ...result.m365,
          ...(binding("codex").source === "m365"
            ? { preference: this.providerPreference(binding("codex").source) }
            : {}),
          claude: {
            ...result.m365.claude,
            requests: m365Requests,
            clients: Object.fromEntries(
              [
                ["app", "claude_app"],
                ["code", "claude_code"],
              ].map(([short, id]) => [
                short,
                binding(id).enabled && binding(id).source === "m365"
                  ? setup[id] || result.m365.claude.clients[short]
                  : "not_selected",
              ])
            ),
          },
        },
        claude: {
          base_url: `http://127.0.0.1:${corePort}/anthropic`,
          gateway: CLIENT_IDS.some(
            id => id !== "codex" && binding(id).enabled && permitted(id, binding(id).source)
          )
            ? "running"
            : "unavailable",
          clients: { app: setup.claude_app || "not_configured", code: setup.claude_code || "not_configured" },
          requests: {
            ...totals,
            active: performance.active_total,
            total: Object.values(totals).reduce((sum, value) => sum + value, 0) + performance.active_total,
            performance,
          },
        },
        ...Object.fromEntries(
          getSettings().apis.map(api => [api.id, { preference: this.providerPreference(binding("codex").source) }])
        ),
      };
    },
    dashboardProviders() {
      const builtins = legacy.dashboardProviders();
      if (!isManaged()) return builtins.filter(source => source.enabled);
      const definitions = snapshot(true).providers,
        performance = legacy.claudePerformance.snapshot();
      return definitions
        .filter(item => item.enabled)
        .map(item => {
          const old = builtins.find(source => source.id === item.id),
            source = item.builtin ? null : getSource(item.id);
          const clients = CLIENT_IDS.filter(
            id =>
              binding(id).enabled &&
              binding(id).allowed.includes(item.id) &&
              (id === "codex" ? item.protocols.includes("responses") : item.protocols.includes("messages"))
          ).map(id => ({
            id,
            name: CLIENT_NAMES[id],
            selected:
              binding(id).deployments?.some(model => model.source === item.id) ||
              binding(id).source === item.id,
            state: setup[id] || old?.clients?.find(client => client.id === id)?.state || "unknown",
            gateway:
              binding(id).deployments?.some(model => model.source === item.id) ||
              binding(id).source === item.id
                ? "running"
                : "standby",
            last_request_at: lastClients[id] || null,
          }));
          return {
            ...old,
            id: item.id,
            name: item.name,
            enabled: true,
            generation: old?.generation || source?.registry.generation || 1,
            state: old?.state || "configured",
            auth: old?.auth || { state: "saved", token_cached: false },
            selection: {
              codex: clients.some(client => client.id === "codex"),
              models_required: item.id !== "github",
            },
            clients,
            models: old?.models || { count: item.model_count, source: "configured" },
            requests: performance.by_route.messages.by_provider[item.id]
              ? {
                  ...performance.by_route.messages.by_provider[item.id].terminal_outcomes.totals,
                  active: performance.by_route.messages.by_provider[item.id].active,
                  total: performance.by_route.messages.by_provider[item.id].requests,
                }
              : null,
          };
        });
    },
    dashboardCatalog(input = {}) {
      if (!input.provider?.startsWith("api_")) {
        const value = legacy.dashboardCatalog(input), source = input.provider || this.selection().codex;
        return value?.then ? value.then(catalog => catalogVisibility(catalog, source)) : catalogVisibility(value, source);
      }
      if (!enabled(input.provider)) throw accessError("ccdx_client_source_disabled", 503);
      return catalogVisibility(getSource(input.provider).publicCatalog(CLIENT_IDS), input.provider);
    },
  };
  return { imageModels, snapshot, sourceImpact, clientRevision, catalogVisibility, methods };
}
