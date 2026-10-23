import fs from "node:fs";
import path from "node:path";
import { userSettingsPath } from "./user-settings.mjs";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { atomicWriteFileSync } from "./atomic-file.mjs";
import { withFileLockSync } from "./lock.mjs";
import { isProviderId } from "./provider-metadata.mjs";
import { CODEX_AUTO_REVIEW_MODEL } from "./models.mjs";

export const CLIENT_IDS = Object.freeze(["codex", "claude_app", "claude_code"]);
export const CLIENT_NAMES = Object.freeze({ codex: "Codex App", claude_app: "Claude App", claude_code: "Claude Code" });
const APIS = ["messages", "responses", "chat"];
const messages = {
  ccdx_client_source_disabled: "This client's CCDX access or selected source is disabled. Review Settings.",
  ccdx_client_credential_required: "The client's local CCDX credential is missing or outdated. Reopen the client after setup.",
  ccdx_conversation_source_changed: "This conversation was observed on another source or key. Start a new conversation.",
  ccdx_conversation_state_invalid: "Conversation source records are unreadable. The existing file was preserved.",
  ccdx_api_model_unavailable: "This model is not configured for the requested API. Review the source's model list.",
  ccdx_api_environment_key_missing: "Set the configured API-key environment variable before starting CCDX.",
  ccdx_api_secret_unavailable: "The system credential store is unavailable. No plaintext fallback was used.",
  ccdx_client_source_mismatch: "Save the source before changing its review model.",
};
export const accessError = (code, statusCode = 400) => {
  const message = messages[code] || code;return Object.assign(new Error(message), { code, statusCode,
    jsonBody: { type: "error", error: { type: statusCode >= 500 ? "api_error" : "invalid_request_error", code, message } } });
};
export function accessSettingsPath(options = {}) { return path.join(path.dirname(userSettingsPath(options)), "connections.json"); }
export function apiUrl(value) {
  let url;try { url = new URL(value); } catch { throw accessError("ccdx_api_url_invalid"); }
  if (typeof value !== "string" || value.length > 2048 || url.protocol !== "https:"
    || url.username || url.password || url.search || url.hash) throw accessError("ccdx_api_url_invalid");
  return url.href;
}
const fields = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const modelId = value => typeof value === "string" && /^[\w][\w./:@+-]{0,159}$/.test(value) && !value.includes("..") && !value.includes("//");
export function checkedApi(value) {
  if (!fields(value, ["id", "name", "enabled", "base_url", "endpoints", "auth_header", "secret_ref", "key_env", "models", "checked_at"])
    || !isProviderId(value.id) || !value.id.startsWith("api_") || typeof value.name !== "string" || !value.name.trim() || value.name.length > 60
    || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value.name) || typeof value.enabled !== "boolean"
    || (value.key_env ? !/^[A-Z][A-Z0-9_]{0,95}$/.test(value.key_env) || value.secret_ref !== undefined : !/^[a-f0-9]{32}$/.test(value.secret_ref || "")) || !["x-api-key", "bearer"].includes(value.auth_header)
    || !fields(value.endpoints, APIS) || !Object.keys(value.endpoints).length
    || !Array.isArray(value.models) || value.models.length > 500) throw accessError("ccdx_api_config_invalid");
  apiUrl(value.base_url);
  const origin = new URL(value.base_url).origin;
  for (const url of Object.values(value.endpoints)) if (new URL(apiUrl(url)).origin !== origin) throw accessError("ccdx_api_origin_mismatch");
  const seen = new Set();
  for (const model of value.models) {
    if (model?.id === CODEX_AUTO_REVIEW_MODEL) throw accessError("ccdx_api_model_reserved");
    if (!fields(model, ["id", "protocols", "context_window", "reasoning_efforts"]) || !modelId(model.id) || seen.has(model.id)
      || !Array.isArray(model.protocols) || !model.protocols.length || new Set(model.protocols).size !== model.protocols.length
      || model.protocols.some(api => !value.endpoints[api])
      || model.context_window !== undefined && (!Number.isSafeInteger(model.context_window) || model.context_window < 1)
      || model.reasoning_efforts !== undefined && (!Array.isArray(model.reasoning_efforts) || model.reasoning_efforts.length > 8
        || model.reasoning_efforts.some(effort => !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)))) throw accessError("ccdx_api_models_invalid");
    seen.add(model.id);
  }
  if (value.checked_at !== undefined && (typeof value.checked_at !== "string" || !Number.isFinite(Date.parse(value.checked_at)))) throw accessError("ccdx_api_config_invalid");
  return value;
}
export function defaultAccessSettings() {
  return { version: 1, claude_private_keys: false, providers: { github: true, m365: true }, apis: [], clients: Object.fromEntries(CLIENT_IDS.map(id => [id,
    { enabled: true, allowed: id === "codex" ? ["github", "m365"] : ["m365"], source: null }])) };
}
export function checkedAccessSettings(value) {
  if (!fields(value, ["version", "claude_private_keys", "providers", "apis", "clients"]) || value.version !== 1 || typeof value.claude_private_keys !== "boolean"
    || !fields(value.providers, ["github", "m365"]) || ["github", "m365"].some(id => typeof value.providers[id] !== "boolean")
    || !Array.isArray(value.apis) || value.apis.length > 16 || !fields(value.clients, CLIENT_IDS)) throw accessError("ccdx_connections_invalid");
  const ids = new Set(["github", "m365"]), names = new Set(["github copilot", "microsoft 365"]);
  for (const api of value.apis) { checkedApi(api);if (ids.has(api.id)) throw accessError("ccdx_connections_invalid");ids.add(api.id);
    const name = api.name.trim().toLowerCase();if (names.has(name)) throw accessError("ccdx_api_name_exists");names.add(name);
  }
  for (const id of CLIENT_IDS) {
    const client = value.clients[id];
    if (!fields(client, ["enabled", "allowed", "source", "model", "auto_review_model", "auto_review_effort", "history_isolation"])
      || typeof client.enabled !== "boolean" || !Array.isArray(client.allowed) || client.allowed.length > 18 || new Set(client.allowed).size !== client.allowed.length
      || client.allowed.some(source => !ids.has(source)) || client.source !== null && !client.allowed.includes(client.source)
      || ["model", "auto_review_model"].some(key => client[key] !== undefined && !modelId(client[key]))
      || client.history_isolation !== undefined && typeof client.history_isolation !== "boolean"
      || client.auto_review_effort !== undefined && client.auto_review_effort !== null && !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(client.auto_review_effort)) throw accessError("ccdx_connections_invalid");
    for (const source of client.allowed) {
      const apis = source === "github" ? ["responses"] : source === "m365" ? ["messages", "responses"] : Object.keys(value.apis.find(api => api.id === source).endpoints);
      if (!apis.includes(id === "codex" ? "responses" : "messages")) throw accessError("ccdx_api_protocol_required");
    }
  }
  return value;
}
export function readAccessSettings(options = {}) {
  try { return checkedAccessSettings(JSON.parse(readBoundedFileSync(accessSettingsPath(options), { maxBytes: 8 * 1024 * 1024, encoding: "utf8" }))); }
  catch (error) { if (error.code === "ENOENT") return defaultAccessSettings();throw accessError("ccdx_connections_invalid", 409); }
}
export function updateAccessSettings(change, options = {}) {
  const file = accessSettingsPath(options);fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withFileLockSync(`${file}.lock`, () => {
    const next = checkedAccessSettings(change(readAccessSettings(options)));
    const text = JSON.stringify(next, null, 2) + "\n";if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw accessError("ccdx_connections_limit", 413);
    atomicWriteFileSync(file, text, { mode: 0o600 });return next;
  });
}
