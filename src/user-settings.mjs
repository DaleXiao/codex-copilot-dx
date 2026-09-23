import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFileIfChangedSync } from "./atomic-file.mjs";
import { DEFAULT_CODEX_AUTO_REVIEW_MODEL } from "./models.mjs";
import { loadRuntimeConfig } from "./runtime-config.mjs";
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
const TERMINAL_ANIMATION_KEY = "terminal_animation";
const RESPONSE_HISTORY_MAX_MIB_KEY = "response_history_max_mib";
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
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw invalidSettings(filePath, "expected a JSON object");
    }
    if (Object.hasOwn(parsed, AUTO_REVIEW_MODEL_KEY)) {
      const value = parsed[AUTO_REVIEW_MODEL_KEY];
      if (typeof value !== "string" || !value.trim()) {
        throw invalidSettings(filePath, `${AUTO_REVIEW_MODEL_KEY} must be a non-empty string`);
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

export function autoReviewModelPreference({ env = process.env, home = os.homedir() } = {}) {
  const environmentModel = String(env.CCDX_AUTO_REVIEW_MODEL || "").trim();
  if (environmentModel) return { model: environmentModel, source: "environment" };

  const savedModel = savedAutoReviewModel({ env, home });
  if (savedModel) return { model: savedModel, source: "settings" };
  return { model: DEFAULT_CODEX_AUTO_REVIEW_MODEL, source: "default" };
}

export function savedTerminalAnimationTheme(options = {}) {
  const settings = readUserSettings(options);
  const theme = settings[TERMINAL_ANIMATION_KEY];
  return isTerminalAnimationTheme(theme) ? theme : "";
}

export function terminalAnimationPreference({ env = process.env, home = os.homedir() } = {}) {
  const savedTheme = savedTerminalAnimationTheme({ env, home });
  if (savedTheme) return { theme: savedTheme, source: "settings" };
  return { theme: DEFAULT_TERMINAL_ANIMATION_THEME, source: "default" };
}

export function responseHistoryLimitPreference({ env = process.env, home = os.homedir() } = {}) {
  const environment = String(env.CCDX_RESPONSE_HISTORY_MAX_BYTES || "").trim();
  if (environment) {
    return { bytes: loadRuntimeConfig(env).responseHistoryMaxBytes, source: "environment" };
  }
  const settings = readUserSettings({ env, home });
  const mib = settings[RESPONSE_HISTORY_MAX_MIB_KEY];
  if (Number.isSafeInteger(mib)) return { bytes: mib * MIB, mib, source: "settings" };
  return { bytes: RESPONSE_HISTORY_DEFAULT_MIB * MIB, mib: RESPONSE_HISTORY_DEFAULT_MIB, source: "default" };
}

export function writeResponseHistoryLimitMib(mib, { env = process.env, home = os.homedir() } = {}) {
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

export function writeAutoReviewModel(model, { env = process.env, home = os.homedir() } = {}) {
  const filePath = userSettingsPath({ env, home });
  const settings = readUserSettings({ env, home, strict: true });
  const value = String(model || "").trim();
  const next = { ...settings };
  if (value) next[AUTO_REVIEW_MODEL_KEY] = value;
  else delete next[AUTO_REVIEW_MODEL_KEY];

  const changed = atomicWriteFileIfChangedSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return { changed, filePath, model: value || DEFAULT_CODEX_AUTO_REVIEW_MODEL };
}

export function writeTerminalAnimationTheme(theme, { env = process.env, home = os.homedir() } = {}) {
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
