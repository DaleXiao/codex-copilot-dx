import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readUserSettings, userSettingsPath } from "./user-settings.mjs";
import { isColorTheme } from "./terminal-colors.mjs";
import { DEFAULT_TERMINAL_ANIMATION_THEME, isTerminalAnimationTheme } from "./terminal-animation.mjs";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { atomicWriteFileIfChangedSync, atomicWriteFilePairSync } from "./atomic-file.mjs";
import { withFileLockSync } from "./lock.mjs";

export const SETTINGS_DEFAULTS = Object.freeze({ terminal_color_theme: "green", terminal_animation: DEFAULT_TERMINAL_ANIMATION_THEME,
  terminal_animation_enabled: true, open_webui: true, nightly_updates: false, auto_save_settings: true, privacy_enabled: false, privacy_personal: false });
const keys = Object.keys(SETTINGS_DEFAULTS);
const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const idValid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const valuesFor = settings => Object.fromEntries(keys.map(key => [key, key === "terminal_animation" && !isTerminalAnimationTheme(settings[key])
  ? SETTINGS_DEFAULTS[key] : settings[key] ?? SETTINGS_DEFAULTS[key]]));
const revisionFor = values => createHash("sha256").update(JSON.stringify(keys.map(key => values[key]))).digest("hex");
export const settingsBackupPath = options => path.join(path.dirname(userSettingsPath(options)), options?.backupScope === "service" ? "service-settings-preferences-backup.json" : "settings-preferences-backup.json");

export function checkedPreferenceValues(values) {
  if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).some(key => !keys.includes(key)
    || (key === "terminal_color_theme" ? !isColorTheme(values[key]) : key === "terminal_animation" ? !isTerminalAnimationTheme(values[key]) : typeof values[key] !== "boolean"))) {
    throw fail("ccdx_settings_values_invalid", "Choose valid settings on this page", 400);
  }
  return values;
}
function readBackup(options) {
  try {
    const value = JSON.parse(readBoundedFileSync(settingsBackupPath(options), { encoding: "utf8", maxBytes: 8192 }));
    if (value?.version !== 1 || !idValid(value.id) || typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))
      || Object.keys(value).some(key => !["version", "id", "created_at", "values"].includes(key))
      || keys.filter(key => !key.startsWith("privacy_")).some(key => !Object.hasOwn(value.values || {}, key))) throw Error();
    value.values = { privacy_enabled: false, privacy_personal: false, ...value.values };
    checkedPreferenceValues(value.values);return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw fail("ccdx_settings_backup_invalid", "The settings backup could not be read; existing files were preserved");
  }
}
export function settingsPreferencesSnapshot(options = {}) {
  const values = valuesFor(readUserSettings({ ...options, strict: true }));
  let backup = null, backup_error = null;
  try { const saved = readBackup(options);if (saved) backup = { id: saved.id, created_at: saved.created_at }; }
  catch (error) { backup_error = error.code; }
  return { values, defaults: SETTINGS_DEFAULTS, revision: revisionFor(values), backup, backup_error };
}

// Only this page's preferences enter its backup. Routing, auth, business flags
// and unknown settings are retained in the current file, never copied here.
export function writeSettingsPreferences(input, options = {}) {
  if (input.scope !== undefined && (!["reset_preferences", "restore_preferences"].includes(input.action) || input.scope !== "service")) throw fail("ccdx_settings_action_invalid", "Unknown backup scope", 400);
  if (input.scope === "service") options = { ...options, backupScope: "service" };
  const file = userSettingsPath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withFileLockSync(`${file}.lock`, () => {
    const current = readUserSettings({ ...options, strict: true }), before = valuesFor(current);
    const backup = input.action === "preferences" ? null : readBackup(options);
    if (input.action === "reset_preferences" && backup?.id === input.backup_id && revisionFor(before) === revisionFor(SETTINGS_DEFAULTS)) return;
    if (typeof input.revision !== "string" || input.revision !== revisionFor(before)) {
      throw fail("ccdx_settings_changed", "Settings changed elsewhere. Review the current settings before saving again");
    }
    let values;
    if (input.action === "preferences") values = checkedPreferenceValues(input.values);
    else {
      if (!idValid(input.backup_id)) throw fail("ccdx_settings_backup_invalid", "Choose the current settings backup", 400);
      if (input.action === "restore_preferences") {
        if (!backup || input.backup_id !== backup.id) throw fail("ccdx_settings_changed", "The settings backup changed. Review it before restoring");
        values = backup.values;
      } else if (input.action === "reset_preferences") values = SETTINGS_DEFAULTS;
      else throw fail("ccdx_settings_action_invalid", "Unknown settings action", 400);
    }
    const next = { ...current, ...values }, data = `${JSON.stringify(next, null, 2)}\n`;
    if (input.action === "reset_preferences") {
      const saved = { version: 1, id: input.backup_id, created_at: new Date().toISOString(), values: before };
      atomicWriteFilePairSync(settingsBackupPath(options), `${JSON.stringify(saved, null, 2)}\n`, file, data);
    } else atomicWriteFileIfChangedSync(file, data, { mode: 0o600 });
  });
}
