import fs from "node:fs";
import os from "node:os";
import { codexPaths } from "./codex-paths.mjs";
import { withFileLockSync } from "./lock.mjs";
import { atomicWriteFileIfChangedSync, atomicWriteFilePairSync } from "./atomic-file.mjs";
import { computeImageMcpCodexConfig } from "./config.mjs";
import { updateImageSkill } from "./image-skill.mjs";
import { servicePreferences, writeServicePreference } from "./user-settings.mjs";
import { imageProviderConfigPath, inspectImageProvider, normalizeImageEndpoint, readImageProviderConfig, validateImageProviderConfig } from "./image-provider-config.mjs";
export function fileContent(filePath) {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(filePath)); }
  catch (error) {
    if (error?.code === "ENOENT") return "";
    if (error?.code === "ERR_ENCODING_INVALID_ENCODED_DATA") {
      throw new Error("Codex configuration is not valid UTF-8 TOML; no configuration changes were written");
    }
    throw error;
  }
}

export function enableImageProvider(options) {
  return withFileLockSync(`${options.codexPath}.ccdx.lock`, () => enableImageProviderUnlocked(options));
}
function enableImageProviderUnlocked({ providerConfig, providerPath, codexPath, codexContent, adapterPort, adapterHost }) {
  const codex = computeImageMcpCodexConfig(codexContent, {
    enabled: true,
    adapterPort,
    adapterHost,
  });
  const normalized = validateImageProviderConfig(providerConfig, { filePath: providerPath });
  const skill = updateImageSkill({ enabled: true, codexPath, adapterPort, adapterHost });
  try {
    if (fileContent(codexPath) !== codexContent) {
      throw new Error("Codex configuration changed during image setup; retry to preserve the newer settings");
    }
    atomicWriteFilePairSync(
      codexPath,
      codex.content,
      providerPath,
      `${JSON.stringify(normalized, null, 2)}\n`,
      { mode: 0o600, writeFile: atomicWriteFileIfChangedSync },
    );
  } catch (error) {
    skill.rollback();
    throw error;
  }
  return { codexChanged: codex.changed, config: normalized };
}

export function disableImageProvider(options) {
  if (!fs.existsSync(options.codexPath)) return disableImageProviderUnlocked(options);
  return withFileLockSync(`${options.codexPath}.ccdx.lock`, () => disableImageProviderUnlocked(options));
}
function disableImageProviderUnlocked({ providerPath, codexPath, codexContent, adapterPort, adapterHost }) {
  const codex = computeImageMcpCodexConfig(codexContent, {
    enabled: false,
    adapterPort,
    adapterHost,
  });
  const providerExists = fs.existsSync(providerPath);
  const skill = updateImageSkill({ enabled: false, codexPath, adapterPort, adapterHost });
  try {
    if (fs.existsSync(codexPath)) {
      if (fileContent(codexPath) !== codexContent) {
        throw new Error("Codex configuration changed during image cleanup; retry to preserve the newer settings");
      }
      atomicWriteFilePairSync(codexPath, codex.content, providerPath, null, {
        mode: 0o600, writeFile: atomicWriteFileIfChangedSync,
      });
    } else if (providerExists) {
      fs.unlinkSync(providerPath);
    }
  } catch (error) {
    skill.rollback();
    throw error;
  }
  return { changed: providerExists || codex.changed || skill.changed, preservedGuidance: Boolean(skill.preserved) };
}

export function syncEnabledImageSkill({ home = os.homedir(), env = process.env, codexPath = codexPaths({ env, home }).config, ...options } = {}) {
  return updateImageSkill({ ...options, enabled: true, codexPath });
}


export function imageSetupSummary(options = {}) {
  const value = readImageProviderConfig({ ...options, strict: true });
  if (!value) return { configured: false };
  const endpoint = new URL(value.endpoint);
  return { configured: true, endpoint: endpoint.origin + endpoint.pathname, model: value.model, protocol: value.protocol };
}

export async function configureImageSetup({ operation, endpoint, key, model }, options = {}) {
  const { env = process.env, home = os.homedir(), adapterPort = 2026, adapterHost = "127.0.0.1", fetchImpl = fetch } = options;
  const codexPath = codexPaths({ env, home }).config, providerPath = imageProviderConfigPath({ env, home });
  if (operation === "remove") return { configured: false, ...disableImageProvider({ providerPath, codexPath, codexContent: fileContent(codexPath), adapterPort, adapterHost }) };
  if (!["inspect", "setup"].includes(operation)) throw new Error("Choose image inspect, setup or remove");
  const current = readImageProviderConfig({ env, home, strict: true });
  const normalized = normalizeImageEndpoint(endpoint || current?.endpoint);
  const sameOrigin = current && new URL(normalized).origin === new URL(current.endpoint).origin;
  const apiKey = String(key || "").trim() || (sameOrigin ? current.api_key : "");
  if (!apiKey) throw new Error("Enter an image API key for this address");
  const inspected = await inspectImageProvider({ endpoint: normalized, apiKey, fetchImpl,
    selectModel: ids => model || (ids.includes(current?.model) ? current.model : ids[0]) });
  if (operation === "inspect") return { endpoint: inspected.endpoint, models: inspected.modelIds, protocol: inspected.protocol };
  if (!model || !inspected.modelIds.includes(model)) throw new Error("Choose a listed image model");
  enableImageProvider({ providerPath, codexPath, codexContent: fileContent(codexPath), adapterPort, adapterHost,
    providerConfig: { endpoint: inspected.endpoint, api_key: apiKey, model, protocol: inspected.protocol } });
  if (!servicePreferences({ env, home }).image_enabled) writeServicePreference("image_enabled", true, { env, home });
  return imageSetupSummary({ env, home });
}
