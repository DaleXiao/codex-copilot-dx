import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { atomicWriteFileSync } from "./atomic-file.mjs";
import { withFileLockSync } from "./lock.mjs";
import { m365Paths, readM365Json, writeM365Json } from "./m365-settings.mjs";
import { claudeClientModelId, claudeModelEntries } from "./claude-models.mjs";

export const M365_CLAUDE_PROFILE_ID = "00000000-0000-4000-8000-000000202700";
const M365_CLAUDE_PROFILE_NAME = "CCDX Microsoft 365";

export function claudeClientPaths({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const base = platform === "win32" ? env.LOCALAPPDATA || path.join(home, "AppData", "Local")
    : platform === "darwin" ? path.join(home, "Library", "Application Support") : env.XDG_CONFIG_HOME || path.join(home, ".config");
  const normalBase = platform === "win32" ? env.APPDATA || path.join(home, "AppData", "Roaming") : base;
  const library = path.join(base, "Claude-3p", "configLibrary");
  return { code: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "settings.json"),
    normal: path.join(normalBase, "Claude", "claude_desktop_config.json"),
    threep: path.join(base, "Claude-3p", "claude_desktop_config.json"),
    meta: path.join(library, "_meta.json"), profile: path.join(library, `${M365_CLAUDE_PROFILE_ID}.json`) };
}

function read(file) {
  try {
    if (!fs.lstatSync(file).isFile()) throw Error();
    const bytes = readBoundedFileSync(file, { maxBytes: 1024 * 1024 });
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
    return { exists: true, bytes, value };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, bytes: null, value: {} };
    throw Object.assign(new Error("Claude configuration is unreadable; existing files were preserved"), { code: "claude_config_unreadable" });
  }
}
function valueAt(object, keys) {
  const parent = keys.slice(0, -1).reduce((v, k) => v && Object.hasOwn(v, k) ? v[k] : undefined, object);
  return parent && typeof parent === "object" && Object.hasOwn(parent, keys.at(-1)) ? { exists: true, value: parent[keys.at(-1)] } : { exists: false };
}
function setAt(object, keys, value) {
  let parent = object;
  for (const key of keys.slice(0, -1)) {
    if (parent[key] === undefined) parent[key] = {};
    if (!parent[key] || typeof parent[key] !== "object" || Array.isArray(parent[key])) throw new Error("Claude configuration has a conflicting parent field");
    parent = parent[key];
  }
  if (value.exists) parent[keys.at(-1)] = value.value;
  else {
    delete parent[keys.at(-1)];
    if (keys.length === 2 && Object.keys(parent).length === 0) delete object[keys[0]];
  }
}

export async function inspectClaudeDesktopPolicy({ platform = process.platform, home = os.homedir(), env = process.env,
  execFileImpl = promisify(execFile) } = {}) {
  if (platform === "darwin") {
    const files = ["/Library/Managed Preferences/com.anthropic.claudefordesktop.plist",
      path.join("/Library/Managed Preferences", os.userInfo().username, "com.anthropic.claudefordesktop.plist"),
      path.join(home, "Library", "Managed Preferences", "com.anthropic.claudefordesktop.plist")];
    return files.some(file => fs.existsSync(file));
  }
  if (platform === "win32") {
    const reg = path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
    for (const key of ["HKLM\\SOFTWARE\\Policies\\Claude", "HKCU\\SOFTWARE\\Policies\\Claude"]) {
      try { await execFileImpl(reg, ["query", key], { encoding: "utf8", timeout: 3000, maxBuffer: 32768, windowsHide: true });return true; }
      catch (error) { if (error.code !== 1) return true; }
    }
  }
  return false;
}

function operationValue(snapshot, operation) {
  const field = valueAt(snapshot, operation.keys);
  if (!operation.itemId) return field;
  const item = Array.isArray(field.value) ? field.value.find(value => value?.id === operation.itemId) : undefined;
  return item ? { exists: true, value: item } : { exists: false };
}
function setOperation(snapshot, operation, value) {
  if (!operation.itemId) { setAt(snapshot, operation.keys, value);return; }
  const current = valueAt(snapshot, operation.keys);
  if (current.exists && !Array.isArray(current.value)) throw new Error("Claude profile list is invalid");
  const next = (current.value || []).filter(item => item?.id !== operation.itemId);
  if (value.exists) next.push(value.value);
  setAt(snapshot, operation.keys, { exists: true, value: next });
}

