import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCodexToml } from "../src/config-toml.mjs";
import { predictionDisplayPreference, writePredictionDisplayPreference } from "../src/prediction-preference.mjs";
import { handlePredictionOperation } from "../src/prediction-operations.mjs";
import { controlPrediction } from "../src/prediction-control.mjs";
import { writePredictionSettings, readPredictionSettings } from "../src/native-prediction-profile.mjs";
import { servicePreferences } from "../src/user-settings.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-prediction-control-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".codex"));
  return { nativeOperation: handlePredictionOperation, home, env: {}, platform: "darwin", exec() { throw Object.assign(new Error("closed"), { status: 1 }); } };
}
const file = options => path.join(options.home, ".codex/config.toml");
const legacy = options => path.join(options.home, ".codex/.codex-global-state.json");
const KEY = "composer-predictions-enabled";

test("fresh prediction display uses the native enabled default without writing", t => {
  const options = fixture(t);
  assert.deepEqual(predictionDisplayPreference(options), { enabled: true, source: "default" });
  assert.deepEqual(fs.readdirSync(path.dirname(file(options))), []);
});

for (const text of [
  '# account text stays\nmodel = "example"\n[desktop]\ncomposer-predictions-enabled = false # user choice\nother = "中文"\n',
  'desktop.composer-predictions-enabled = false\n[other]\nvalue = 9007199254740993\n',
  'desktop = { composer-predictions-enabled = false, other = "保留" }\n[other]\nvalue = true\n',
  'desktop.other = "keep"\n[other]\nvalue = true\n',
]) test("enable/disable preserves unrelated TOML and legacy state: " + text.split("\n")[0], t => {
  const options = fixture(t);fs.writeFileSync(file(options), text);
  fs.writeFileSync(legacy(options), JSON.stringify({ unrelated: [1, "keep"], "electron-persisted-atom-state": { custom: 3, [KEY]: false } }));
  const original = parseCodexToml(text);
  for (const enabled of [true, false, true]) {
    writePredictionDisplayPreference(enabled, options);
    assert.equal(predictionDisplayPreference(options).enabled, enabled);
    const after = parseCodexToml(fs.readFileSync(file(options), "utf8"));
    assert.deepEqual(after.other, original.other);assert.equal(after.desktop.other, original.desktop.other);
    const state = JSON.parse(fs.readFileSync(legacy(options)));
    assert.deepEqual(state.unrelated, [1, "keep"]);assert.equal(state["electron-persisted-atom-state"].custom, 3);
    assert.equal(state["electron-persisted-atom-state"][KEY], enabled);
  }
});

test("running App and malformed settings cause no writes", t => {
  const options = fixture(t);fs.writeFileSync(file(options), "model = 'keep'\n");
  assert.throws(() => writePredictionDisplayPreference(true, { ...options, exec: () => "12" }), /Quit Codex/);
  assert.equal(fs.readFileSync(file(options), "utf8"), "model = 'keep'\n");
  fs.writeFileSync(legacy(options), '{"electron-persisted-atom-state":[]}');
  assert.throws(() => writePredictionDisplayPreference(true, options), /invalid/);
  assert.equal(fs.readFileSync(file(options), "utf8"), "model = 'keep'\n");
});

test("WebUI disable records a deferred native display update while the App runs", async t => {
  const options = fixture(t);writePredictionSettings({ version: 1, enabled: true }, options);
  const active = [];
  const result = await controlPrediction("disable", { ...options, exec: () => "12", integration: { setPredictionActive: value => active.push(value) } });
  assert.equal(result.display_pending, true);assert.equal(servicePreferences(options).prediction_enabled, false);
  assert.deepEqual(active, [false]);assert.equal(fs.existsSync(file(options)), false);
  await controlPrediction("disable", options);
  assert.equal(predictionDisplayPreference(options).enabled, false);assert.equal(readPredictionSettings(options).displayPending, false);
});

test("WebUI enable overrides an old disabled App preference and uses the shared bridge", async t => {
  const options = fixture(t);writePredictionSettings({ version: 1, enabled: true }, options);
  writePredictionDisplayPreference(false, options);const calls = [];
  await controlPrediction("enable", { ...options, integration: { setPredictionActive: value => calls.push(value), start: async () => calls.push("start"), fix: async () => calls.push("fix") } });
  assert.equal(predictionDisplayPreference(options).enabled, true);assert.deepEqual(calls, [true, "start", "fix"]);
});
