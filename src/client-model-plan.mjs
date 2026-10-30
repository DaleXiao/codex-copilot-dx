import { deploymentModelId, resolveModelCapabilities } from "./model-capabilities.mjs";
import { claudeModelEntries } from "./claude-models.mjs";
import { claudeDeploymentId, claudeRouteAliases } from "./clients/claude-models.mjs";
import { modelDisplayName } from "./model-display.mjs";

const endpoints = { codex: ["/responses", "/v1/responses"], claude_app: ["/v1/messages"], claude_code: ["/v1/messages"] };
export function clientModelExclusion({ client, binding, sourceId, sourceEnabled, model, selected }) {
  if (!binding.enabled) return "app_disabled";
  if (!sourceEnabled) return "source_disabled";
  if (!binding.allowed.includes(sourceId)) return "source_not_allowed";
  if (!model) return "model_missing";
  if (["restricted", "hidden"].includes(model.state)) return "source_restricted";
  const protocol = client === "codex" ? "responses" : "messages";
  if (!model.endpoints.includes(protocol) && !(client === "codex" && sourceId === "github" && model.endpoints.includes("chat"))) return "protocol_unsupported";
  return selected ? null : "model_not_selected";
}
export function sourceModels(source, client) {
  if (!source) return [];
  const models = source.models?.(client === "codex" ? "gpt" : "claude") || source.registry?.models?.data || [];
  return models.filter(model => model.supported_endpoints?.some(endpoint => endpoints[client].includes(endpoint)
    || client === "codex" && source.id === "github" && ["/chat/completions", "/v1/chat/completions"].includes(endpoint)))
    .map(model => model.protocol_capabilities ? { ...model, capability: model.protocol_capabilities[client === "codex" ? "responses" : "messages"] } : model);
}

export function compileClientModels({ client, binding, source, enabled, names = {}, desktopEffortAliases = false }) {
  if (!binding.enabled) return { models: [], routes: new Map(), defaultModel: null, revision: "disabled" };
  const explicit = Array.isArray(binding.deployments), selected = explicit ? binding.deployments : binding.source
    ? sourceModels(source(binding.source), client).map(model => ({ source: binding.source, model: model.id })) : [];
  const models = [], routes = new Map(), raw = new Map(), catalogs = new Map(), available = [], counts = new Map(), labels = new Map(), sourceLabels = new Map();
  for (const item of selected) {
    if (!binding.allowed.includes(item.source) || !enabled(item.source)) continue;
    const provider = source(item.source);
    if (!catalogs.has(provider)) catalogs.set(provider, new Map(sourceModels(provider, client).map(model => [model.id, model])));
    const model = catalogs.get(provider).get(item.model);
    if (!model || model.policy?.state && model.policy.state !== "enabled" || model.model_picker_enabled === false) continue;
    const label = modelDisplayName(model), sourceName = names[item.source] || provider.name || ({ github: "GitHub Copilot", m365: "Microsoft 365" })[item.source] || item.source;
    const key = JSON.stringify([label, sourceName]);
    available.push({ item, provider, model, label, sourceName, key, route: deploymentModelId(item.source, model.id) });counts.set(model.id, (counts.get(model.id) || 0) + 1);
    labels.set(label, (labels.get(label) || 0) + 1);sourceLabels.set(key, (sourceLabels.get(key) || 0) + 1);
  }
  const routeIds = new Set(available.map(entry => entry.route));
  for (const { item, provider, model, route, label, sourceName, key } of available) {
    const capability = model.capability || resolveModelCapabilities(model, { builtin: true });
    const ambiguous = counts.get(model.id) > 1;
    const display = sourceLabels.get(key) > 1 ? `${label} · ${sourceName} (${model.id})` : labels.get(label) > 1 ? `${label} · ${sourceName}` : label;
    const entry = { ...model, display_name: display, capability, source_id: item.source, source_name: sourceName, route_id: route,
      ...(explicit ? { client_id: client === "codex" && !ambiguous && !routeIds.has(model.id) ? model.id : route } : {}) };
    if (client === "claude_app" && explicit) entry.client_id = claudeDeploymentId(entry, route, { desktopEffortAliases });
    const publicId = explicit ? entry.client_id : client === "codex" ? model.id : claudeModelEntries([entry], { desktopAliases: client === "claude_app" && provider.id.startsWith("api_") })[0].name;
    entry.public_id = publicId;
    const record = { provider, model: entry, source: item.source, upstreamModel: model.id, publicId };
    if (routes.has(publicId)) throw Object.assign(new Error("Model routes collide"), { code: "ccdx_model_route_collision", statusCode: 503 });
    routes.set(publicId, record);routes.set(route, record);
    if (client === "claude_app" && explicit) for (const alias of claudeRouteAliases(entry, route, true).slice(2)) routes.set(alias, record);
    models.push(entry);
    raw.set(model.id, raw.has(model.id) ? null : record);
  }
  // Old model IDs/desktop aliases remain valid only when they resolve to one
  // authorized deployment. Same-named deployments never pick the first source.
  for (const [id, record] of raw) if (record && !routes.has(id)) {
    routes.set(id, record);
    if (client !== "codex") {
      for (const old of claudeRouteAliases(record.model, record.model.route_id, false)) {
        if (!routes.has(old)) routes.set(old, record);
      }
    }
  }
  const requested = explicit ? binding.default_model : binding.model;
  const chosen = routes.get(requested) || (!requested ? models[0] && routes.get(models[0].public_id) : null);
  return { models, routes, defaultModel: chosen?.publicId || null, defaultUnavailable: Boolean(requested && !chosen),
    revision: models.map(model => model.route_id + ":" + model.capability.revision).join(";") };
}