function parsedAppModels(value) {
  try {
    if (typeof value !== "string") return null;
    const models = JSON.parse(value), names = new Set();
    if (!Array.isArray(models)) return null;
    for (const model of models) {
      if (!model || typeof model !== "object" || Array.isArray(model) || typeof model.name !== "string" || !model.name || names.has(model.name)
        || Object.hasOwn(model, "prefer1m") && typeof model.prefer1m !== "boolean") return null;
      names.add(model.name);
    }
    return models;
  } catch { return null; }
}
const withoutAppPreference = models => models.map(({ prefer1m, ...model }) => model);
function appModelsOwned(current, previous, desired, alreadyDesired) {
  const actual = parsedAppModels(current), recorded = parsedAppModels(previous);
  if (!actual || !recorded) return false;
  if (isDeepStrictEqual(withoutAppPreference(actual), withoutAppPreference(recorded))) return true;
  // A prior manual recovery may already equal the selected generated list.
  // Adopt only if surviving old entries retain their fields and relative order.
  const selected = alreadyDesired && parsedAppModels(desired);
  if (!selected) return false;
  const oldNames = new Set(recorded.map(model => model.name)), wanted = new Set(selected.map(model => model.name));
  return isDeepStrictEqual(withoutAppPreference(actual.filter(model => oldNames.has(model.name))),
    withoutAppPreference(recorded.filter(model => wanted.has(model.name))));
}

