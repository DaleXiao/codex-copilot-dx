import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServiceControl } from "../src/service-control.mjs";
import { readUserSettings, writeServicePreference } from "../src/user-settings.mjs";
import { createAdapterHandler } from "../src/adapter.mjs";
import { invokeAdapter } from "../test-support/adapter.mjs";
import { controlPrediction } from "../src/prediction-control.mjs";
import { handlePredictionOperation } from "../src/prediction-operations.mjs";

function fixture(t, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-control-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let active = true;const themes = [], actions = [];
  const control = createServiceControl({ home, env, readImages: () => ({ api_key: "NEVER_EXPOSE" }), readPrediction: () => ({ enabled: true }),
    predictionControl: (operation, options) => controlPrediction(operation, { ...options, nativeOperation: handlePredictionOperation,
      platform: "darwin", exec() { throw Object.assign(new Error("fixture App closed"), { status: 1 }); } }),
    terminal: { apply: value => themes.push(value) }, clientIntegration: { snapshot: () => ({ prediction: { bridge: "running", active } }),
      setPredictionActive: value => { active = value; }, fix: async () => {} },
    providerRuntime: { snapshot: () => ({ codex_provider: "github", m365: { state: "ready" } }), action: async input => actions.push(input) } });
  return { control, home, env, themes, actions };
}
test("settings apply live flags while preserving configuration and report effective state", async t => {
  const f = fixture(t);const data = await f.control.action({ action: "preference", key: "prediction_enabled", value: false });
  assert.equal(data.saved.prediction_enabled, false);assert.equal(data.effective.prediction_enabled.value, false);
  assert.equal(data.effective.prediction_enabled.configured, true);
  assert.equal(readUserSettings(f).prediction_enabled, false);
  const image = await f.control.action({ action: "preference", key: "image_enabled", value: false });
  assert.equal(image.effective.image_enabled.configured, true);assert.equal(image.effective.image_enabled.value, false);
  assert.doesNotMatch(JSON.stringify(image), /NEVER_EXPOSE/);
  await f.control.action({ action: "animation", theme: "twin" });assert.equal(f.themes.at(-1).theme, "twin");
});
test("invalid controls and environment overrides do not silently mutate runtime", async t => {
  const f = fixture(t, { CCDX_TERMINAL_ANIMATION: "0", CCDX_M365: "0", CCDX_RESPONSE_HISTORY_MAX_BYTES: "67108864" });
  assert.equal(f.control.snapshot().effective.terminal_animation_enabled.locked, true);
  for (const input of [{ action: "preference", key: "unknown", value: true }, { action: "preference", key: "image_enabled", value: "yes" },
    { action: "animation", theme: "invalid" }, { action: "preference", key: "open_webui", value: false, extra: true },
    { action: "provider", operation: "on" }, { action: "history_limit", mib: 128 }]) await assert.rejects(f.control.action(input));
  assert.deepEqual(readUserSettings(f), {});assert.equal(f.actions.length, 0);
});
test("settings browser API requires loopback, a same-origin write, bounded JSON and a strict action", async t => {
  const f = fixture(t), options = { dashboardOptions: { serviceControl: f.control, env: {}, home: f.home } };
  const headers = { host: "127.0.0.1:2026", "x-ccdx-dashboard": "1", origin: "http://127.0.0.1:2026" };
  const body = { action: "preference", key: "open_webui", value: false };
  const result = await invokeAdapter(options, { url: "/_ccdx/ui/settings", headers, body });assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.text).saved.open_webui, false);
  for (const patch of [{ origin: "https://evil.invalid" }, { host: "evil.invalid" }, { "x-ccdx-dashboard": "0" }, { origin: "null" }]) {
    const denied = await invokeAdapter(options, { url: "/_ccdx/ui/settings", headers: { ...headers, ...patch }, body });assert.equal(denied.status, 403);
  }
  const invalid = await invokeAdapter(options, { url: "/_ccdx/ui/settings", headers, body: { ...body, value: "false" } });assert.equal(invalid.status, 400);
});
test("settings diagnostics expose process-local state and preserve the same-origin boundary", async t => {
  const f = fixture(t), calls = [];let state = { state: "off" };
  const control = createServiceControl({ home: f.home, env: {}, providerRuntime: { snapshot: () => ({}), errorCaptureSnapshot: () => state,
    captureUpstreamError(input) { calls.push(input);return state = { state: "armed" }; } } });
  const options = { dashboardOptions: { serviceControl: control, env: {}, home: f.home } }, body = { action: "error_capture", operation: "arm", source: "api_work", model: "model" };
  const headers = { host: "127.0.0.1:2026", "x-ccdx-dashboard": "1", origin: "http://127.0.0.1:2026" };
  assert.equal(control.snapshot().error_capture.state, "off");
  assert.equal((await invokeAdapter(options, { url: "/_ccdx/ui/settings", headers: { ...headers, origin: "https://evil.invalid" }, body })).status, 403);
  assert.equal(calls.length, 0);
  const result = await invokeAdapter(options, { url: "/_ccdx/ui/settings", headers, body });
  assert.equal(result.status, 200);assert.equal(JSON.parse(result.text).error_capture.state, "armed");assert.equal(calls.length, 1);
  await assert.rejects(control.action({ ...body, prompt: "not accepted" }));assert.equal(calls.length, 1);
});

