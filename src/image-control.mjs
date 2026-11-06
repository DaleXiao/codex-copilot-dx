import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { adapterBaseUrl, ADAPTER_PROTOCOL_VERSION } from "./running-adapter.mjs";
import { imageHostLauncherPath, prepareImageHostLaunch } from "./codex-image-host-launch.mjs";
import { imageSetupSummary } from "./image-setup.mjs";
import { openCodex } from "./launcher.mjs";
import { readBoundedResponseText } from "./upstream-body.mjs";
import { installedPredictionApp } from "./native-prediction-app.mjs";
import { inspectCodexApp, controlCodexApp } from "./codex-app-control.mjs";
import { predictionControlSnapshot } from "./prediction-control.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const publicAppState = value => ({ status: value.status, ...(value.host ? { host: value.host } : {}),
  ...(value.tool_registration ? { tool_registration: value.tool_registration } : {}) });

export async function checkImageConnection({ host = "127.0.0.1", port = 2026, fetchImpl = fetch } = {}) {
  const nonce = randomUUID();
  try {
    const response = await fetchImpl(adapterBaseUrl(host, port) + "/_ccdx/health?nonce=" + nonce,
      { redirect: "error", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(2000) });
    const value = JSON.parse(await readBoundedResponseText(response, { maxBytes: 8192, label: "Local image check" }));
    return { state: response.ok && value.name === "codex-copilot-dx" && value.ok === true && value.nonce === nonce
      && value.protocol_version === ADAPTER_PROTOCOL_VERSION ? "verified" : "identity_mismatch", scope: "node_loopback", app_path: "unconfirmed" };
  } catch { return { state: "unreachable", scope: "node_loopback", app_path: "unconfirmed" }; }
}

export async function controlImage(operation, { integration, state, host, port, models = [], prepare = prepareImageHostLaunch,
  launch = openCodex, connection = checkImageConnection, readSummary = imageSetupSummary,
  discover = installedPredictionApp, inspect = inspectCodexApp, appControl = controlCodexApp,
  confirmed = false, wait = sleep, now = Date.now, quitTimeoutMs = 10000, ...options } = {}) {
  if (!["check", "repair", "open", "focus", "restart"].includes(operation)) throw new Error("Unknown image control");
  const summary = readSummary({ ...options, models });
  const runtime = () => state?.snapshot();
  const inspectApp = app => inspect(app, runtime()?.hosts || [], options);
  if (operation === "check") {
    let app = { status: (options.platform || process.platform) === "darwin" ? "unknown" : "unsupported" };
    if (app.status === "unknown") {
      try { app = await inspectApp((await discover(options)).app); } catch { /* An unknown App must not be called stopped. */ }
    }
    return { status: "checked", connection: await connection({ host, port }),
      launcher_present: fs.existsSync(imageHostLauncherPath(options)), runtime: runtime(), app: publicAppState(app), ...summary };
  }
  if (operation === "focus") {
    if ((options.platform || process.platform) !== "darwin") return { status: "unsupported", app: { status: "unsupported" } };
    let app, current;
    try { app = (await discover(options)).app;current = await inspectApp(app); }
    catch { return { status: "app_check_failed", app: { status: "unknown" } }; }
    if (current.status !== "running") return { status: "app_not_running", app: publicAppState(current) };
    let result;
    try { result = await appControl(app, current.pid, "activate", options); }
    catch { return { status: "focus_unavailable", app: { status: "unknown" } }; }
    return { status: result === "sent" ? "focused" : "focus_unavailable", app: result === "sent" ? publicAppState(current) : { status: "unknown" } };
  }
  if (operation === "restart" && confirmed !== true) throw new Error("Confirm that restarting Codex can interrupt its running tasks");
  if (!summary.enabled) throw new Error("Enable images before repairing image access");
  if (!integration) throw new Error("Start CCDX before repairing image access");
  const env = { ...(options.env || process.env), CCDX_AUTO_LAUNCH: "1" };
  await integration.configure();
  const imageHost = await prepare({ ...options, env, host, port });
  if (!imageHost) return { status: "unsupported", prepared: false };
  let current;
  try { current = await inspectApp(imageHost.app); } catch { return { status: "app_check_failed", prepared: true }; }
  if (current.status === "unsupported") return { status: "unsupported", prepared: true };
  if (current.status === "multiple") return { status: "multiple_apps", prepared: true, app: publicAppState(current) };
  if (!["running", "stopped"].includes(current.status)) return { status: "app_check_failed", prepared: true };
  if (operation !== "restart" && current.status === "running") return { status: current.host === "connected" ? "already_connected" : "needs_app_relaunch",
    prepared: true, runtime: runtime(), app: publicAppState(current) };
  if (operation === "repair") return { status: "prepared", prepared: true, runtime: runtime(), app: publicAppState(current) };
  if (operation === "restart" && (!summary.configured || !summary.selected_available)) return { status: "image_unavailable", prepared: true, app: publicAppState(current) };
  if (operation === "restart" && current.status === "running" && current.host === "connected") return { status: "already_connected", prepared: true, app: publicAppState(current) };
  // Share the established prediction launch route; never strip it during repair.
  const native = await integration.start();
  if (operation === "restart" && !native) {
    const prediction = predictionControlSnapshot(options);
    if (prediction.configured && prediction.enabled) return { status: "prediction_unavailable", prepared: true, app: publicAppState(current) };
  }
  await native?.prepareRoute?.();
  if (operation === "restart") {
    if (native?.pacUrl && native.app && native.app !== imageHost.app) return { status: "app_route_conflict", prepared: true };
    const previous = current;
    try { current = await inspectApp(imageHost.app); } catch { return { status: "app_check_failed", prepared: true }; }
    if (current.status === "running" && current.host === "connected") return { status: "already_connected", prepared: true, app: publicAppState(current) };
    if (!["running", "stopped"].includes(current.status) || current.status === "running" && (previous.status !== "running" || current.pid !== previous.pid)) {
      return { status: "app_changed", prepared: true, app: publicAppState(current) };
    }
    if (current.status === "running") {
      const originalPid = current.pid;
      let requested;
      try { requested = await appControl(imageHost.app, originalPid, "quit", options); }
      catch { return { status: "quit_refused", prepared: true, app: publicAppState(current) }; }
      if (!["sent", "absent"].includes(requested)) return { status: "quit_refused", prepared: true, app: publicAppState(current) };
      const deadline = now() + quitTimeoutMs;
      do {
        try { current = await inspectApp(imageHost.app); } catch { return { status: "app_check_failed", prepared: true }; }
        if (current.status === "stopped") break;
        if (current.status !== "running" || current.pid !== originalPid) return { status: "app_changed", prepared: true, app: publicAppState(current) };
        if (now() >= deadline) return { status: "quit_timeout", prepared: true, app: publicAppState(current) };
        await wait(Math.min(250, Math.max(1, deadline - now())));
      } while (true);
    }
  }
  const opened = await launch({ env, imageHost, predictionPacUrl: native?.pacUrl, predictionApp: native?.app,
    predictionProfile: native?.profile, preparePredictionRoute: () => native?.prepareRoute?.(),
    onPredictionRoute: value => integration.launched?.(value) });
  return { status: opened ? "opened_new_chat_required" : "open_failed", prepared: true, runtime: state?.snapshot(), app: { status: "unknown" } };
}
