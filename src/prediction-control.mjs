import fs from "node:fs";
import { readPredictionSettings, predictionPaths, writePredictionSettings, assertCodexClosed } from "./native-prediction-profile.mjs";
import { runPredictionCommand } from "./native-prediction.mjs";
import { predictionDisplayPreference, writePredictionDisplayPreference } from "./prediction-preference.mjs";
import { servicePreferences, writeServicePreference } from "./user-settings.mjs";
import { openCodex } from "./launcher.mjs";
import { withFileLock } from "./lock.mjs";

export function predictionControlSnapshot(options = {}) {
  const saved = readPredictionSettings(options);
  const fresh = !fs.existsSync(predictionPaths(options).settings), display = predictionDisplayPreference(options);
  return { configured: saved.enabled === true, enabled: servicePreferences(options).prediction_enabled && (!fresh || display.enabled),
    default: fresh, display,
    display_pending: saved.displayPending === true };
}

export async function controlPrediction(operation, { integration, ...options } = {}) {
  if (!["enable", "disable", "setup", "remove", "pause", "resume", "repair", "open"].includes(operation)) throw new Error("Unknown prediction operation");
  const settings = readPredictionSettings(options);
  if (operation === "repair" && !settings.displayPending) return integration?.fix() || { status: "needs_service" };
  if (operation === "open") {
    if (!integration) throw new Error("Start CCDX before opening Codex from this control");
    if (!settings.enabled) throw new Error("Enable predictions before opening Codex");
    if (settings.displayPending) {
      writePredictionDisplayPreference(servicePreferences(options).prediction_enabled, options);
      writePredictionSettings({ ...settings, displayPending: false }, options);
    }
    const native = await integration.start();
    if (!native) throw new Error("Prediction bridge is unavailable");
    await native.prepareRoute?.();
    return { opened: await openCodex({ predictionPacUrl: native.pacUrl, predictionApp: native.app, predictionProfile: native.profile,
      env: { ...(options.env || process.env), CCDX_AUTO_LAUNCH: "1" }, persistedPredictionRoute: false,
      preparePredictionRoute: () => native.prepareRoute?.(), onPredictionRoute: value => integration.launched(value) }) };
  }
  const enabled = operation === "repair" ? servicePreferences(options).prediction_enabled : ["enable", "setup", "resume"].includes(operation);
  let reconfigured = false;
  if (operation === "resume" && !settings.enabled) {
    writeServicePreference("prediction_enabled", true, options);
    return { ...predictionControlSnapshot(options), status: "needs_setup" };
  }
  if (enabled && (!settings.enabled || operation === "setup")) {
    await runPredictionCommand({ ...options, action: "on", output() {} });
    reconfigured = true;
  } else if (operation === "remove") {
    integration?.setPredictionActive(false);
    await runPredictionCommand({ ...options, action: "off", output() {} });
    writeServicePreference("prediction_enabled", false, options);
  }
  let pending = false;
  try { assertCodexClosed(options); }
  catch (error) {
    if (!/Quit Codex/.test(error.message)) throw error;
    pending = true;
  }
  if (!pending) writePredictionDisplayPreference(enabled, options);
  writeServicePreference("prediction_enabled", enabled, options);
  await withFileLock(`${predictionPaths(options).settings}.lock`, () => {
    writePredictionSettings({ ...readPredictionSettings(options), displayPending: pending }, options);
  });
  integration?.setPredictionActive(enabled);
  let runtime;
  if (enabled && integration) {
    if (reconfigured) await integration.pauseForUpdate?.();
    await integration.start();
    runtime = await integration.fix();
  }
  if (operation === "repair" && integration) return integration.fix();
  return { ...predictionControlSnapshot(options), status: pending ? "needs_app_close" : runtime?.status || (!integration ? "next_start" : enabled ? "configured" : "disabled"),
    ...(runtime?.prediction ? { bridge: runtime.prediction.bridge } : {}) };
}
