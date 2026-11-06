import { prepareImageHostLaunch } from "./codex-image-host-launch.mjs";
import { imageSetupSummary } from "./image-setup.mjs";
import { openCodex } from "./launcher.mjs";
import { installedPredictionApp } from "./native-prediction-app.mjs";
import { inspectCodexApp, controlCodexApp } from "./codex-app-control.mjs";
import { predictionControlSnapshot } from "./prediction-control.mjs";
import { predictionPaths, readPredictionSettings, writePredictionSettings } from "./native-prediction-profile.mjs";
import { servicePreferences } from "./user-settings.mjs";
import { runPredictionOperation } from "./prediction-operations.mjs";
import { withFileLock } from "./lock.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const publicAppState = value => ({ status: value.status, ...(value.host ? { host: value.host } : {}),
  ...(value.tool_registration ? { tool_registration: value.tool_registration } : {}),
  ...(value.prediction_route ? { prediction_route: value.prediction_route } : {}),
  ...(typeof value.needs_restart === "boolean" ? { needs_restart: value.needs_restart } : {}) });

async function applyPendingPrediction(options, nativeOperation) {
  try {
    if (!readPredictionSettings(options).displayPending) return true;
    const enabled = servicePreferences(options).prediction_enabled;
    const result = await nativeOperation("display", { ...options, enabled, requireClosed: true });
    if (result?.pending !== false) return false;
    return await withFileLock(`${predictionPaths(options).settings}.lock`, () => {
      const current = readPredictionSettings(options);
      if (!current.displayPending) return true;
      if (servicePreferences(options).prediction_enabled !== enabled) return false;
      writePredictionSettings({ ...current, displayPending: false }, options);return true;
    });
  } catch { return false; }
}

