import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPredictionOperation } from "../src/prediction-operations.mjs";
import { writePredictionSettings } from "../src/native-prediction-profile.mjs";

test("native configuration executes off the gateway event loop and keeps failures bounded", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-prediction-operations-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));fs.mkdirSync(path.join(home, ".codex"));
  let ticks = 0;const timer = setInterval(() => ticks++, 1);
  try {
    const result = await runPredictionOperation("display", { home, env: {}, enabled: false });
    assert.equal(typeof result.pending, "boolean");assert.ok(ticks > 0, "native discovery must not block main-thread timers");
    await assert.rejects(runPredictionOperation("invalid", { home, env: {} }), /Unknown/);
    assert.equal(fs.existsSync(path.join(home, ".codex/auth.json")), false);
  } finally { clearInterval(timer); }
});

test("disabled startup avoids App/proxy discovery and creates no configuration", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-prediction-disabled-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = await runPredictionOperation("startup", { home, env: {}, autoSetup: false });
  assert.deepEqual(result, { configured: false });assert.deepEqual(fs.readdirSync(home), []);
});

test("private proxy URLs and bypass data survive the work-thread boundary", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-prediction-proxy-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const options = { home, env: { HTTPS_PROXY: "https://fixture-user:fixture-secret@proxy.example.test:8080", NO_PROXY: "10.0.0.0/8,example.test" }, platform: "linux", autoSetup: false };
  writePredictionSettings({ version: 1, enabled: true }, options);
  const result = await runPredictionOperation("startup", options), plan = result.environment.network.networkRoute;
  assert.ok(plan.https.url instanceof URL);assert.equal(plan.https.url.href, options.env.HTTPS_PROXY + "/");
  assert.deepEqual(plan.bypass, ["10.0.0.0/8", "example.test"]);
  assert.doesNotMatch(JSON.stringify(result.environment.summary), /fixture-secret|fixture-user/);
});
