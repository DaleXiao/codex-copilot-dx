import fs from "node:fs";
import path from "node:path";
import { codexTomlStatements, parseCodexToml, validateManagedConfigEdit } from "./config-toml.mjs";
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
function validateOwner(owner) {
  if (owner && (![1, 2].includes(owner.version) || !Object.hasOwn(owner, "beforeProvider") || !Object.hasOwn(owner, "beforeSection")
      || owner.version === 1 && typeof owner.section !== "string"
      || owner.version === 2 && (!["openai", "gateway"].includes(owner.mode) || owner.mode === "gateway" && typeof owner.section !== "string"
        || owner.mode === "openai" && owner.section !== null && typeof owner.section !== "string"))) throw accessError("ccdx_codex_config_invalid", 409);
}
export function codexBaseUrlManaged(options = {}) {
  if (options.filePath && path.resolve(options.filePath) !== codexPaths(options).config) return false;
  const journal = path.join(path.dirname(accessSettingsPath(options)), "codex-gateway-owner.json");
  try {
    const owner = JSON.parse(readBoundedFileSync(journal, { encoding: "utf8", maxBytes: 16384 }));validateOwner(owner);
    return owner?.version === 2 && Object.hasOwn(owner, "base");
  } catch (error) { if (error.code === "ENOENT") return false;throw accessError("ccdx_codex_config_invalid", 409); }
}

// Retain exact declarations for restoration; the scanner handles quoted keys,
// comments and multiline values without serializing unrelated TOML.
function rootDeclaration(content, key) {
  const item = codexTomlStatements(content).find(item => item.kind === "value" && !item.section.length && item.keys.length === 1 && item.keys[0] === key);
  if (!item) return null;
  const start = content.lastIndexOf("\n", item.start - 1) + 1, newline = content.indexOf("\n", item.valueEnd), end = newline < 0 ? content.length : newline + 1;
  return { start, end, text: content.slice(start, end) };
}
function replaceRoot(content, key, text) {
  const item = rootDeclaration(content, key);
  return item ? content.slice(0, item.start) + (text || "") + (text && !text.endsWith("\n") && item.end < content.length ? "\n" : "") + content.slice(item.end) : (text || "") + content;
}

// Retire only the complete, recognized qualified-ID cache from the old native
// route. Its bytes remain available for rollback; unknown caches are untouched.
function retireQualifiedCache(models, options) {
  if (!Array.isArray(models) || !models.length) return () => {};
  const aliases = new Set(models.filter(model => model.public_id !== model.route_id && /^ccdx\/model-\d+$/.test(model.route_id)).map(model => model.route_id));
  if (aliases.size !== models.length) return () => {};
  const file = path.join(codexPaths(options).directory, "models_cache.json"), backup = file + ".ccdx-qualified.bak";
  let bytes, cache;
  try { bytes = readBoundedFileSync(file, { maxBytes: 8 * 1024 * 1024 });cache = JSON.parse(bytes.toString("utf8")); }
  catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return () => {};throw accessError("ccdx_codex_catalog_cache_unavailable", 409); }
  if (!Array.isArray(cache.models) || cache.models.length !== aliases.size || !cache.models.every(model => typeof model?.slug === "string" && aliases.has(model.slug))
    || new Set(cache.models.map(model => model.slug)).size !== aliases.size) return () => {};
  try {
    if (fs.existsSync(backup) && !readBoundedFileSync(backup, { maxBytes: 8 * 1024 * 1024 }).equals(bytes)) throw Error("cache_backup_conflict");
    if (!readBoundedFileSync(file, { maxBytes: 8 * 1024 * 1024 }).equals(bytes)) throw Error("cache_changed");
    fs.renameSync(file, backup);fs.chmodSync(backup, 0o600);
  } catch { throw accessError("ccdx_codex_catalog_cache_unavailable", 409); }
  return () => { if (!fs.existsSync(file)) fs.renameSync(backup, file); };
}

