import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { codexPaths } from "./codex-paths.mjs";
import { accessSettingsPath, accessError } from "./access-settings.mjs";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { atomicWriteFilePairSync } from "./atomic-file.mjs";
import { withFileLockSync } from "./lock.mjs";

const ID = "ccdx_gateway";
function retainsCodexSignIn(config, directory, env) {
  if (["keyring", "auto"].includes(config.cli_auth_credentials_store) || config.forced_login_method
    || config.forced_chatgpt_workspace_id || ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"].some(key => env[key])) return true;
  try {
    const auth = JSON.parse(readBoundedFileSync(path.join(directory, "auth.json"), { encoding: "utf8", maxBytes: 1024 * 1024 }));
    return Boolean(auth?.auth_mode || auth?.tokens || auth?.OPENAI_API_KEY);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw accessError("ccdx_codex_config_invalid", 409);
  }
}
// Only the provider, selected model and private provider table are owned.
export function configureCodexApi({ baseUrl, apiKey, model, restore = false, ...options } = {}) {
  if (!restore) {
    let url;try { url = new URL(baseUrl); } catch { throw accessError("ccdx_codex_config_invalid"); }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/v1" || url.username || url.password || url.search || url.hash
      || !/^[a-f0-9]{64}$/.test(apiKey)) throw accessError("ccdx_codex_config_invalid");
  }
  const file = codexPaths(options).config, journal = path.join(path.dirname(accessSettingsPath(options)), "codex-gateway-owner.json");
  if (restore && !fs.existsSync(journal)) return { state: "unchanged" };
  fs.mkdirSync(path.dirname(journal), { recursive: true, mode: 0o700 });fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withFileLockSync(`${journal}.lock`, () => {
    let content = "", owner = null;
    try { content = readBoundedFileSync(file, { encoding: "utf8", maxBytes: 1024 * 1024 }); } catch (error) { if (error.code !== "ENOENT") throw accessError("ccdx_codex_config_invalid", 409); }
    try { owner = JSON.parse(readBoundedFileSync(journal, { encoding: "utf8", maxBytes: 16384 })); } catch (error) { if (error.code !== "ENOENT") throw accessError("ccdx_codex_config_invalid", 409); }
    let config;try { config = parse(content); } catch { throw accessError("ccdx_codex_config_invalid", 409); }
    if (owner && (owner.version !== 1 || typeof owner.section !== "string" || !Object.hasOwn(owner, "beforeProvider") || !Object.hasOwn(owner, "beforeSection"))) throw accessError("ccdx_codex_config_invalid", 409);
    const firstTable = content.search(/^\s*\[/m), head = firstTable < 0 ? content : content.slice(0, firstTable), tail = firstTable < 0 ? "" : content.slice(firstTable);
    const sectionPattern = /^\[model_providers\.ccdx_gateway\]\r?\n[^]*?(?=^\[|$(?![^]))/m;
    const currentSection = tail.match(sectionPattern)?.[0] || null;
    if (owner && (config.model_provider !== ID || currentSection !== owner.section)) return { state: "preserved" };
    const modelEdited = owner?.model !== undefined && config.model !== owner.model;
    if (restore && modelEdited) return { state: "preserved" };
    if (!owner && (config.model_provider && config.model_provider !== "openai" || config.model_providers?.[ID])) return { state: "preserved" };
    let next, nextOwner = null;
    if (restore) {
      if (!owner) return { state: "unchanged" };
      let root = head.replace(/^model_provider\s*=.*(?:\r?\n|$)/m, owner.beforeProvider || "");
      if (owner.model !== undefined) root = root.replace(/^model\s*=.*(?:\r?\n|$)/m, owner.beforeModel || "");
      next = root + tail.replace(sectionPattern, owner.beforeSection || "");
    } else {
      // Account identity remains native; only model traffic uses the local key.
      const requiresAuth = retainsCodexSignIn(config, path.dirname(file), options.env || process.env);
      const section = `[model_providers.${ID}]\nname = "CCDX"\nbase_url = ${JSON.stringify(baseUrl)}\nmodel_catalog_url = ${JSON.stringify(baseUrl + "/models")}\nwire_api = "responses"\nrequires_openai_auth = ${requiresAuth}\nexperimental_bearer_token = ${JSON.stringify(apiKey)}\n\n`;
      let root = head;
      if (model && !modelEdited) root = root.match(/^model\s*=/m) ? root.replace(/^model\s*=.*(?:\r?\n|$)/m, `model = ${JSON.stringify(model)}\n`) : `model = ${JSON.stringify(model)}\n` + root;
      next = (root.match(/^model_provider\s*=/m) ? root.replace(/^model_provider\s*=.*(?:\r?\n|$)/m, `model_provider = "${ID}"\n`) : `model_provider = "${ID}"\n` + root)
        + (currentSection ? tail.replace(sectionPattern, section) : tail + (tail && !tail.endsWith("\n") ? "\n" : "") + "\n" + section);
      nextOwner = { version: 1, beforeProvider: owner ? owner.beforeProvider : head.match(/^model_provider\s*=.*(?:\r?\n|$)/m)?.[0] || null,
        beforeSection: owner ? owner.beforeSection : currentSection, section,
        ...(modelEdited ? { model: owner.model, beforeModel: owner.beforeModel }
          : model ? { model, beforeModel: owner && Object.hasOwn(owner, "beforeModel") ? owner.beforeModel : head.match(/^model\s*=.*(?:\r?\n|$)/m)?.[0] || null } : {}) };
    }
    parse(next);if (next !== content || JSON.stringify(nextOwner) !== JSON.stringify(owner)) atomicWriteFilePairSync(file, next, journal, nextOwner ? JSON.stringify(nextOwner) + "\n" : null, { mode: 0o600 });
    return { state: modelEdited ? "preserved" : "configured", changed: next !== content };
  });
}
