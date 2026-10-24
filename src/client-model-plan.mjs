import { deploymentModelId, resolveModelCapabilities } from "./model-capabilities.mjs";
import { claudeModelEntries } from "./claude-models.mjs";
import { claudeDeploymentId, claudeRouteAliases } from "./clients/claude-models.mjs";

const endpoints = { codex: ["/responses", "/v1/responses"], claude_app: ["/v1/messages"], claude_code: ["/v1/messages"] };
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
  const models = [], routes = new Map(), raw = new Map();
  for (const item of selected) {
    if (!binding.allowed.includes(item.source) || !enabled(item.source)) continue;
    const provider = source(item.source), model = sourceModels(provider, client).find(model => model.id === item.model);
    if (!model || model.policy?.state && model.policy.state !== "enabled" || model.model_picker_enabled === false) continue;
    const route = deploymentModelId(item.source, model.id), capability = model.capability || resolveModelCapabilities(model, { builtin: true });
    const entry = { ...model, capability, source_id: item.source, route_id: route,
      ...(explicit ? { client_id: route, display_name: `${model.id} · ${names[item.source] || item.source}` } : {}) };
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
  const fallback = models.find(model => model.id === binding.model || model.route_id === binding.default_model) || models[0];
  return { models, routes, defaultModel: routes.get(binding.default_model)?.publicId || fallback?.public_id || null,
    revision: models.map(model => model.route_id + ":" + model.capability.revision).join(";") };
}