test("generic preferences cannot activate masking before the model preparation transaction", async t => {
  const f = fixture(t), { settingsPreferencesSnapshot } = await import("../src/settings-preferences.mjs");
  await assert.rejects(f.control.action({ action: "preferences", values: { privacy_enabled: true }, revision: settingsPreferencesSnapshot({ home: f.home, env: {} }).revision }), { code: "ccdx_settings_privacy_action_required" });
  assert.equal(settingsPreferencesSnapshot({ home: f.home, env: {} }).values.privacy_enabled, false);
});

test("damaged saved settings cannot reopen paused optional capabilities", async t => {
  const f = fixture(t);await f.control.action({ action: "preference", key: "image_enabled", value: false });
  const { servicePreferences, userSettingsPath } = await import("../src/user-settings.mjs");
  fs.writeFileSync(userSettingsPath(f), "invalid json");
  assert.throws(() => servicePreferences(f), /Invalid ccdx settings/);
  assert.throws(() => f.control.snapshot(), /Invalid ccdx settings/);
});
test("animation effective state describes the actual terminal output mode", t => {
  const f = fixture(t);
  assert.equal(f.control.snapshot().effective.terminal_animation_enabled.value, false);
  assert.equal(f.control.snapshot().effective.terminal_animation_enabled.state, "terminal_unavailable");
});

test("terminal palette saves atomically and applies independently of animation", async t => {
  const f = fixture(t);
  await f.control.action({ action:"animation",theme:"twin" });
  const data=await f.control.action({action:"color_theme",theme:"klein"});
  assert.equal(data.color_theme,"klein");assert.equal(data.theme,"twin");
  assert.equal(f.themes.at(-1).color_theme,"klein");
  await assert.rejects(f.control.action({action:"color_theme",theme:"unknown"}));
  await assert.rejects(f.control.action({action:"color_theme",theme:"green",extra:true}));
  assert.equal(f.control.snapshot().color_theme,"klein");
});

