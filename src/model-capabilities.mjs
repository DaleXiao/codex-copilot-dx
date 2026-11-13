import { createHash } from "node:crypto";

export const MODEL_PROTOCOLS = Object.freeze(["messages", "responses", "chat"]);
export const REASONING_EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const limits = ["context_window", "max_input_tokens", "max_output_tokens", "reasoning_budget_min", "reasoning_budget_max", "max_tool_definitions"];
export const MODEL_PARAMETERS = Object.freeze(["max_tokens", "max_output_tokens", "max_completion_tokens", "temperature", "top_p", "tools", "tool_choice", "parallel_tool_calls", "thinking", "output_config", "reasoning", "reasoning_effort", "response_format", "text", "stop", "stop_sequences", "stream", "stream_options"]);
const flags = ["reasoning", "reasoning_required", "reasoning_adaptive", "tools", "parallel_tools", "streaming", "structured_output", "mid_conversation_system"];
export const CAPABILITY_FIELDS = Object.freeze([...limits, ...flags, "reasoning_efforts", "reasoning_format", "thinking_modes", "input_modalities", "web_search", "supported_parameters"]);
const object = value => value && typeof value === "object" && !Array.isArray(value);
export function validCapabilities(value) {
  return object(value) && Object.entries(value).every(([key, item]) => {
    if (limits.includes(key)) return Number.isSafeInteger(item) && item > 0 && item <= 100000000;
    if (flags.includes(key)) return typeof item === "boolean";
    if (key === "reasoning_format") return MODEL_PROTOCOLS.includes(item);
    const choices = key === "supported_parameters" ? MODEL_PARAMETERS : key === "reasoning_efforts" ? REASONING_EFFORTS : key === "thinking_modes" ? ["disabled", "enabled", "adaptive", "between_tools"] : key === "input_modalities" ? ["text", "image", "audio", "video", "file"] : key === "web_search" ? MODEL_PROTOCOLS : null;
    return choices && Array.isArray(item) && item.length <= choices.length && new Set(item).size === item.length && item.every(v => choices.includes(v));
  }) && !(value.max_input_tokens && value.context_window && value.max_input_tokens > value.context_window)
    && !(value.reasoning_budget_min && value.reasoning_budget_max && value.reasoning_budget_min > value.reasoning_budget_max);
}

// The identity excludes display names and catalog edits. A key/endpoint change
// invalidates deployment evidence without changing the public model route.
export function deploymentRevision(config, env = process.env) {
  return createHash("sha256").update(JSON.stringify([config.base_url, config.endpoints, config.auth_header,
    config.key_env ? [config.key_env, env[config.key_env] || ""] : config.secret_ref])).digest("hex").slice(0, 32);
}
export function deploymentModelId(source, model) {
  return `ccdx/model-${BigInt("0x" + createHash("sha256").update(source + "\0" + model).digest("hex").slice(0, 24))}`;
}

// Interpret explicit fields only. A name or a working text reply is not evidence
// for a context size, reasoning mode, image input or native search.
export function catalogCapabilities(model) {
  const caps = model?.capabilities || {}, window = caps.limits || {}, supports = caps.supports || {}, values = {};
  const first = (...items) => items.find(value => value !== undefined && value !== null);
  const candidate = {
    context_window: first(model.context_window, window.max_context_window_tokens),
    max_input_tokens: first(model.max_input_tokens, window.max_prompt_tokens, window.max_input_tokens),
    max_output_tokens: first(model.max_output_tokens, window.max_output_tokens),
    max_tool_definitions: first(model.max_tool_definitions, window.max_tool_definitions),
    reasoning: first(typeof caps.reasoning === "boolean" ? caps.reasoning : undefined, supports.reasoning),
    reasoning_efforts: first(model.reasoning_efforts, supports.reasoning_effort),
    input_modalities: first(model.input_modalities, caps.input_modalities, supports.vision === true ? ["text", "image"] : undefined),
    tools: first(supports.tools, supports.tool_calls), parallel_tools: supports.parallel_tool_calls, streaming: supports.streaming, mid_conversation_system: supports.mid_conversation_system,
    structured_output: first(supports.structured_output, supports.structured_outputs), web_search: first(model.web_search, caps.web_search), thinking_modes: first(model.thinking_modes, caps.thinking_modes),
    ...Object.fromEntries(["reasoning_required", "reasoning_adaptive", "reasoning_budget_min", "reasoning_budget_max", "reasoning_format"].map(key => [key, first(model[key], caps[key])])),
  };
  for (const [key, value] of Object.entries(candidate)) if (value !== undefined && validCapabilities({ [key]: value })) values[key] = value;
  if (values.max_input_tokens > values.context_window) delete values.max_input_tokens;
  if (values.reasoning_budget_min > values.reasoning_budget_max) { delete values.reasoning_budget_min;delete values.reasoning_budget_max; }
  return values;
}

