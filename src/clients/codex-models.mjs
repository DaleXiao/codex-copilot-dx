// Codex's native catalog is an application projection, not provider metadata.
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
export function codexClientCatalog(plan) {
  return Object.assign((value, nativeCatalog) => ({ ...value, models: plan.models.map((model, priority) => {
    const template = model.source_id === "github" ? nativeCatalog?.models?.find(entry => entry.slug === model.id) : undefined;
    return codexModelEntry(model, { priority, template, name: model.source_id });
  }) }), { needsNativeCatalog: plan.models.some(model => model.source_id === "github") });
}

export function codexSourceCatalog(source) {
  return value => ({ ...value, models: source.models("gpt").map((model, priority) =>
    codexModelEntry({ ...model, capability: model.protocol_capabilities?.responses || model.capability }, { priority, name: source.name || source.id })) });
}
