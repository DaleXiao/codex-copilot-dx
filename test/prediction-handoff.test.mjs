import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clientStateFingerprint } from "../src/service-worker.mjs";
import { writePredictionSettings } from "../src/native-prediction-profile.mjs";
import { createClientIntegration } from "../src/client-integration.mjs";

test("handoff fingerprints preserve prediction intent and trust while allowing runtime bookkeeping", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-prediction-handoff-")), options = { home, env: {} };
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const initial = clientStateFingerprint(options);
  const preference = { version: 1, enabled: true, store: "fixture-store", certificateHash: "fixture-hash", app: { app: "fixture-app", profile: "fixture-profile" } };
  writePredictionSettings(preference, options);const configured = clientStateFingerprint(options);assert.notEqual(configured, initial);
  writePredictionSettings({ ...preference, bridgePort: 23456, app: { ...preference.app, size: 100, mtimeMs: 200 } }, options);
  assert.equal(clientStateFingerprint(options), configured);
  writePredictionSettings({ ...preference, certificateHash: "new-trust" }, options);assert.notEqual(clientStateFingerprint(options), configured);
  writePredictionSettings({ ...preference, enabled: false }, options);assert.notEqual(clientStateFingerprint(options), configured);
});

test("repair and handoff never initialize a fresh integration; normal startup can", async () => {
  const calls = [], integration = createClientIntegration({ startPrediction: async options => { calls.push(options.autoSetup);return null; } });
  try {
    await integration.start({ autoSetup: false });await integration.fix();await integration.start();
    assert.deepEqual(calls, [false, false, true]);
  } finally { await integration.close(); }
});
