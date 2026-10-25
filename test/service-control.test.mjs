import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServiceControl } from "../src/service-control.mjs";
import { readUserSettings, writeServicePreference } from "../src/user-settings.mjs";
import { createAdapterHandler } from "../src/adapter.mjs";
import { invokeAdapter } from "../test-support/adapter.mjs";

function fixture(t, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-control-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let active = true;const themes = [], actions = [];
  const control = createServiceControl({ home, env, readImages: () => ({ api_key: "NEVER_EXPOSE" }), readPrediction: () => ({ enabled: true }),
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

test('nightly updates default off, require a boolean and do not enable other service features', async t => {
 const f=fixture(t);assert.equal(f.control.snapshot().nightly_update.enabled,false);
 await f.control.action({action:'preference',key:'image_enabled',value:false});
 const enabled=await f.control.action({action:'nightly_update',enabled:true});assert.equal(enabled.nightly_update.enabled,true);assert.equal(enabled.nightly_update.effect,'next_start');
 assert.equal(enabled.saved.image_enabled,false);await assert.rejects(f.control.action({action:'nightly_update',enabled:'true'}));
 await f.control.action({action:'nightly_update',enabled:false});assert.equal(f.control.snapshot().nightly_update.enabled,false);
});
