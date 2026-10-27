import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { settingsPreferencesSnapshot, writeSettingsPreferences, settingsBackupPath, SETTINGS_DEFAULTS } from "../src/settings-preferences.mjs";
import { userSettingsPath, readUserSettings } from "../src/user-settings.mjs";
import { createServiceControl } from "../src/service-control.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-preferences-")), options = { home, env: {} }, file = userSettingsPath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(file, JSON.stringify({ terminal_color_theme: "pink", terminal_animation: "stack", auto_save_settings: false,
    image_enabled: false, prediction_enabled: false, auto_review_model: "gpt-private", future_setting: { credential: "NEVER_BACK_UP" } }));
  const run = (action, extra = {}) => writeSettingsPreferences({ action, revision: settingsPreferencesSnapshot(options).revision, ...extra }, options);
  return { options, file, run };
}
test("reset and restore only the settings-page allowlist, with a private pre-reset backup", t => {
  const f = fixture(t), before = readUserSettings(f.options), id = randomUUID();
  f.run("reset_preferences", { backup_id: id });
  assert.deepEqual(settingsPreferencesSnapshot(f.options).values, SETTINGS_DEFAULTS);
  const reset = readUserSettings(f.options);
  for (const key of ["image_enabled", "prediction_enabled", "auto_review_model", "future_setting"]) assert.deepEqual(reset[key], before[key]);
  const raw = fs.readFileSync(settingsBackupPath(f.options), "utf8");assert.doesNotMatch(raw, /NEVER_BACK_UP|gpt-private|prediction_enabled|future_setting/);
  assert.equal(settingsPreferencesSnapshot(f.options).backup.id, id);
  if (process.platform !== "win32") assert.equal(fs.statSync(settingsBackupPath(f.options)).mode & 0o777, 0o600);
  f.run("restore_preferences", { backup_id: id });
  assert.equal(readUserSettings(f.options).terminal_color_theme, "pink");assert.equal(readUserSettings(f.options).auto_save_settings, false);
  assert.equal(readUserSettings(f.options).prediction_enabled, false);
});
test("stale writers are refused, unknown fields cannot be reset, and a lost reset response can be retried", t => {
  const f = fixture(t), original = settingsPreferencesSnapshot(f.options), id = randomUUID();
  f.run("preferences", { values: { open_webui: false } });
  assert.throws(() => writeSettingsPreferences({ action: "reset_preferences", revision: original.revision, backup_id: id }, f.options), { code: "ccdx_settings_changed" });
  f.run("reset_preferences", { backup_id: id });const backup = fs.readFileSync(settingsBackupPath(f.options), "utf8");
  writeSettingsPreferences({ action: "reset_preferences", revision: original.revision, backup_id: id }, f.options);
  assert.equal(fs.readFileSync(settingsBackupPath(f.options), "utf8"), backup);
  for (const values of [{ image_enabled: true }, { terminal_animation: "unknown" }, { auto_save_settings: "false" }]) assert.throws(() => f.run("preferences", { values }));
  assert.equal(readUserSettings(f.options).image_enabled, false);
});
test("unreadable configuration or backups never become a destructive reset", t => {
  const f = fixture(t), revision = settingsPreferencesSnapshot(f.options).revision;
  fs.writeFileSync(f.file, "broken");assert.throws(() => writeSettingsPreferences({ action: "reset_preferences", revision, backup_id: randomUUID() }, f.options));
  assert.equal(fs.readFileSync(f.file, "utf8"), "broken");
  fs.writeFileSync(f.file, "{}");fs.writeFileSync(settingsBackupPath(f.options), "broken backup");
  assert.equal(settingsPreferencesSnapshot(f.options).backup_error, "ccdx_settings_backup_invalid");
  assert.throws(() => f.run("reset_preferences", { backup_id: randomUUID() }), { code: "ccdx_settings_backup_invalid" });
  assert.equal(fs.readFileSync(settingsBackupPath(f.options), "utf8"), "broken backup");
});
test("a failed settings commit restores both the previous preferences and previous backup", t => {
  const f = fixture(t);f.run("reset_preferences", { backup_id: randomUUID() });f.run("preferences", { values: { terminal_color_theme: "klein" } });
  const backupPath = settingsBackupPath(f.options), before = [f.file, backupPath].map(file => fs.readFileSync(file, "utf8"));
  const rename = fs.renameSync;let refuse = true;
  fs.renameSync = (from, to) => { if (to === f.file && refuse) { refuse = false;throw Object.assign(Error("fixture write denied"), { code: "EACCES" }); }return rename(from, to); };
  try { assert.throws(() => f.run("reset_preferences", { backup_id: randomUUID() }), /fixture write denied/); } finally { fs.renameSync = rename; }
  assert.deepEqual([f.file, backupPath].map(file => fs.readFileSync(file, "utf8")), before);
});
test("batch application updates the terminal without touching routing, sign-in or feature access", async t => {
  const f = fixture(t), applied = [], updates = [];
  const control = createServiceControl({ ...f.options, terminal: { apply: value => applied.push(value) }, nightlyChanged: value => updates.push(value),
    providerRuntime: { snapshot: () => ({ codex_provider: "github" }), action: () => assert.fail("Routing must not change") },
    clientIntegration: { snapshot: () => ({}), setPredictionActive: () => assert.fail("Prediction must not change") }, readImages: () => null, readPrediction: () => ({}) });
  const value = await control.action({ action: "preferences", revision: control.snapshot().preferences.revision,
    values: { terminal_color_theme: "klein", terminal_animation: "twin", nightly_updates: true } });
  assert.equal(value.preferences.values.auto_save_settings, false);assert.equal(applied.at(-1).theme, "twin");assert.deepEqual(updates, [true]);
  await control.action({ action: "reset_preferences", revision: value.preferences.revision, backup_id: randomUUID() });
  assert.deepEqual(updates, [true, false]);assert.equal(readUserSettings(f.options).image_enabled, false);
});
