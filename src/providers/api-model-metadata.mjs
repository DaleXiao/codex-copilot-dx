import { catalogCapabilities, validCapabilities } from "../model-capabilities.mjs";

// Interpret the catalog's declared schema, never the model's name. Anthropic
// fields describe Messages; a gateway exposing other APIs must declare those
// separately. No inference request is used to fill missing information.
export function apiModelMetadata(model, { deployment, checked_at }) {
  const values = catalogCapabilities(model), caps = model.capabilities || {}, messages = {};
  const anthropic = model.type === "model" && Object.hasOwn(model, "max_tokens") || typeof caps.thinking?.supported === "boolean" || typeof caps.effort?.supported === "boolean";
  if (anthropic) {
    const put = (key, value) => { if (value !== undefined && validCapabilities({ [key]: value })) messages[key] = value; };
    put("context_window", model.max_input_tokens);
    put("max_input_tokens", model.max_input_tokens);
    put("max_output_tokens", model.max_tokens);
    put("reasoning", caps.effort?.supported === true ? true : caps.thinking?.supported);
    if (caps.thinking?.supported === false) put("thinking_modes", ["disabled"]);
    else if (caps.thinking?.supported === true && caps.thinking.types) put("thinking_modes", ["disabled", "enabled", "adaptive", "between_tools"].filter(mode => caps.thinking.types[mode]?.supported === true));
    put("reasoning_adaptive", caps.thinking?.types?.adaptive?.supported);
    if (caps.effort?.supported === false) put("reasoning_efforts", []);
    else if (caps.effort?.supported === true) {
      const efforts = ["low", "medium", "high", "xhigh", "max"].filter(level => caps.effort[level]?.supported === true);
      if (efforts.length) put("reasoning_efforts", efforts);
    }
    if (messages.reasoning_efforts?.length || messages.reasoning !== undefined) put("reasoning_format", "messages");
    put("structured_output", caps.structured_outputs?.supported);
    if (typeof caps.server_tools?.web_search?.supported === "boolean") put("web_search", caps.server_tools.web_search.supported ? ["messages"] : []);
    // Image/PDF flags do not establish support for arbitrary files or audio.
    if (caps.image_input?.supported === true) put("input_modalities", ["text", "image"]);
    // Native input/output limits must not leak to another gateway API.
    delete values.max_input_tokens;
  }
  const protocols = Object.keys(messages).length ? { messages } : {};
  const reported = Object.keys(values).length || Object.keys(protocols).length;
  const described = Object.keys(caps).length || ["max_tokens", "max_input_tokens", "max_output_tokens", "context_window", "reasoning_efforts"].some(key => Object.hasOwn(model, key));
  return { values, ...(Object.keys(protocols).length ? { protocols } : {}), deployment, checked_at,
    state: reported ? "reported" : described ? "unrecognized" : "missing" };
}