// GitHub-only traffic retains the built-in OpenAI provider. Private API traffic
// keeps its own provider and local key. Both routes share one ownership journal.
export function configureCodexApi({ baseUrl, apiKey, model, native = false, nativeModels, restore = false, ...options } = {}) {
  if (!restore) {
    let url;try { url = new URL(baseUrl); } catch { throw accessError("ccdx_codex_config_invalid"); }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/v1" || url.username || url.password || url.search || url.hash
      || !native && !/^[a-f0-9]{64}$/.test(apiKey)) throw accessError("ccdx_codex_config_invalid");
  }
  const file = codexPaths(options).config, journal = path.join(path.dirname(accessSettingsPath(options)), "codex-gateway-owner.json");
  if (restore && !fs.existsSync(journal)) return { state: "unchanged" };
  fs.mkdirSync(path.dirname(journal), { recursive: true, mode: 0o700 });fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withFileLockSync(`${file}.ccdx.lock`, () => withFileLockSync(`${journal}.lock`, () => {
    let content = "", owner = null;
    try { content = readBoundedFileSync(file, { encoding: "utf8", maxBytes: 1024 * 1024 }); } catch (error) { if (error.code !== "ENOENT") throw accessError("ccdx_codex_config_invalid", 409); }
    try { owner = JSON.parse(readBoundedFileSync(journal, { encoding: "utf8", maxBytes: 16384 })); } catch (error) { if (error.code !== "ENOENT") throw accessError("ccdx_codex_config_invalid", 409); }
    let config;try { config = parseCodexToml(content); } catch { throw accessError("ccdx_codex_config_invalid", 409); }
    validateOwner(owner);
    const table = codexTomlStatements(content).find(item => item.kind === "table"), firstTable = table ? content.lastIndexOf("\n", table.start - 1) + 1 : -1;
    const head = firstTable < 0 ? content : content.slice(0, firstTable), tail = firstTable < 0 ? "" : content.slice(firstTable);
    const sectionPattern = /^\[model_providers\.ccdx_gateway\]\r?\n[^]*?(?=^\[|$(?![^]))/m;
    const currentSection = tail.match(sectionPattern)?.[0] || null;
    const nativeOwner = owner?.mode === "openai", openaiProvider = !config.model_provider || config.model_provider === "openai";
    if (owner && (currentSection !== owner.section || (nativeOwner ? !openaiProvider : config.model_provider !== ID && !(native && openaiProvider)))) return { state: "preserved" };
    if (owner && Object.hasOwn(owner, "base") && rootDeclaration(head, "openai_base_url")?.text !== owner.base) return { state: "preserved" };
    const modelEdited = owner?.model !== undefined && config.model !== owner.model;
    if (restore && modelEdited) return { state: "preserved" };
    if (!owner && (!openaiProvider || config.model_providers?.[ID])) return { state: "preserved" };
    const beforeProvider = owner ? owner.beforeProvider : rootDeclaration(head, "model_provider")?.text || null;
    const beforeSection = owner ? owner.beforeSection : currentSection;
    let next, nextOwner = null;
    if (restore) {
      if (!owner) return { state: "unchanged" };
      let root = replaceRoot(head, "model_provider", beforeProvider);
      if (owner.model !== undefined) root = replaceRoot(root, "model", owner.beforeModel);
      if (Object.hasOwn(owner, "base")) root = replaceRoot(root, "openai_base_url", owner.beforeBase);
      next = root + (currentSection ? tail.replace(sectionPattern, beforeSection || "") : tail);
    } else {
      let root = head, section;
      if (model && !modelEdited) root = replaceRoot(root, "model", `model = ${JSON.stringify(model)}\n`);
      if (native) {
        root = replaceRoot(root, "model_provider", beforeProvider);
        root = replaceRoot(root, "openai_base_url", `openai_base_url = ${JSON.stringify(baseUrl)}\n`);
        // Existing sessions retain their provider ID. Keep its unchanged table
        // inactive so they can resume; fresh native installs create no table.
        section = currentSection;
        next = root + tail;
      } else {
        const requiresAuth = retainsCodexSignIn(config, path.dirname(file), options.env || process.env);
        section = `[model_providers.${ID}]\nname = "CCDX"\nbase_url = ${JSON.stringify(baseUrl)}\nmodel_catalog_url = ${JSON.stringify(baseUrl + "/models")}\nwire_api = "responses"\nrequires_openai_auth = ${requiresAuth}\nexperimental_bearer_token = ${JSON.stringify(apiKey)}\n\n`;
        root = replaceRoot(root, "model_provider", `model_provider = "${ID}"\n`);
        next = root + (currentSection ? tail.replace(sectionPattern, section) : tail + (tail && !tail.endsWith("\n") ? "\n" : "") + "\n" + section);
      }
      nextOwner = { version: 2, mode: native ? "openai" : "gateway", beforeProvider, beforeSection, section,
        ...(native || owner && Object.hasOwn(owner, "base") ? { beforeBase: owner && Object.hasOwn(owner, "beforeBase") ? owner.beforeBase : rootDeclaration(head, "openai_base_url")?.text || null,
          base: native ? `openai_base_url = ${JSON.stringify(baseUrl)}\n` : owner.base } : {}),
        ...(modelEdited || !model && owner?.model !== undefined ? { model: owner.model, beforeModel: owner.beforeModel }
          : model ? { model, beforeModel: owner && Object.hasOwn(owner, "beforeModel") ? owner.beforeModel : rootDeclaration(head, "model")?.text || null } : {}) };
    }
    try { validateManagedConfigEdit(config, next, [["model"], ["model_provider"], ["model_providers", ID], ["openai_base_url"]]); }
    catch { throw accessError("ccdx_codex_config_invalid", 409); }
    const undoCache = native && !restore ? retireQualifiedCache(nativeModels, options) : () => {};
    try { if (next !== content || JSON.stringify(nextOwner) !== JSON.stringify(owner)) atomicWriteFilePairSync(file, next, journal, nextOwner ? JSON.stringify(nextOwner) + "\n" : null, { mode: 0o600 }); }
    catch (error) { undoCache();throw error; }
    return { state: modelEdited ? "preserved" : "configured", changed: next !== content };
  }));
}