export function resolveModelCapabilities(model, { revision, checkedAt = null, builtin = false, protocol } = {}) {
  const metadata = model.metadata?.deployment === revision ? model.metadata : null;
  const fields = {}, declared = builtin ? catalogCapabilities(model) : { ...metadata?.values, ...metadata?.protocols?.[protocol] };
  const put = (values, source, time) => { for (const [key, value] of Object.entries(values || {})) fields[key] = { value, source, checked_at: time }; };
  put(declared, "catalog", builtin ? checkedAt : model.metadata?.checked_at || null);
  if (!builtin) {
    put({ ...(model.context_window === undefined ? {} : { context_window: model.context_window }),
      ...(model.reasoning_efforts === undefined ? {} : { reasoning_efforts: model.reasoning_efforts }) }, "manual", null);
    put(Object.fromEntries(Object.entries(model.capabilities || {}).filter(([key, value]) => validCapabilities({ [key]: value }))), "manual", null);
  }
  const values = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]));
  if (protocol && values.reasoning_format && values.reasoning_format !== protocol) {
    for (const key of ["reasoning", "reasoning_efforts", "reasoning_required", "reasoning_adaptive", "reasoning_budget_min", "reasoning_budget_max", "reasoning_format", "thinking_modes"]) delete values[key];
  }
  if (values.reasoning === false) { delete values.reasoning_efforts;delete values.reasoning_adaptive;delete values.reasoning_required; }
  const revisionId = createHash("sha256").update(JSON.stringify([revision, values])).digest("hex").slice(0, 16);
  return { values, fields, revision: revisionId, stale: Boolean(model.metadata && model.metadata.deployment !== revision),
    ...(metadata?.state ? { catalog_state: metadata.state } : {}) };
}

export function claudeEffortsExpressible(values = {}) {
  const levels = values.reasoning === false ? [] : values.reasoning_efforts || [];
  const native = ["low", "medium", "high", "xhigh", "max"];
  const base = Math.min(2, Math.max(...levels.map(value => native.indexOf(value))));
  return levels.length > 0 && levels.every(value => native.includes(value)) && native.slice(0, base + 1).every(value => levels.includes(value));
}

export function claudeEffortPrefix(values = {}) {
  const levels = values.reasoning === false ? [] : values.reasoning_efforts || [];
  const native = ["low", "medium", "high", "xhigh", "max"];
  if (!Array.isArray(levels) || !levels.length || new Set(levels).size !== levels.length || levels.some(value => !native.includes(value))) return [];
  const missing = native.findIndex(value => !levels.includes(value));
  const prefix = native.slice(0, missing < 0 ? native.length : missing);
  return prefix.length === levels.length || prefix.length >= 2 ? prefix : [];
}

function invalidRequestParameter(message, code, param) {
  throw Object.assign(new Error(message), { code, statusCode: 400, param });
}
export function constrainModelRequest(body, capability, protocol) {
  const values = capability?.values || {}, outputKey = protocol === "messages" ? "max_tokens" : protocol === "responses" ? "max_output_tokens" : "max_completion_tokens";
  let result = body;const applied = [];
  if (body[outputKey] !== undefined && (!Number.isSafeInteger(body[outputKey]) || body[outputKey] <= 0)) invalidRequestParameter("The output token limit must be a positive integer.", "ccdx_api_output_limit_invalid", outputKey);
  if (protocol === "chat" && body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0)) invalidRequestParameter("The output token limit must be a positive integer.", "ccdx_api_output_limit_invalid", "max_tokens");
  if (values.supported_parameters) for (const key of MODEL_PARAMETERS) {
    if (Object.hasOwn(body, key) && !values.supported_parameters.includes(key)) invalidRequestParameter("This deployment does not declare support for the requested parameter: " + key + ".", "ccdx_api_parameter_unavailable", key);
  }
  if (values.max_tool_definitions && Array.isArray(body.tools) && body.tools.length > values.max_tool_definitions)
    invalidRequestParameter("The number of tool definitions exceeds this deployment's declared limit of " + values.max_tool_definitions + ".", "ccdx_api_tool_limit_exceeded", "tools");
  if (values.max_output_tokens && Number.isFinite(body[outputKey]) && body[outputKey] > values.max_output_tokens) {
    result = { ...result, [outputKey]: values.max_output_tokens };applied.push("output_limit");
  }
  const effort = protocol === "responses" ? body.reasoning?.effort : protocol === "messages" ? body.output_config?.effort : body.reasoning_effort;
  if (effort !== undefined && (values.reasoning === false && effort !== "none" || values.reasoning_efforts && !values.reasoning_efforts.includes(effort))) {
    throw Object.assign(new Error("This model does not declare the selected reasoning level. Choose a supported level."), { code: "ccdx_api_effort_unavailable", statusCode: 400 });
  }
  if (values.reasoning === false && body.thinking && body.thinking.type !== "disabled") {
    throw Object.assign(new Error("Reasoning is disabled for this model."), { code: "ccdx_api_reasoning_unavailable", statusCode: 400 });
  }
  if (protocol === "messages" && body.thinking?.type && values.thinking_modes && !values.thinking_modes.includes(body.thinking.type)) {
    throw Object.assign(new Error("This model does not declare the selected thinking mode."), { code: "ccdx_api_thinking_unavailable", statusCode: 400 });
  }
  const budget = body.thinking?.budget_tokens;
  if (Number.isFinite(budget) && (values.reasoning_budget_min && budget < values.reasoning_budget_min || values.reasoning_budget_max && budget > values.reasoning_budget_max
    || applied.includes("output_limit") && Number.isFinite(result.max_tokens) && budget >= result.max_tokens)) {
    throw Object.assign(new Error("Reasoning budget is outside this model's declared limits."), { code: "ccdx_api_reasoning_budget_invalid", statusCode: 400 });
  }
  if (values.tools === false && Array.isArray(body.tools) && body.tools.length) throw Object.assign(new Error("Tool calls are disabled for this model."), { code: "ccdx_api_tools_unavailable", statusCode: 400 });
  return { body: result, applied };
}