export function reconcileClaudeConfiguration(operations, { restore = false, ...options } = {}) {
  const paths = claudeClientPaths(options), allowed = new Set(Object.values(paths)), journalPath = m365Paths(options).ownership;
  fs.mkdirSync(path.dirname(journalPath), { recursive: true, mode: 0o700 });
  return withFileLockSync(`${journalPath}.lock`, () => {
    const journal = readM365Json(journalPath, { version: 1, operations: [] });
    const keys = new Map([
      [paths.code, new Set(["env.ANTHROPIC_BASE_URL", "env.ANTHROPIC_AUTH_TOKEN", "env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "env.ANTHROPIC_CUSTOM_HEADERS", "env.ANTHROPIC_MODEL", "env.CLAUDE_CODE_MAX_CONTEXT_TOKENS", "env.CLAUDE_CODE_MAX_OUTPUT_TOKENS", "env.CLAUDE_CODE_MODEL_CAPABILITIES"])],
      [paths.normal, new Set(["deploymentMode"])], [paths.threep, new Set(["deploymentMode"])],
      [paths.meta, new Set(["entries", "appliedId"])],
      [paths.profile, new Set(["inferenceProvider", "inferenceGatewayBaseUrl", "inferenceGatewayApiKey", "inferenceGatewayAuthScheme", "inferenceModels", "inferenceCustomHeaders"])],
    ]);
    const safeKeys = op => Array.isArray(op.keys) && !op.keys.some(key => ["__proto__", "constructor", "prototype"].includes(key))
      && (keys.get(op.file)?.has(op.keys.join(".")) || op.file === paths.code && op.keys.length === 3 && op.keys[0] === "modelSettings"
        && /^[\w][\w./:@+\[\]-]{0,200}$/.test(op.keys[1]) && op.keys[2] === "autoCompactWindow");
    if (journal.version !== 1 || !Array.isArray(journal.operations) || journal.operations.some(op => !allowed.has(op.file)
      || !safeKeys(op)
      || op.itemId !== undefined && (op.file !== paths.meta || op.keys.join(".") !== "entries" || op.itemId !== M365_CLAUDE_PROFILE_ID))) {
      throw new Error("Claude configuration ownership is invalid; files were preserved");
    }
    const states = new Map(), pending = [], nextJournal = structuredClone(journal), skipped = [];
    const sharedOperation = op => op.file === paths.code && (op.keys[0] === "modelSettings" || ["CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_MODEL_CAPABILITIES"].includes(op.keys[1]));
    const forClient = op => (!options.selectOperation || options.selectOperation(op)) && (!options.client || (options.client === "claude_code" ? op.file === paths.code && !sharedOperation(op) : op.file !== paths.code))
      && (!options.fields || options.fields.includes(op.keys.join(".")));
    const list = restore ? journal.operations.filter(forClient) : operations;
    for (const operation of list) {
      if (!allowed.has(operation.file) || !safeKeys(operation)) throw new Error("Unexpected Claude configuration path");
      if (!states.has(operation.file)) states.set(operation.file, read(operation.file));
      const state = states.get(operation.file);state.next ||= structuredClone(state.value);
      const previous = journal.operations.find(op => op.file === operation.file && isDeepStrictEqual(op.keys, operation.keys) && op.itemId === operation.itemId);
      const current = operationValue(state.next, operation), desired = restore ? operation.before : { exists: true, value: operation.value };
      if (restore) {
        if (!isDeepStrictEqual(current, { exists: true, value: operation.after })) { skipped.push(operation.file);continue; }
        setOperation(state.next, operation, desired);
        nextJournal.operations = nextJournal.operations.filter(op => !(op.file === operation.file && isDeepStrictEqual(op.keys, operation.keys) && op.itemId === operation.itemId));
      } else {
        const modelField = operation.file === paths.profile && operation.keys.join(".") === "inferenceModels";
        const currentModels = modelField && parsedAppModels(current.value), desiredModels = modelField && parsedAppModels(desired.value);
        const alreadyDesired = isDeepStrictEqual(current, desired)
          || Boolean(currentModels && desiredModels && isDeepStrictEqual(currentModels, desiredModels));
        const owned = previous && (isDeepStrictEqual(current, { exists: true, value: previous.after })
          || modelField && current.exists && appModelsOwned(current.value, previous.after, desired.value, alreadyDesired));
        if (alreadyDesired) {
          if (modelField && owned && previous.after !== current.value) {
            nextJournal.operations = nextJournal.operations.map(op => op.file === operation.file
              && isDeepStrictEqual(op.keys, operation.keys) && op.itemId === operation.itemId ? { ...op, after: current.value } : op);
          }
          continue;
        }
        const replaceMode = operation.keys.join(".") === "deploymentMode" && [paths.normal, paths.threep].includes(operation.file)
          && current.value === "1p";
        if (current.exists && !replaceMode && !owned) { skipped.push(operation.file);continue; }
        const entry = { file: operation.file, keys: operation.keys, ...(operation.itemId ? { itemId: operation.itemId } : {}),
          before: previous?.before || current, after: operation.value };
        setOperation(state.next, operation, desired);
        nextJournal.operations = nextJournal.operations.filter(op => !(op.file === operation.file && isDeepStrictEqual(op.keys, operation.keys) && op.itemId === operation.itemId));
        nextJournal.operations.push(entry);
      }
    }
    // Record ownership before client writes so interruption remains recoverable.
    const oldJournal = journal;
    if (!restore) writeM365Json(journalPath, nextJournal);
    try {
      for (const [file, state] of states) {
        if (isDeepStrictEqual(state.value, state.next)) continue;
        const latest = read(file);
        if (latest.exists !== state.exists || latest.bytes?.equals(state.bytes) === false) throw new Error("Claude configuration changed during setup; retry after the other writer finishes");
        const bytes = Buffer.from(`${JSON.stringify(state.next, null, 2)}\n`);
        atomicWriteFileSync(file, bytes, { mode: 0o600, preserveMode: false });pending.push({ file, state, bytes });
      }
      if (restore) writeM365Json(journalPath, nextJournal);
    } catch (error) {
      for (const entry of pending.reverse()) {
        const latest = read(entry.file);
        if (!latest.bytes?.equals(entry.bytes)) continue;
        if (entry.state.exists) atomicWriteFileSync(entry.file, entry.state.bytes, { mode: 0o600 });
        else fs.unlinkSync(entry.file);
      }
      writeM365Json(journalPath, oldJournal);throw error;
    }
    return { changed: pending.length > 0, preserved: [...new Set(skipped)].length, remaining: nextJournal.operations.filter(forClient).length };
  });
}

export function configureClaudeClients({ baseUrl, apiKey, models, desktopInstalled, desktopManaged, desktopAliases = false, profileName = M365_CLAUDE_PROFILE_NAME, disableExperimentalBetas = true, defaultModel, ...options } = {}) {
  const entries = claudeModelEntries(models);
  const paths = claudeClientPaths(options), ids = entries.map(model => model.name), operations = [], result = {};
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !["/", "/anthropic"].includes(endpoint.pathname) || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new Error("Claude gateway must use a local root or /anthropic URL");
  const journal = readM365Json(m365Paths(options).ownership, { version: 1, operations: [] });
  const owns = (file, keys, value) => journal.version === 1 && Array.isArray(journal.operations)
    && journal.operations.some(op => op.file === file && isDeepStrictEqual(op.keys, keys) && isDeepStrictEqual(op.after, value));
  const add = (file, keys, value, itemId) => operations.push({ file, keys, value, ...(itemId ? { itemId } : {}) });
  const env = options.env || process.env;
  let code;
  try { code = read(paths.code).value; } catch { result.code = "configuration_unavailable"; }
  const codeEnv = code?.env || {};
  const envConflict = env.ANTHROPIC_BASE_URL && env.ANTHROPIC_BASE_URL !== baseUrl
    || env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_AUTH_TOKEN !== apiKey
    || codeEnv.ANTHROPIC_AUTH_TOKEN && codeEnv.ANTHROPIC_AUTH_TOKEN !== apiKey && !owns(paths.code, ["env", "ANTHROPIC_AUTH_TOKEN"], codeEnv.ANTHROPIC_AUTH_TOKEN)
    || env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY !== apiKey
    || codeEnv.ANTHROPIC_API_KEY && codeEnv.ANTHROPIC_API_KEY !== apiKey
    || code?.apiKeyHelper
    || ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_GATEWAY"].some(key => /^(1|true)$/i.test(env[key] || codeEnv[key] || ""));
  if (options.client === "claude_app") { /* The other client's configuration has a separate lifecycle. */ }
  else if (!code) { /* Keep independent App setup available when Code settings are damaged. */ }
  else if (envConflict || codeEnv.ANTHROPIC_BASE_URL && codeEnv.ANTHROPIC_BASE_URL !== baseUrl
    && !owns(paths.code, ["env", "ANTHROPIC_BASE_URL"], codeEnv.ANTHROPIC_BASE_URL)) result.code = "preserved";
  else {
    add(paths.code, ["env", "ANTHROPIC_BASE_URL"], baseUrl);
    add(paths.code, ["env", "ANTHROPIC_AUTH_TOKEN"], apiKey);
    add(paths.code, ["env", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"], "1");
    if (disableExperimentalBetas && env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS === undefined) add(paths.code, ["env", "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"], "1");
    add(paths.code, ["env", "ANTHROPIC_CUSTOM_HEADERS"], "X-CCDX-Client: claude-code");
    if (ids.length && (!codeEnv.ANTHROPIC_MODEL || models.some(model => model.id === codeEnv.ANTHROPIC_MODEL)
      || owns(paths.code, ["env", "ANTHROPIC_MODEL"], codeEnv.ANTHROPIC_MODEL))) {
      const index = models.findIndex(model => model.id === codeEnv.ANTHROPIC_MODEL || claudeClientModelId(model.id) === codeEnv.ANTHROPIC_MODEL);
      add(paths.code, ["env", "ANTHROPIC_MODEL"], defaultModel && ids.includes(defaultModel) ? defaultModel : ids[Math.max(0, index)]);
    }
    result.code = "configured";
  }
  const installed = desktopInstalled ?? (fs.existsSync(path.dirname(paths.normal)) || fs.existsSync(path.dirname(paths.threep))
    || (options.platform || process.platform) === "darwin" && fs.existsSync("/Applications/Claude.app"));
  if (options.client === "claude_code") { /* The other client's configuration has a separate lifecycle. */ }
  else if (!installed) result.app = "not_installed";
  else if (desktopManaged !== false || env.CLAUDE_USER_DATA_DIR) result.app = "preserved";
  else {
    let meta, profile;
    try { meta = read(paths.meta).value;profile = read(paths.profile).value; } catch { result.app = "configuration_unavailable"; }
    const sealedOwnedKey = typeof profile?.inferenceGatewayApiKey === "string"
      && profile.inferenceGatewayApiKey.trimStart().startsWith("__sealed__:v1:")
      && owns(paths.profile, ["inferenceGatewayApiKey"], apiKey);
    if (!meta) { /* Code setup remains independent. */ }
    else if (meta.hybridPointer || meta.appliedId && meta.appliedId !== M365_CLAUDE_PROFILE_ID
      || profile.inferenceProvider && profile.inferenceProvider !== "gateway"
      || profile.inferenceGatewayBaseUrl && profile.inferenceGatewayBaseUrl !== baseUrl
        && !owns(paths.profile, ["inferenceGatewayBaseUrl"], profile.inferenceGatewayBaseUrl)
      || profile.inferenceGatewayApiKey && profile.inferenceGatewayApiKey !== apiKey && !owns(paths.profile, ["inferenceGatewayApiKey"], profile.inferenceGatewayApiKey) && !sealedOwnedKey) result.app = "preserved";
    else {
      add(paths.profile, ["inferenceProvider"], "gateway");
      add(paths.profile, ["inferenceGatewayBaseUrl"], baseUrl);
      if (sealedOwnedKey) result.app_credential = "encrypted_unverified";
      else add(paths.profile, ["inferenceGatewayApiKey"], apiKey);
      add(paths.profile, ["inferenceGatewayAuthScheme"], "bearer");
      let previousModels = [];
      try { previousModels = JSON.parse(profile.inferenceModels || "[]"); } catch { /* Ownership reconciliation preserves a user-modified field. */ }
      const order = new Map((Array.isArray(previousModels) ? previousModels : []).map((entry, index) => {
        const name = typeof entry === "string" ? entry : entry?.name;
        return [typeof name === "string" ? claudeClientModelId(name) : "", index];
      }));
      const previousByName = new Map((Array.isArray(previousModels) ? previousModels : []).filter(model => model && typeof model === "object").map(model => [model.name, model]));
      const desktopEntries = (desktopAliases ? claudeModelEntries(models, { desktopAliases }) : entries).map(entry => {
        const previous = previousByName.get(entry.name);
        return entry.supports1m ? { ...entry, prefer1m: typeof previous?.prefer1m === "boolean" ? previous.prefer1m : true } : entry;
      });
      for (let index = 0; index < models.length; index++) {
        const old = order.get(claudeClientModelId(models[index].id));
        if (old !== undefined && !order.has(desktopEntries[index].name)) order.set(desktopEntries[index].name, old);
      }
      const orderedEntries = [...desktopEntries].sort((left, right) => defaultModel && (left.name === defaultModel || right.name === defaultModel)
        ? left.name === defaultModel ? -1 : 1 : (order.get(left.name) ?? Infinity) - (order.get(right.name) ?? Infinity));
      add(paths.profile, ["inferenceModels"], JSON.stringify(orderedEntries));
      add(paths.profile, ["inferenceCustomHeaders"], JSON.stringify({ "X-CCDX-Client": "claude-app" }));
      add(paths.meta, ["entries"], { id: M365_CLAUDE_PROFILE_ID, name: profileName }, M365_CLAUDE_PROFILE_ID);
      add(paths.meta, ["appliedId"], M365_CLAUDE_PROFILE_ID);
      add(paths.threep, ["deploymentMode"], "3p");
      result.app = "configured";
    }
  }
  const applied = reconcileClaudeConfiguration(operations, options);
  if (applied.preserved) {
    if (result.code === "configured") result.code = "partially_preserved";
    if (result.app === "configured") result.app = "partially_preserved";
  }
  return { ...result, changed: applied.changed };
}

export function restoreClaudeClients(options = {}) {
  if (!fs.existsSync(m365Paths(options).ownership)) return { changed: false, preserved: 0, remaining: 0 };
  return reconcileClaudeConfiguration([], { ...options, restore: true });
}
