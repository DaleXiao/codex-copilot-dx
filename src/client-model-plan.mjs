import { deploymentModelId, resolveModelCapabilities, claudeEffortsExpressible } from "./model-capabilities.mjs";
import { claudeModelEntries } from "./claude-models.mjs";

const endpoints = { codex: ["/responses", "/v1/responses"], claude_app: ["/v1/messages"], claude_code: ["/v1/messages"] };
export function sourceModels(source, client) {
  if (!source) return [];
  const models = source.models?.(client === "codex" ? "gpt" : "claude") || source.registry?.models?.data || [];
  return models.filter(model => model.supported_endpoints?.some(endpoint => endpoints[client].includes(endpoint)
    || client === "codex" && source.id === "github" && ["/chat/completions", "/v1/chat/completions"].includes(endpoint)));
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
    if (client === "claude_app" && explicit) {
      const number = route.slice("ccdx/model-".length);
      const efforts = capability.values.reasoning === false ? [] : capability.values.reasoning_efforts || [];
      const native = /^claude-(?:opus|sonnet|haiku)-\d[\d.-]*(?:-latest)?$/.test(model.id);
      entry.client_id = native ? `ccdx-${number}.anthropic.${model.id.replace(/(\d)\.(\d)/g, "$1-$2")}`
        : desktopEffortAliases && claudeEffortsExpressible(capability.values) ? `mythos-ccdx-${number}` : `ccdx/claude-compatible-${number}`;
    }
    const publicId = explicit ? entry.client_id : client === "codex" ? model.id : claudeModelEntries([entry], { desktopAliases: client === "claude_app" && provider.id.startsWith("api_") })[0].name;
    entry.public_id = publicId;
    const record = { provider, model: entry, source: item.source, upstreamModel: model.id, publicId };
    if (routes.has(publicId)) throw Object.assign(new Error("Model routes collide"), { code: "ccdx_model_route_collision", statusCode: 503 });
    routes.set(publicId, record);routes.set(route, record);
    if (client === "claude_app" && explicit) {
      const number = route.slice("ccdx/model-".length);routes.set(`mythos-ccdx-${number}`, record);routes.set(`ccdx/claude-compatible-${number}`, record);
    }
    models.push(entry);
    raw.set(model.id, raw.has(model.id) ? null : record);
  }
  // Old model IDs/desktop aliases remain valid only when they resolve to one
  // authorized deployment. Same-named deployments never pick the first source.
  for (const [id, record] of raw) if (record && !routes.has(id)) {
    routes.set(id, record);
    if (client !== "codex") {
      for (const options of [{ desktopAliases: false }, { desktopAliases: true }]) {
        const old = claudeModelEntries([{ ...record.model, client_id: undefined }], options)[0].name;
        if (!routes.has(old)) routes.set(old, record);
      }
    }
  }
  const fallback = models.find(model => model.id === binding.model || model.route_id === binding.default_model) || models[0];
  return { models, routes, defaultModel: routes.get(binding.default_model)?.publicId || fallback?.public_id || null,
    revision: models.map(model => model.route_id + ":" + model.capability.revision).join(";") };
}

// Client metadata is a projection, never a source of deployment capabilities.
export function codexModelEntry(model, { priority = 0, name = "", template = {} } = {}) {
  const values = model.capability?.values || {}, efforts = values.reasoning === false ? [] : values.reasoning_efforts || [];
  return { shell_type: "unified_exec", availability_nux: null, upgrade: null, additional_speed_tiers: [], service_tiers: [],
    base_instructions: "", support_verbosity: false, default_verbosity: null, apply_patch_tool_type: null,
    supports_reasoning_summary_parameter: false, default_reasoning_summary: "none", truncation_policy: { mode: "bytes", limit: 10000 },
    experimental_supported_tools: [], input_modalities: values.input_modalities || ["text"], ...template,
    slug: model.public_id || model.id, display_name: model.display_name || model.id, description: name, visibility: "list", supported_in_api: true, priority,
    default_reasoning_level: efforts[0] || null, supported_reasoning_levels: efforts.map(effort => ({ effort, description: effort })),
    context_window: values.context_window || template.context_window || null, max_context_window: values.context_window || template.max_context_window || null };
}
export function codexClientCatalog(plan, source) {
  return Object.assign((value, nativeCatalog) => ({ ...value, models: plan.models.map((model, priority) => {
    const template = model.source_id === "github" ? nativeCatalog?.models?.find(entry => entry.slug === model.id)
      : source(model.source_id).codexCatalog?.({ models: [] })?.models?.find(entry => entry.slug === model.id);
    return codexModelEntry(model, { priority, template, name: model.source_id });
  }) }), { needsNativeCatalog: plan.models.some(model => model.source_id === "github") });
}
