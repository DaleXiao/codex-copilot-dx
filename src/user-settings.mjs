import { readBoundedFileSync } from "./bounded-file.mjs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFileIfChangedSync } from "./atomic-file.mjs";
import { withFileLockSync } from "./lock.mjs";
import { isColorTheme } from "./terminal-colors.mjs";
import { AUTO_REVIEW_REASONING_EFFORTS, DEFAULT_CODEX_AUTO_REVIEW_MODEL } from "./models.mjs";
import { loadRuntimeConfig, RUNTIME_DEFAULTS } from "./runtime-config.mjs";
import {
  MIB,
  RESPONSE_HISTORY_DEFAULT_MIB,
  RESPONSE_HISTORY_MAX_MIB,
  RESPONSE_HISTORY_MIN_MIB,
} from "./cache-limits.mjs";
import {
  DEFAULT_TERMINAL_ANIMATION_THEME,
  isTerminalAnimationTheme,
  TERMINAL_ANIMATION_THEMES,
} from "./terminal-animation.mjs";

const AUTO_REVIEW_MODEL_KEY = "auto_review_model";
const AUTO_REVIEW_REASONING_KEY = "auto_review_reasoning";
const TERMINAL_ANIMATION_KEY = "terminal_animation";
const RESPONSE_HISTORY_MAX_MIB_KEY = "response_history_max_mib";
const DECODED_BODY_LIMIT_MIB_KEY = "decoded_body_limit_mib";
const SERVICE_FLAGS = ["terminal_animation_enabled", "open_webui", "image_enabled", "prediction_enabled"];
export const DECODED_BODY_LIMIT_MIN_MIB = RUNTIME_DEFAULTS.maxDecodedBodyBytes / MIB;
export const DECODED_BODY_LIMIT_MAX_MIB = 512;
export { RESPONSE_HISTORY_MAX_MIB, RESPONSE_HISTORY_MIN_MIB };

export function userSettingsPath({ env = process.env, home = os.homedir() } = {}) {
  const xdgConfigHome = String(env.XDG_CONFIG_HOME || "").trim();
  const configRoot = xdgConfigHome || path.join(home, ".config");
  return path.join(configRoot, "codex-copilot-dx", "config.json");
}

function invalidSettings(filePath, reason) {
  return new Error(`Invalid ccdx settings at ${filePath}: ${reason}`);
}