export async function controlCodexLaunch(operation, { intent = "image", integration, state, host, port, models = [],
  prepare = prepareImageHostLaunch, launch = openCodex, readSummary = imageSetupSummary,
  readPrediction = predictionControlSnapshot, nativeOperation = runPredictionOperation,
  discover = installedPredictionApp, inspect = inspectCodexApp, appControl = controlCodexApp,
  confirmed = false, wait = sleep, now = Date.now, quitTimeoutMs = 10000, ...options } = {}) {
  if (!["check", "repair", "open", "focus", "restart"].includes(operation) || !["image", "prediction"].includes(intent)) throw new Error("Unknown Codex App control");
  if (operation === "restart" && confirmed !== true) throw new Error("Confirm that restarting Codex can interrupt its running tasks");
  const platform = options.platform || process.platform;
  let image, prediction;
  try { image = readSummary({ ...options, models }); }
  catch { image = { enabled: servicePreferences(options).image_enabled, configured: false, selected_available: false, availability: "unavailable" }; }
  try { prediction = readPrediction(options); }
  catch { prediction = { enabled: false, configured: false, status: "unavailable" }; }
  const runtime = () => state?.snapshot();
  const inspectApp = async app => {
    const current = await inspect(app, runtime()?.hosts || [], { ...options, predictionPacUrl: integration?.pacUrl?.() });
    if (current.status === "running") {
      const imagePending = image.enabled && image.configured && image.selected_available && current.host !== "connected";
      const predictionPending = prediction.display_pending || prediction.configured && prediction.enabled && current.prediction_route !== "verified";
      current.needs_restart = Boolean(imagePending || predictionPending);
    }
    return current;
  };
  if (operation === "check") {
    let app = { status: platform === "darwin" ? "unknown" : "unsupported" };
    if (platform === "darwin") try { app = await inspectApp((await discover(options)).app); } catch { /* Unknown is not stopped. */ }
    return { status: "checked", app: publicAppState(app), prediction, image: { enabled: image.enabled, availability: image.availability } };
  }
  if (operation === "focus") {
    if (platform !== "darwin") return { status: "unsupported", app: { status: "unsupported" } };
    let app, current;
    try { app = (await discover(options)).app;current = await inspectApp(app); }
    catch { return { status: "app_check_failed", app: { status: "unknown" } }; }
    if (current.status !== "running") return { status: "app_not_running", app: publicAppState(current) };
    let result;
    try { result = await appControl(app, current.pid, "activate", options); }
    catch { return { status: "focus_unavailable", app: { status: "unknown" } }; }
    return { status: result === "sent" ? "focused" : "focus_unavailable", app: result === "sent" ? publicAppState(current) : { status: "unknown" } };
  }
  if (!integration) throw new Error("Start CCDX before opening Codex from this control");
  if (intent === "image" && !image.enabled) throw new Error("Enable images before repairing image access");
  if (intent === "prediction" && !prediction.configured && !prediction.display_pending) throw new Error("Enable predictions before opening Codex");
  const env = { ...(options.env || process.env), CCDX_AUTO_LAUNCH: "1" };
  await integration.configure();
  let imageHost = null, imagePrepFailed = false, imageWarning = intent === "prediction" && image.enabled && (!image.configured || !image.selected_available);
  if (image.enabled) {
    try { imageHost = await prepare({ ...options, env, host, port }); }
    catch (error) { if (intent === "image") throw error;imageWarning = true;imagePrepFailed = true; }
    if (!imageHost) { if (intent === "image") return { status: "unsupported", prepared: false };imageWarning = true;imagePrepFailed = true; }
  }
  let app = imageHost?.app;
  if (!app) { try { app = (await discover(options)).app; } catch { return { status: "app_check_failed", prepared: false }; } }
  let current;
  try { current = await inspectApp(app); } catch { return { status: "app_check_failed", prepared: true }; }
  if (current.status === "unsupported") return { status: "unsupported", prepared: true };
  if (current.status === "multiple") return { status: "multiple_apps", prepared: true, app: publicAppState(current) };
  if (!["running", "stopped"].includes(current.status)) return { status: "app_check_failed", prepared: true };
  if (operation !== "restart" && current.status === "running") return { status: current.needs_restart ? "needs_app_relaunch" : "already_connected",
    prepared: true, runtime: runtime(), app: publicAppState(current) };
  if (operation === "repair") return { status: "prepared", prepared: true, runtime: runtime(), app: publicAppState(current) };
  if (operation === "restart" && intent === "image" && (!image.configured || !image.selected_available)) return { status: "image_unavailable", prepared: true, app: publicAppState(current) };
  if (operation === "restart" && current.status === "running" && !current.needs_restart) return { status: "already_connected", prepared: true, app: publicAppState(current) };
  // Never lose a currently connected image host due to a failed preparation.
  if (imagePrepFailed && current.status === "running" && current.host === "connected") return { status: "image_unavailable", prepared: true, app: publicAppState(current) };
  const native = await integration.start();
  if (prediction.status === "unavailable") return { status: "prediction_unavailable", prepared: true, app: publicAppState(current) };
  if (!native && prediction.configured && prediction.enabled) return { status: "prediction_unavailable", prepared: true, app: publicAppState(current) };
  await native?.prepareRoute?.();
  if (native?.pacUrl && native.app && native.app !== app) return { status: "app_route_conflict", prepared: true };
  if (operation === "restart") {
    const previous = current;
    try { current = await inspectApp(app); } catch { return { status: "app_check_failed", prepared: true }; }
    if (current.status === "running" && !current.needs_restart) return { status: "already_connected", prepared: true, app: publicAppState(current) };
    if (!["running", "stopped"].includes(current.status) || current.status === "running" && (previous.status !== "running" || current.pid !== previous.pid)) {
      return { status: "app_changed", prepared: true, app: publicAppState(current) };
    }
    if (current.status === "running") {
      const originalPid = current.pid;
      let requested;
      try { requested = await appControl(app, originalPid, "quit", options); }
      catch { return { status: "quit_refused", prepared: true, app: publicAppState(current) }; }
      if (!["sent", "absent"].includes(requested)) return { status: "quit_refused", prepared: true, app: publicAppState(current) };
      const deadline = now() + quitTimeoutMs;
      do {
        try { current = await inspectApp(app); } catch { return { status: "app_check_failed", prepared: true }; }
        if (current.status === "stopped") break;
        if (current.status !== "running" || current.pid !== originalPid) return { status: "app_changed", prepared: true, app: publicAppState(current) };
        if (now() >= deadline) return { status: "quit_timeout", prepared: true, app: publicAppState(current) };
        await wait(Math.min(250, Math.max(1, deadline - now())));
      } while (true);
    }
  }
  const predictionReady = await applyPendingPrediction(options, nativeOperation);
  const opened = await launch({ env, imageHost, predictionPacUrl: native?.pacUrl, predictionApp: native?.app,
    predictionProfile: native?.profile, preparePredictionRoute: () => native?.prepareRoute?.(),
    onPredictionRoute: value => integration.launched?.(value) });
  return { status: opened ? !predictionReady || imageWarning ? "opened_with_pending" : "opened_new_chat_required" : "open_failed",
    prepared: true, runtime: runtime(), app: { status: "unknown" }, ...(opened && !predictionReady ? { prediction_pending: true } : {}),
    ...(opened && imageWarning ? { image_pending: true } : {}) };
}
