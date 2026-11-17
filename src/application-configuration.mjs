import { createHash } from "node:crypto";
import { claudeClientPaths, M365_CLAUDE_PROFILE_ID } from "./claude-client-config.mjs";
import { codexPaths } from "./codex-paths.mjs";
import { parseCodexToml } from "./config-toml.mjs";
import { readBoundedFile } from "./bounded-file.mjs";
import { userSettingsPath } from "./user-settings.mjs";

const read = async file => JSON.parse(await readBoundedFile(file, { maxBytes: 1024 * 1024, encoding: "utf8" }));
const sameUrl = (actual, expected) => { try { return new URL(actual).href.replace(/\/$/, "") === new URL(expected).href.replace(/\/$/, ""); } catch { return false; } };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

// Inspect only integration fields; fingerprints stay in process memory.
export async function inspectApplicationConfiguration(id, { port = 2026, host = "127.0.0.1", ...options } = {}) {
  let value, state;
  try {
    if (id === "claude_app") {
      const paths = claudeClientPaths(options), [profile, meta, mode] = await Promise.all([read(paths.profile), read(paths.meta), read(paths.threep).catch(error => { if (error.code === "ENOENT") return {};throw error; })]);
      value = { provider: profile.inferenceProvider, address: profile.inferenceGatewayBaseUrl, key: profile.inferenceGatewayApiKey,
        models: typeof profile.inferenceModels === "string" ? JSON.parse(profile.inferenceModels) : profile.inferenceModels,
        discovery: profile.modelDiscoveryEnabled, profile: meta.appliedId, hybrid: meta.hybridPointer,
        mode: profile.disableDeploymentModeChooser === true || mode.deploymentMode !== "1p" ? "3p" : "1p" };
      state = value.provider === "gateway" && value.profile === M365_CLAUDE_PROFILE_ID && !value.hybrid && value.mode === "3p" && typeof value.key === "string" && Boolean(value.key)
        && sameUrl(value.address, `http://${host}:${port}/anthropic`) ? "configured" : "preserved";
    } else if (id === "codex") {
      const file = codexPaths(options).config;
      const config = parseCodexToml(await readBoundedFile(file, { maxBytes: 2 * 1024 * 1024, encoding: "utf8" }));
      value = { provider: config.model_provider, address: config.openai_base_url, models: config.model_catalog_json, gateway: config.model_providers?.ccdx_gateway,
        model: config.model };
      state = ((!value.provider || value.provider === "openai") && sameUrl(value.address, `http://${host}:${port}/v1`))
        || (value.provider === "ccdx_gateway" && sameUrl(value.gateway?.base_url, `http://${host}:${port}/v1`)) ? "configured" : "preserved";
    } else {
      let settings;try { settings = await read(userSettingsPath(options)); } catch (error) { if (error.code !== "ENOENT") throw error;settings = {}; }
      value = { enabled: settings.gemini_antigravity_enabled === true, models: settings.gemini_antigravity_models || null, port, host };
      state = value.enabled ? "configured" : "native";
    }
    const reload = { ...value };delete reload.key;
    return { state, revision: digest(value), reloadRevision: digest(reload) };
  } catch (error) {
    return { state: error.code === "ENOENT" ? "not_configured" : "unavailable", revision: "unknown" };
  }
}