test("queued UI changes preserve concurrent CLI preferences and recover after a refused action", async t => {
  const f = fixture(t);let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const applied = [];
  const control = createServiceControl({ home: f.home, env: {}, readImages: () => null, readPrediction: () => null,
    terminal: { apply: value => applied.push(value) }, providerRuntime: { snapshot: () => ({}), async action() { entered();await gate; } } });
  const provider = control.action({ action: "provider", operation: "on" });await started;
  const refused = assert.rejects(control.action({ action: "color_theme", theme: "unknown" }));
  const color = control.action({ action: "color_theme", theme: "pink" });
  const paused = control.action({ action: "preference", key: "image_enabled", value: false });
  writeServicePreference("open_webui", false, { home: f.home, env: {} });
  assert.equal(readUserSettings({ home: f.home, env: {} }).terminal_color_theme, undefined);
  release();await Promise.all([provider, refused, color, paused]);
  const saved = readUserSettings({ home: f.home, env: {} });
  assert.equal(saved.terminal_color_theme, "pink");assert.equal(saved.open_webui, false);assert.equal(saved.image_enabled, false);
  assert.equal(applied[0].color_theme, "pink");
});

test("image host evidence is accepted while a restart operation is waiting", async t => {
  const f = fixture(t);let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const control = createServiceControl({ home: f.home, env: {}, readImages: () => false, readPrediction: () => ({ enabled: false }),
    imageHostControl: async () => { entered();await gate;return { status: "opened_new_chat_required" }; } });
  const restart = control.action({ action: "image", operation: "restart", confirmed: true });await started;
  const evidence = await control.action({ action: "image", operation: "report", evidence: { id: "11111111-1111-1111-1111-111111111111", pid: process.pid, event: "connected" } });
  assert.equal(evidence.features.image.runtime.connected, true);
  release();assert.equal((await restart).last_operation.result.status, "opened_new_chat_required");
});

test("version refresh is acknowledged without waiting for inspection or other settings actions", async t => {
  const f = fixture(t);let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const versions = { snapshot: () => ({ checked_at: null, codex: [], claude: [] }), refresh: async () => { entered();await gate; } };
  const control = createServiceControl({ home: f.home, env: {}, clientVersions: versions, readImages: () => false, readPrediction: () => ({ enabled: false }) });
  const result = await control.action({ action: "client_versions" });assert.equal(result.scheduled, true);await started;
  assert.equal((await control.action({ action: "preference", key: "open_webui", value: false })).saved.open_webui, false);
  assert.deepEqual(control.snapshot().client_versions, versions.snapshot());
  await assert.rejects(control.action({ action: "client_versions", extra: true }), /Unknown/);release();
});

test("shared Codex restart forwards explicit intent and accepts host evidence while waiting", async t => {
  const f = fixture(t);let entered, release, received;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const control = createServiceControl({ home: f.home, env: {}, readImages: () => false, readPrediction: () => ({ enabled: false }),
    codexLaunchControl: async (operation, options) => { received = { operation, intent: options.intent, confirmed: options.confirmed };
      entered();await gate;return { status: "opened_new_chat_required" }; } });
  const restart = control.action({ action: "codex_app", operation: "restart", intent: "prediction", confirmed: true });await started;
  const evidence = await control.action({ action: "image", operation: "report", evidence: { id: "11111111-1111-1111-1111-111111111111", pid: process.pid, event: "connected" } });
  assert.equal(evidence.features.image.runtime.connected, true);
  release();assert.equal((await restart).last_operation.result.status, "opened_new_chat_required");
  assert.deepEqual(received, { operation: "restart", intent: "prediction", confirmed: true });
  await assert.rejects(control.action({ action: "codex_app", operation: "restart", intent: "prediction", confirmed: true, extra: true }), /Unknown/);
});

test('nightly updates default off, require a boolean and do not enable other service features', async t => {
 const f=fixture(t);assert.equal(f.control.snapshot().nightly_update.enabled,false);
 await f.control.action({action:'preference',key:'image_enabled',value:false});
 const enabled=await f.control.action({action:'nightly_update',enabled:true});assert.equal(enabled.nightly_update.enabled,true);assert.equal(enabled.nightly_update.effect,'next_start');
 assert.equal(enabled.saved.image_enabled,false);await assert.rejects(f.control.action({action:'nightly_update',enabled:'true'}));
 await f.control.action({action:'nightly_update',enabled:false});assert.equal(f.control.snapshot().nightly_update.enabled,false);
});
