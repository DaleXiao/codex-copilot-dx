import { checkedApi, CLIENT_IDS } from "./access-settings.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";

const object = value => value && typeof value === "object" && !Array.isArray(value);
const metadata = config => Object.fromEntries(["name", "base_url", "endpoints", "auth_header", "models", "key_env"].filter(key => config[key] !== undefined).map(key => [key, config[key]]));
const routes = { messages: "messages", responses: "responses", chat: "chat/completions" };
const append = (base, route) => base.replace(/\/+$/, "") + "/" + route;

// Only an explicitly supplied JSON file is interpreted. Credential values,
// tool permissions, commands, cached evidence and foreign route IDs stay out.
export function previewSourceImport(value, existing = []) {
  if (!object(value) && !Array.isArray(value)) throw new Error("ccdx_import_format_invalid");
  let format, entries;
  if (object(value.config) && value.config.base_url) { format = "ccdx";entries = [value.config]; }
  else if (Array.isArray(value.apis)) { format = "ccdx";entries = value.apis; }
  else if (object(value.settingsConfig)) { format = "cc-switch";entries = [value]; }
  else if (Array.isArray(value.providers) && value.providers.some(row => row?.anthropic || row?.responses || row?.chat)) { format = "magpie";entries = value.providers; }
  else if (object(value.providers) && Object.values(value.providers).every(row => object(row?.settingsConfig))) { format = "cc-switch";entries = Object.values(value.providers); }
  else throw new Error("ccdx_import_format_invalid");
  if (!entries.length || entries.length > 16) throw new Error("ccdx_import_size_invalid");
  const drafts = entries.map((entry, index) => {
    const warnings = [];let config;
    if (!object(entry)) throw new Error("ccdx_import_format_invalid");
    if (format === "ccdx") {
      config = metadata(entry);
      config.models = (config.models || []).map(model => Object.fromEntries(["id", "protocols", "context_window", "reasoning_efforts", "capabilities"].filter(key => model[key] !== undefined).map(key => [key, model[key]])));
      if (entry.models?.some(model => model.metadata)) warnings.push("catalog_evidence_omitted");
    } else if (format === "cc-switch") {
      const env = entry.settingsConfig.env;
      if (!object(env) || typeof env.ANTHROPIC_BASE_URL !== "string") throw new Error("ccdx_import_format_invalid");
      const base = env.ANTHROPIC_BASE_URL;
      config = { name: entry.name, base_url: base, endpoints: { messages: append(base, "v1/messages") }, auth_header: entry.meta?.apiKeyField === "ANTHROPIC_API_KEY" ? "x-api-key" : "bearer", models: [] };
      warnings.push("model_protocols_review");
    } else {
      const endpoints = Object.fromEntries(Object.entries({ messages: entry.anthropic, responses: entry.responses, chat: entry.chat }).filter(([, base]) => base).map(([protocol, base]) => [protocol, append(base, protocol === "messages" ? "v1/messages" : routes[protocol])]));
      config = { name: entry.name, base_url: Object.values({ responses: entry.responses, chat: entry.chat, messages: entry.anthropic }).find(Boolean), endpoints, auth_header: entry.authHeader === "x-api-key" ? "x-api-key" : "bearer", models: [] };
      if (entry.anthropic && !["x-api-key", "bearer"].includes(entry.authHeader)) warnings.push("auth_header_review");
      if (entry.models?.length) warnings.push("model_protocols_review");
      if (entry.keys?.length || entry.keyProtocol || entry.groups || entry.routing) warnings.push("account_routing_omitted");
    }
    const allowed = format === "ccdx" && Array.isArray(value.allowed) ? value.allowed.filter(id => CLIENT_IDS.includes(id)) : [];
    checkedApi({ ...config, id: "api_import", enabled: true, ...(config.key_env ? {} : { secret_ref: "0".repeat(32) }) });
    if (redactDiagnosticText(config.name) !== config.name || redactDiagnosticText(config.base_url) !== config.base_url) throw new Error("ccdx_import_metadata_invalid");
    if (Object.values(config.endpoints).some(url => redactDiagnosticText(url) !== url) || config.models.some(model => redactDiagnosticText(model.id) !== model.id)) throw new Error("ccdx_import_metadata_invalid");
    if (config.models.some(model => /^(?:ccdx\/|mythos-ccdx-)/.test(model.id))) throw new Error("ccdx_import_route_invalid");
    if (existing.some(source => source.name?.trim().toLowerCase() === config.name.trim().toLowerCase())) warnings.push("name_exists");
    if (existing.some(source => source.base_url === config.base_url)) warnings.push("endpoint_exists");
    return { number: index + 1, config, requested_access: allowed, allowed: [], warnings, credential: config.key_env ? "environment" : "private_input_required" };
  });
  return { format, saved: false, drafts };
}
