import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { controlCodexLaunch } from "../src/codex-launch-control.mjs";
import { readPredictionSettings, writePredictionSettings } from "../src/native-prediction-profile.mjs";
import { writeServicePreference } from "../src/user-settings.mjs";

function fixture(t, { image = false, prediction = true, pending = true, host = "connected", displayFails = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-launch-shared-")), env = {}, app = "/Applications/ChatGPT.app", actions = [];
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writePredictionSettings({ version: 1, enabled: prediction, displayPending: pending }, { home, env });
  writeServicePreference("prediction_enabled", prediction, { home, env });
  let checks = 0, clock = 0, quits = 0, opened = 0;
  const native = prediction ? { app, pacUrl: "http://127.0.0.1:1234/proxy.pac?v=2", prepareRoute: async () => { actions.push("route"); } } : null;
  const options = { home, env, platform: "darwin", confirmed: true, readSummary: () => ({ enabled: image, configured: image, selected_available: image }),
    integration: { configure: async () => { actions.push("configure"); }, start: async () => { actions.push("prediction");return native; }, pacUrl: () => native?.pacUrl },
    discover: async () => ({ app }), prepare: async () => { actions.push("image");return { app, env: { CODEX_CLI_PATH: "owned" } }; },
    inspect: async () => ++checks < 3 ? { status: "running", pid: 123, host, prediction_route: "verified" } : { status: "stopped" },
    appControl: async (_app, _pid, operation) => { actions.push(operation);quits++;return "sent"; },
    nativeOperation: async (_operation, input) => { actions.push("display");assert.equal(quits, 1);assert.equal(input.requireClosed, true);if (displayFails) throw Error("fixture");return { pending: false }; },
    wait: async ms => { clock += ms; }, now: () => clock,
    launch: async value => { actions.push("launch");opened++;assert.equal(value.imageHost?.env.CODEX_CLI_PATH || null, image ? "owned" : null);
      assert.equal(value.predictionPacUrl || null, native?.pacUrl || null);return true; } };
  return { home, env, options, actions, counts: () => ({ quits, opened }) };
}

test("prediction restart works with images disabled and applies pending display only after exit", async t => {
  const f = fixture(t), result = await controlCodexLaunch("restart", { ...f.options, intent: "prediction" });
  assert.equal(result.status, "opened_new_chat_required");assert.equal(readPredictionSettings(f).displayPending, false);
  assert.deepEqual(f.actions, ["configure", "prediction", "route", "quit", "display", "launch"]);
  assert.deepEqual(f.counts(), { quits: 1, opened: 1 });
});

test("an already-connected image host does not block a pending prediction restart", async t => {
  const f = fixture(t, { image: true, host: "connected", pending: true });
  const result = await controlCodexLaunch("restart", { ...f.options, intent: "prediction" });
  assert.equal(result.status, "opened_new_chat_required");assert.equal(f.counts().quits, 1);
  assert.deepEqual(f.actions, ["configure", "image", "prediction", "route", "quit", "display", "launch"]);
});

test("images can restart while prediction is disabled, without enabling it", async t => {
  const f = fixture(t, { image: true, prediction: false, pending: false, host: "unconfirmed" });
  const result = await controlCodexLaunch("restart", { ...f.options, intent: "image" });
  assert.equal(result.status, "opened_new_chat_required");assert.equal(readPredictionSettings(f).enabled, false);
  assert.equal(f.counts().quits, 1);assert.ok(!f.actions.includes("display"));
});

test("failed post-close display setup stays pending but the prepared App is reopened", async t => {
  const f = fixture(t, { displayFails: true });
  const result = await controlCodexLaunch("restart", { ...f.options, intent: "prediction" });
  assert.equal(result.status, "opened_with_pending");assert.equal(result.prediction_pending, true);
  assert.equal(readPredictionSettings(f).displayPending, true);assert.equal(f.counts().opened, 1);
});

test("an unavailable image account does not block prediction setup and is reported as pending", async t => {
  const f = fixture(t, { image: true, host: "connected" });
  const result = await controlCodexLaunch("restart", { ...f.options, intent: "prediction",
    readSummary: () => ({ enabled: true, configured: false, selected_available: false }) });
  assert.equal(result.status, "opened_with_pending");assert.equal(result.image_pending, true);assert.equal(f.counts().opened, 1);
});

test("a display operation that remains pending is never marked complete", async t => {
  const f = fixture(t);
  const result = await controlCodexLaunch("restart", { ...f.options, intent: "prediction", nativeOperation: async () => ({ pending: true }) });
  assert.equal(result.status, "opened_with_pending");assert.equal(result.prediction_pending, true);
  assert.equal(readPredictionSettings(f).displayPending, true);assert.equal(f.counts().opened, 1);
});

test("ordinary open or failed preflight never quits a running App", async t => {
  const f = fixture(t);
  assert.equal((await controlCodexLaunch("open", { ...f.options, intent: "prediction" })).status, "needs_app_relaunch");
  assert.equal(f.counts().quits, 0);
  await assert.rejects(controlCodexLaunch("restart", { ...f.options, intent: "prediction", confirmed: false }), /Confirm/);
  assert.equal(f.counts().quits, 0);
});