export function readUserSettings({ env = process.env, home = os.homedir(), strict = false } = {}) {
  const filePath = userSettingsPath({ env, home });
  try {
    const parsed = JSON.parse(readBoundedFileSync(filePath, { encoding: "utf8" }));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw invalidSettings(filePath, "expected a JSON object");
    }
    for (const key of SERVICE_FLAGS) {
      if (Object.hasOwn(parsed, key) && typeof parsed[key] !== "boolean") {
        if (strict) throw invalidSettings(filePath, `${key} must be a boolean`);
        delete parsed[key];
      }
    }
    for (const key of ["nightly_updates", "auto_save_settings"]) if (Object.hasOwn(parsed, key) && typeof parsed[key] !== "boolean") {
      if (strict) throw invalidSettings(filePath, `${key} must be a boolean`);
      delete parsed[key];
    }
    if (Object.hasOwn(parsed, "terminal_color_theme") && !isColorTheme(parsed.terminal_color_theme)) {
      if (strict) throw invalidSettings(filePath, "terminal_color_theme must be green, klein, pink, mono or orange");
      delete parsed.terminal_color_theme;
    }
    if (Object.hasOwn(parsed, AUTO_REVIEW_MODEL_KEY)) {
      const value = parsed[AUTO_REVIEW_MODEL_KEY];
      if (typeof value !== "string" || !value.trim()) {
        throw invalidSettings(filePath, `${AUTO_REVIEW_MODEL_KEY} must be a non-empty string`);
      }
    }
    if (Object.hasOwn(parsed, AUTO_REVIEW_REASONING_KEY)) {
      const value = parsed[AUTO_REVIEW_REASONING_KEY];
      if (!value || typeof value !== "object" || Array.isArray(value)
        || typeof value.model !== "string" || !value.model.trim()
        || !(value.effort === null || AUTO_REVIEW_REASONING_EFFORTS.includes(value.effort))) {
        if (strict) throw invalidSettings(filePath, `${AUTO_REVIEW_REASONING_KEY} must contain a model and valid effort`);
        delete parsed[AUTO_REVIEW_REASONING_KEY];
      }
    }
    if (Object.hasOwn(parsed, TERMINAL_ANIMATION_KEY)) {
      const value = parsed[TERMINAL_ANIMATION_KEY];
      // Accept the retired value on read so upgrades can fall back and select a replacement.
      if (value !== "braille" && !isTerminalAnimationTheme(value)) {
        const choices = TERMINAL_ANIMATION_THEMES.map(({ id }) => id).join(", ");
        if (strict) {
          throw invalidSettings(filePath, `${TERMINAL_ANIMATION_KEY} must be one of: ${choices}`);
        }
        delete parsed[TERMINAL_ANIMATION_KEY];
      }
    }
    if (Object.hasOwn(parsed, RESPONSE_HISTORY_MAX_MIB_KEY)) {
      const value = parsed[RESPONSE_HISTORY_MAX_MIB_KEY];
      if (!Number.isSafeInteger(value)
        || value < RESPONSE_HISTORY_MIN_MIB
        || value > RESPONSE_HISTORY_MAX_MIB) {
        if (strict) {
          throw invalidSettings(filePath, `${RESPONSE_HISTORY_MAX_MIB_KEY} must be an integer from ${RESPONSE_HISTORY_MIN_MIB} to ${RESPONSE_HISTORY_MAX_MIB}`);
        }
        delete parsed[RESPONSE_HISTORY_MAX_MIB_KEY];
      }
    }
    if (Object.hasOwn(parsed, DECODED_BODY_LIMIT_MIB_KEY)) {
      const value = parsed[DECODED_BODY_LIMIT_MIB_KEY];
      if (!Number.isSafeInteger(value)
        || value < DECODED_BODY_LIMIT_MIN_MIB
        || value > DECODED_BODY_LIMIT_MAX_MIB) {
        if (strict) {
          throw invalidSettings(filePath, `${DECODED_BODY_LIMIT_MIB_KEY} must be an integer from ${DECODED_BODY_LIMIT_MIN_MIB} to ${DECODED_BODY_LIMIT_MAX_MIB}`);
        }
        delete parsed[DECODED_BODY_LIMIT_MIB_KEY];
      }
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    if (strict) {
      if (String(error?.message || "").startsWith("Invalid ccdx settings")) throw error;
      throw invalidSettings(filePath, error?.message || String(error));
    }
    return {};
  }
}

export function savedAutoReviewModel(options = {}) {
  const settings = readUserSettings(options);
  return String(settings[AUTO_REVIEW_MODEL_KEY] || "").trim();
}

export function servicePreferences(options = {}) {
  const settings = readUserSettings({ ...options, strict: true });
  return serviceFlags(settings);
}
export function nightlyUpdatePreference(options = {}) {
  return readUserSettings({ ...options, strict: true }).nightly_updates === true;
}
export function writeNightlyUpdatePreference(enabled, options = {}) {
  if (typeof enabled !== "boolean") throw new Error("Nightly updates require a boolean");
  return withFileLockSync(`${userSettingsPath(options)}.lock`, () => {
    const settings = readUserSettings({ ...options, strict: true });
    atomicWriteFileIfChangedSync(userSettingsPath(options), `${JSON.stringify({ ...settings, nightly_updates: enabled }, null, 2)}\n`, { mode: 0o600 });
    return enabled;
  });
}
const serviceFlags = settings => Object.fromEntries(SERVICE_FLAGS.map(key => [key, settings[key] !== false]));

// One strict read gives each status update a coherent view; no stale cache.
export function serviceSettingsSnapshot(options = {}) {
  const settings = readUserSettings({ ...options, strict: true });
  return { saved: serviceFlags(settings), theme: animationPreference(settings).theme, color_theme: settings.terminal_color_theme || "green",
    historyLimit: historyLimitPreference(settings, options.env || process.env) };
}

export function terminalColorPreference(options = {}) {
  return readUserSettings(options).terminal_color_theme || "green";
}

