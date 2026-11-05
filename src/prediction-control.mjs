import fs from "node:fs";
import { readPredictionSettings, predictionPaths, writePredictionSettings } from "./native-prediction-profile.mjs";
import { predictionDisplayPreference } from "./prediction-preference.mjs";
import { servicePreferences, writeServicePreference } from "./user-settings.mjs";
import { openCodex } from "./launcher.mjs";
import { withFileLock } from "./lock.mjs";
import { runPredictionOperation } from "./prediction-operations.mjs";

export function predictionControlSnapshot(options = {}) {
  const saved = readPredictionSettings(options);
  const fresh = !fs.existsSync(predictionPaths(options).settings), display = predictionDisplayPreference(options);
  return { configured: saved.enabled === true, enabled: servicePreferences(options).prediction_enabled && (!fresh || display.enabled),
    default: fresh, display,
    display_pending: saved.displayPending === true };
}

export async function controlPrediction(operation, { integration, nativeOperation = runPredictionOperation, ...options } = {}) {
  if (!["enable", "disable", "setup", "remove", "pause", "resume", "repair", "open"].includes(operation)) throw new Error("Unknown prediction operation");
  const settings = readPredictionSettings(options);
  if (operation === "repair" && !settings.displayPending) return integration?.fix() || { status: "needs_service" };
  if (operation === "open") {
    if (!integration) throw new Error("Start CCDX before opening Codex from this control");
    if (!settings.enabled) throw new Error("Enable predictions before opening Codex");
    if (settings.displayPending) {
      await nativeOperation("display", { ...options, enabled: servicePreferences(options).prediction_enabled, requireClosed: true });
      writePredictionSettings({ ...settings, displayPending: false }, options);
    }
    const native = await integration.start();
    if (!native) throw new Error("Prediction bridge is unavailable");
    await native.prepareRoute?.();
    return { opened: await openCodex({ predictionPacUrl: native.pacUrl, predictionApp: native.app, predictionProfile: native.profile,
      imageHost: await integration.imageHostLaunch?.({ env: { ...(options.env || process.env), CCDX_AUTO_LAUNCH: "1" } }),
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
    await nativeOperation("command", { ...options, action: "on" });
    reconfigured = true;
  } else if (operation === "remove") {
    integration?.setPredictionActive(false);
    await nativeOperation("command", { ...options, action: "off" });
    writeServicePreference("prediction_enabled", false, options);
  }
  const { pending } = await nativeOperation("display", { ...options, enabled });
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
