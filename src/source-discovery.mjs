import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readBoundedFile } from "./bounded-file.mjs";
import { parseCodexToml } from "./config-toml.mjs";
import { previewSourceImport } from "./source-import.mjs";

const execute = promisify(execFile), pending = new Map(), tools = ["cc-switch", "magpie"];
const failure = () => new Error("ccdx_import_discovery_invalid");
const result = (tool, state) => ({ format: tool, saved: false, drafts: [], discovery: { tool, state, skipped: 0, truncated: false } });
const joinEndpoint = (base, protocol) => {
  if (typeof base !== "string") throw failure();
  const value = base.trim().replace(/\/+$/, ""), suffix = { messages: "messages", responses: "responses", chat: "chat/completions" }[protocol];
  if (value.endsWith("/" + suffix)) return value;
  return value + (value.endsWith("/v1") ? "/" : "/v1/") + suffix;
};

// Foreign credentials and executable settings never enter the returned draft.
export function discoveredProviderConfig(tool, row) {
  if (tool === "magpie") {
    if (row.forgot === true) return null;
    const endpoints = Object.fromEntries(Object.entries({ messages: row.anthropic, responses: row.responses, chat: row.chat })
      .filter(([, base]) => typeof base === "string" && base.trim()).map(([protocol, base]) => [protocol, joinEndpoint(base, protocol)]));
    if (!Object.keys(endpoints).length) return null;
    return { name: row.name, base_url: row.responses || row.chat || row.anthropic, endpoints,
      auth_header: row.authHeader === "x-api-key" ? "x-api-key" : "bearer", models: [] };
  }
  const settings = row.settings, meta = row.meta || {};
  if (!settings || ["codex_oauth", "xai_oauth"].includes(meta.providerType || meta.provider_type)) return null;
  if (row.app_type === "codex") {
    if (typeof settings.config !== "string") return null;
    const config = parseCodexToml(settings.config), provider = config.model_providers?.[config.model_provider];
    const protocol = { responses: "responses", chat: "chat" }[provider?.wire_api];
    if (!protocol || typeof provider.base_url !== "string") return null;
    return { name: row.name, base_url: provider.base_url, endpoints: { [protocol]: joinEndpoint(provider.base_url, protocol) }, auth_header: "bearer", models: [] };
  }
  if (!["claude", "claude-desktop"].includes(row.app_type)) return null;
  const legacyChat = [true, 1, "true", "1"].includes(settings.openrouter_compat_mode);
  const declared = meta.apiFormat ?? settings.api_format ?? (legacyChat ? "openai_chat" : "anthropic");
  const protocol = { anthropic: "messages", openai_chat: "chat", openai_responses: "responses" }[declared];
  const base = settings.env?.ANTHROPIC_BASE_URL;
  if (!protocol || typeof base !== "string") return null;
  const keyField = meta.apiKeyField ?? (Object.hasOwn(settings.env, "ANTHROPIC_AUTH_TOKEN") ? "ANTHROPIC_AUTH_TOKEN"
    : Object.hasOwn(settings.env, "ANTHROPIC_API_KEY") ? "ANTHROPIC_API_KEY" : undefined);
  return { name: row.name, base_url: base, endpoints: { [protocol]: joinEndpoint(base, protocol) },
    auth_header: protocol === "messages" && keyField === "ANTHROPIC_API_KEY" ? "x-api-key" : "bearer", models: [] };
}

export function previewDiscoveredProviders(tool, rows, { truncated = false } = {}) {
  const value = result(tool, "ready"), seen = new Set();value.discovery.truncated = truncated;
  for (const row of rows) {
    try {
      const config = discoveredProviderConfig(tool, row);
      if (!config) { value.discovery.skipped++;continue; }
      const draft = previewSourceImport({ config }).drafts[0];
      const identity = JSON.stringify([row.app_type || "", row.id || "", config.name, config.endpoints]);
      if (seen.has(identity)) continue;seen.add(identity);
      if (value.drafts.length === 16) { value.discovery.truncated = true;continue; }
      if (tool === "magpie") {
        if (row.anthropic && !["x-api-key", "bearer"].includes(row.authHeader)) draft.warnings.push("auth_header_review");
        if (row.keys?.length || row.keyProtocol || row.groups || row.routing) draft.warnings.push("account_routing_omitted");
      }
      draft.number = value.drafts.length + 1;draft.warnings.push("model_protocols_review");value.drafts.push(draft);
    } catch { value.discovery.skipped++; }
  }
  if (!value.drafts.length) value.discovery.state = "empty";
  return value;
}

export async function sourceImportLocation(tool, { home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  if (!tools.includes(tool)) throw failure();
  if (tool === "magpie") return path.join(path.isAbsolute(env.XDG_CONFIG_HOME || "") ? env.XDG_CONFIG_HOME : path.join(home, ".config"), "magpie", "providers.json");
  const data = platform === "win32" ? env.APPDATA || path.join(home, "AppData/Roaming")
    : platform === "darwin" ? path.join(home, "Library/Application Support") : env.XDG_DATA_HOME || path.join(home, ".local/share");
  let directory = path.join(home, ".cc-switch");
  try {
    const config = JSON.parse(await readBoundedFile(path.join(data, "com.ccswitch.desktop/app_paths.json"), { encoding: "utf8", maxBytes: 65536 }));
    let target = config.app_config_dir_override;
    if (typeof target === "string" && (target = target.trim())) {
      if (target === "~") target = home;
      else if (/^~[/\\]/.test(target)) target = path.join(home, target.slice(2));
      if (path.isAbsolute(target) && (await fs.stat(target).catch(() => null))?.isDirectory()) directory = target;
    }
  } catch (error) { if (error.code !== "ENOENT") throw failure(); }
  let file = path.join(directory, "cc-switch.db");
  if (platform === "win32" && directory === path.join(home, ".cc-switch") && env.HOME && path.isAbsolute(env.HOME)
    && !await fs.stat(file).catch(() => null)) file = path.join(env.HOME, ".cc-switch/cc-switch.db");
  return file;
}

export async function discoverSourceImport(tool, options = {}, existing = []) {
  if (!tools.includes(tool)) throw failure();
  let file;try { file = await sourceImportLocation(tool, options); } catch { return result(tool, "unreadable"); }
  const key = tool + "\0" + file;
  if (!pending.has(key)) {
    if (pending.size >= 2) return result(tool, "busy");
    const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    const operation = execute(process.execPath, [fileURLToPath(new URL("./source-discovery-probe.mjs", import.meta.url)), tool, file],
      { env, encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 512 * 1024 }).then(({ stdout }) => JSON.parse(stdout))
      .catch(() => result(tool, "unreadable")).finally(() => pending.delete(key));
    pending.set(key, operation);
  }
  const value = structuredClone(await pending.get(key));
  for (const draft of value.drafts) {
    if (existing.some(source => source.name?.trim().toLowerCase() === draft.config.name.trim().toLowerCase())) draft.warnings.push("name_exists");
    if (existing.some(source => source.base_url === draft.config.base_url)) draft.warnings.push("endpoint_exists");
  }
  return value;
}