export function writeTerminalColorTheme(theme, options = {}) {
  if (!isColorTheme(theme)) throw new Error("Choose green, klein, pink, mono or orange for the terminal color theme");
  return withFileLockSync(`${userSettingsPath(options)}.lock`, () => {
    const settings = readUserSettings({ ...options, strict: true });
    const next = { ...settings };
    if (theme === "green") delete next.terminal_color_theme;
    else next.terminal_color_theme = theme;
    const changed = atomicWriteFileIfChangedSync(userSettingsPath(options), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return { changed, color_theme: theme };
  });
}

export function writeServicePreference(key, value, options = {}) {
  if (!SERVICE_FLAGS.includes(key) || typeof value !== "boolean") throw new Error("Unknown service setting or invalid boolean");
  return withFileLockSync(`${userSettingsPath(options)}.lock`, () => {
    const settings = readUserSettings({ ...options, strict: true });
    const changed = atomicWriteFileIfChangedSync(userSettingsPath(options), `${JSON.stringify({ ...settings, [key]: value }, null, 2)}\n`, { mode: 0o600 });
    return { changed, ...servicePreferences(options) };
  });
}

export function autoReviewModelPreference({ env = process.env, home = os.homedir() } = {}) {
  const { model, source } = autoReviewPreference({ env, home });
  return { model, source };
}

export function autoReviewPreference({ env = process.env, home = os.homedir() } = {}) {
  const settings = readUserSettings({ env, home });
  const environmentModel = String(env.CCDX_AUTO_REVIEW_MODEL || "").trim();
  const savedModel = String(settings[AUTO_REVIEW_MODEL_KEY] || "").trim();
  const model = environmentModel || savedModel || DEFAULT_CODEX_AUTO_REVIEW_MODEL;
  const source = environmentModel ? "environment" : savedModel ? "settings" : "default";
  const reasoning = settings[AUTO_REVIEW_REASONING_KEY];
  return { model, source, reasoningEffort: reasoning?.model === model ? reasoning.effort : undefined };
}

export function savedTerminalAnimationTheme(options = {}) {
  const settings = readUserSettings(options);
  const theme = settings[TERMINAL_ANIMATION_KEY];
  return isTerminalAnimationTheme(theme) ? theme : "";
}

export function terminalAnimationPreference({ env = process.env, home = os.homedir() } = {}) {
  return animationPreference(readUserSettings({ env, home }));
}
function animationPreference(settings) {
  const savedTheme = isTerminalAnimationTheme(settings[TERMINAL_ANIMATION_KEY]) ? settings[TERMINAL_ANIMATION_KEY] : "";
  if (savedTheme) return { theme: savedTheme, source: "settings" };
  return { theme: DEFAULT_TERMINAL_ANIMATION_THEME, source: "default" };
}

export function responseHistoryLimitPreference({ env = process.env, home = os.homedir() } = {}) {
  return historyLimitPreference(readUserSettings({ env, home }), env);
}
function historyLimitPreference(settings, env) {
  const environment = String(env.CCDX_RESPONSE_HISTORY_MAX_BYTES || "").trim();
  if (environment) {
    return { bytes: loadRuntimeConfig(env).responseHistoryMaxBytes, source: "environment" };
  }
  const mib = settings[RESPONSE_HISTORY_MAX_MIB_KEY];
  if (Number.isSafeInteger(mib)) return { bytes: mib * MIB, mib, source: "settings" };
  return { bytes: RESPONSE_HISTORY_DEFAULT_MIB * MIB, mib: RESPONSE_HISTORY_DEFAULT_MIB, source: "default" };
}

export function decodedBodyLimitPreference({ env = process.env, home = os.homedir() } = {}) {
  const environment = String(env.CCDX_MAX_DECODED_BODY_BYTES || "").trim();
  if (environment) {
    return { bytes: loadRuntimeConfig(env).maxDecodedBodyBytes, source: "environment" };
  }
  const settings = readUserSettings({ env, home });
  const mib = settings[DECODED_BODY_LIMIT_MIB_KEY];
  if (Number.isSafeInteger(mib)) return { bytes: mib * MIB, mib, source: "settings" };
  return { bytes: RUNTIME_DEFAULTS.maxDecodedBodyBytes, mib: DECODED_BODY_LIMIT_MIN_MIB, source: "default" };
}

export function writeDecodedBodyLimitMib(mib, options = {}) {
  return withFileLockSync(`${userSettingsPath(options)}.lock`, () => writeDecodedBodyLimitMibUnlocked(mib, options));
}
function writeDecodedBodyLimitMibUnlocked(mib, { env = process.env, home = os.homedir() } = {}) {
  const filePath = userSettingsPath({ env, home });
  const settings = readUserSettings({ env, home, strict: true });
  const next = { ...settings };
  if (mib === null || mib === undefined || mib === "") {
    if (!Object.hasOwn(next, DECODED_BODY_LIMIT_MIB_KEY)) {
      return { changed: false, filePath, ...decodedBodyLimitPreference({ env, home }) };
    }
    delete next[DECODED_BODY_LIMIT_MIB_KEY];
  } else {
    const parsed = Number(mib);
    if (!Number.isSafeInteger(parsed)
      || parsed < DECODED_BODY_LIMIT_MIN_MIB
      || parsed > DECODED_BODY_LIMIT_MAX_MIB) {
      throw new Error(`Decoded request-body limit must be an integer from ${DECODED_BODY_LIMIT_MIN_MIB} to ${DECODED_BODY_LIMIT_MAX_MIB} MiB`);
    }
    next[DECODED_BODY_LIMIT_MIB_KEY] = parsed;
  }
  const changed = atomicWriteFileIfChangedSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return { changed, filePath, ...decodedBodyLimitPreference({ env, home }) };
}

export function writeResponseHistoryLimitMib(mib, options = {}) {
  return withFileLockSync(`${userSettingsPath(options)}.lock`, () => writeResponseHistoryLimitMibUnlocked(mib, options));
}
function writeResponseHistoryLimitMibUnlocked(mib, { env = process.env, home = os.homedir() } = {}) {
  const filePath = userSettingsPath({ env, home });
  const settings = readUserSettings({ env, home, strict: true });
  const next = { ...settings };
  if (mib === null || mib === undefined || mib === "") {
    if (!Object.hasOwn(next, RESPONSE_HISTORY_MAX_MIB_KEY)) {
      return { changed: false, filePath, ...responseHistoryLimitPreference({ env, home }) };
    }
    delete next[RESPONSE_HISTORY_MAX_MIB_KEY];
  } else {
    const parsed = Number(mib);
    if (!Number.isSafeInteger(parsed)
      || parsed < RESPONSE_HISTORY_MIN_MIB
      || parsed > RESPONSE_HISTORY_MAX_MIB) {
      throw new Error(`History cache limit must be an integer from ${RESPONSE_HISTORY_MIN_MIB} to ${RESPONSE_HISTORY_MAX_MIB} MiB`);
    }
    next[RESPONSE_HISTORY_MAX_MIB_KEY] = parsed;
  }
  const changed = atomicWriteFileIfChangedSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return { changed, filePath, ...responseHistoryLimitPreference({ env, home }) };
}

export function writeAutoReviewModel(model, options = {}) {
  return withFileLockSync(`${userSettingsPath(options)}.lock`, () => writeAutoReviewModelUnlocked(model, options));
}
function writeAutoReviewModelUnlocked(model, { env = process.env, home = os.homedir(), reasoningEffort } = {}) {
  if (reasoningEffort !== undefined && reasoningEffort !== null
    && !AUTO_REVIEW_REASONING_EFFORTS.includes(reasoningEffort)) {
    throw new Error("Auto-review reasoning effort is invalid");
  }
  const filePath = userSettingsPath({ env, home });
  const settings = readUserSettings({ env, home, strict: true });
  const value = String(model || "").trim();
  const next = { ...settings };
  if (value) next[AUTO_REVIEW_MODEL_KEY] = value;
  else delete next[AUTO_REVIEW_MODEL_KEY];
  const selectedModel = value || DEFAULT_CODEX_AUTO_REVIEW_MODEL;
  if (reasoningEffort !== undefined) next[AUTO_REVIEW_REASONING_KEY] = { model: selectedModel, effort: reasoningEffort };
  else if (next[AUTO_REVIEW_REASONING_KEY]?.model !== selectedModel) {
    delete next[AUTO_REVIEW_REASONING_KEY];
  }

  const changed = atomicWriteFileIfChangedSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return { changed, filePath, model: value || DEFAULT_CODEX_AUTO_REVIEW_MODEL };
}

export function writeTerminalAnimationTheme(theme, options = {}) {
  return withFileLockSync(`${userSettingsPath(options)}.lock`, () => writeTerminalAnimationThemeUnlocked(theme, options));
}
function writeTerminalAnimationThemeUnlocked(theme, { env = process.env, home = os.homedir() } = {}) {
  if (!isTerminalAnimationTheme(theme)) {
    const choices = TERMINAL_ANIMATION_THEMES.map(({ id }) => id).join(", ");
    throw new Error(`Terminal animation must be one of: ${choices}`);
  }

  const filePath = userSettingsPath({ env, home });
  const settings = readUserSettings({ env, home, strict: true });
  const next = { ...settings };
  if (theme === DEFAULT_TERMINAL_ANIMATION_THEME) {
    if (!Object.hasOwn(next, TERMINAL_ANIMATION_KEY)) {
      return { changed: false, filePath, theme };
    }
    delete next[TERMINAL_ANIMATION_KEY];
  } else {
    next[TERMINAL_ANIMATION_KEY] = theme;
  }

  const changed = atomicWriteFileIfChangedSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return { changed, filePath, theme };
}
