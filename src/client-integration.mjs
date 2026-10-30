import { ensureCodexConfig } from "./config.mjs";
import { readImageProviderConfig } from "./image-provider-config.mjs";
import { ensureCodexThreadCompression } from "./codex-thread-compression.mjs";
import { runInBackground } from "./startup.mjs";
import { createPredictionState } from "./native-prediction-state.mjs";
import { supervisePrediction } from "./native-prediction-recovery.mjs";
import { operationErrorDetails } from "./operation-error.mjs";

// The CLI composes the services; this module owns optional client integration
// lifecycle. It never forwards model requests or depends on dashboard rendering.
export function createClientIntegration({ port, host, info = () => {}, warning = () => {}, configLog,
  startPrediction = async options => (await import("./native-prediction.mjs")).startNativePrediction(options) } = {}) {
  const prediction = createPredictionState();
  let native = null;
  let operation = null, operationName = null, closed = false;
  let pendingRoutePid = null, codexSetup = null;
  async function startPredictionBridge(expectedPort, environment) {
    const started = await startPrediction({ state: prediction, warning: info,
      ...(environment ? { environment } : {}), ...(expectedPort ? { expectedPort } : {}) });
    if (!started) return null;
    if (closed) { await started.close();return null; }
    const port = Number(new URL(started.pacUrl).port);
    prediction.supervising();
    let latest = started;
    return supervisePrediction({ native: started, state: prediction, warning,
      restart: async () => {
        const check = await latest.inspectEnvironment?.();
        if (check?.requiresServiceRestart) throw Object.assign(new Error("Node trust settings changed; restart CCDX before restoring the prediction bridge"), {
          code: "tls_restart_required", predictionEnvironment: { ...check.next.summary, status: "needs_service_restart" } });
        const resumed = await startPrediction({ state: prediction, warning: info, expectedPort: port, ...(check ? { environment: check.next } : {}) });
        if (resumed) latest = resumed;
        if (check?.changed && resumed) {
          let route;try { route = await resumed.inspectRoute?.(); } catch {}
          const pid = resumed.routeProcessId?.();pendingRoutePid = route === "closed" ? null : Number.isInteger(pid) ? pid : "unknown";
          prediction.environment({ ...check.next.summary, status: pendingRoutePid === null ? "adapted" : "needs_app_relaunch" }, { resetTraffic: true });
          if (pendingRoutePid !== null) warning("Prediction network settings changed; normally relaunch Codex to reload its PAC. No App was restarted");
        }
        return resumed;
      } });
  }
  function serialize(name, task) {
    if (closed) return Promise.reject(new Error("Client integration is closing; repair was skipped"));
    if (operation) return operationName === name ? operation : operation.then(() => serialize(name, task));
    operationName = name;
    operation = Promise.resolve().then(task).finally(() => { operation = null;operationName = null; });
    return operation;
  }
  return {
    async configure() {
      try {
        const { retirePredictionIntegration } = await import("./prediction-retirement.mjs");
        retirePredictionIntegration();
      } catch { /* Legacy cleanup is optional; never interrupt or clutter core startup. */ }
      const enabled = Boolean(readImageProviderConfig());
      let imageMcpSkipped;
      try {
        const result = ensureCodexConfig(port, { host, imageProviderEnabled: enabled, ...(configLog ? { log: configLog } : {}) });
        imageMcpSkipped = result.imageMcpSkipped;codexSetup = { setup: result.coreSetup, checked_at: new Date().toISOString() };
      } catch (error) { codexSetup = { setup: "configuration_unavailable", checked_at: new Date().toISOString() };throw error; }
      if (enabled && !imageMcpSkipped) {
        try {
          const { syncEnabledImageSkill } = await import("./cli-image.mjs");
          syncEnabledImageSkill({ adapterPort: port, adapterHost: host });
        } catch (error) { warning(`Image guidance could not be updated: ${error.message}`); }
      }
      return { imageEnabled: enabled, imageMcpSkipped, compressionSetup: runInBackground(ensureCodexThreadCompression) };
    },
    start() { return serialize("start", async () => {
      try {
        native ||= await startPredictionBridge();
      } catch (error) { prediction.unavailable(error); warning(`${error.message}. Core startup will continue.`); }
      return native;
    }); },
    fix() { return serialize("fix", async () => {
      let restarted = false, route = "unknown";
      let environmentCheck;
      if (native?.enabled?.() !== false && native?.inspectEnvironment) {
        try {
          environmentCheck = await native.inspectEnvironment();
          if (environmentCheck?.requiresServiceRestart) {
            prediction.environment({ ...prediction.snapshot().environment, tls: environmentCheck.next.summary.tls,
              checked_at: environmentCheck.next.summary.checked_at, status: "needs_service_restart" });
            return { status: "needs_service_restart", bridge_restarted: false, app_route: route, prediction: prediction.snapshot() };
          }
        } catch (error) {
          const details = operationErrorDetails(error);
          prediction.environment({ ...prediction.snapshot().environment, status: "preserved", error: details, checked_at: new Date().toISOString() });
          return { status: "environment_preserved", bridge_restarted: false, app_route: route,
            environment_error: details, prediction: prediction.snapshot() };
        }
      }
      try {
        if (!native?.healthy() || native.enabled?.() === false || native.appCurrent?.() === false || environmentCheck?.changed) {
          const expectedPort = native ? Number(new URL(native.pacUrl).port) : undefined;
          await native?.close();native = null;
          native = await startPredictionBridge(expectedPort, environmentCheck?.next);restarted = Boolean(native);
        } else if (environmentCheck) {
          prediction.environment(environmentCheck.next.summary);
        }
      } catch (error) { prediction.unavailable(error); }
      let routeError = false;
      if (native && !closed) {
        try {
          await native.prepareRoute?.();
          route = await native.inspectRoute?.() || "unverified";
        } catch { routeError = true;warning("Prediction bridge is ready, but App route inspection failed"); }
      }
      const pid = native?.routeProcessId?.();
      if (pendingRoutePid !== null && (route === "closed" || (Number.isInteger(pendingRoutePid) && Number.isInteger(pid) && pid !== pendingRoutePid))) pendingRoutePid = null;
      if (environmentCheck?.changed && native) {
        pendingRoutePid = route === "closed" ? null : Number.isInteger(pid) ? pid : "unknown";
        prediction.environment({ ...environmentCheck.next.summary, status: pendingRoutePid === null ? "adapted" : "needs_app_relaunch" }, { resetTraffic: true });
      } else if (pendingRoutePid !== null && native) {
        prediction.environment({ ...prediction.snapshot().environment, status: "needs_app_relaunch" });
      }
      const snapshot = prediction.snapshot();
      const status = !snapshot.configured && snapshot.bridge !== "unavailable" ? "disabled" : snapshot.bridge !== "running" ? "failed"
        : pendingRoutePid !== null ? "needs_app_relaunch" : snapshot.client_route === "observed" || route === "verified" || route === "closed" ? "ready" : route === "missing" ? "needs_app_relaunch" : "route_unverified";
      return { status, bridge_restarted: restarted, app_route: route, ...(routeError ? { route_error: true } : {}), prediction: snapshot };
    }); },
    pacUrl() { return native?.pacUrl || null; },
    launched(route) { prediction.launch(route); },
    setPredictionActive(value) {
      const active = native?.setActive?.(value) ?? false;
      return { active, state: active ? "active" : native ? "paused" : "needs_setup" };
    },
    snapshot() { return { codex: codexSetup ? { ...codexSetup } : null, prediction: { ...prediction.snapshot(), active: native?.enabled?.() === true } }; },
    busy: () => Boolean(operation),
    bridgeHealthy: () => native?.healthy?.() === true,
    pauseForUpdate() { return serialize("pause", async () => { await native?.close();native = null; }); },
    async close() { closed = true;try { await operation; } finally { await native?.close();native = null; } },
  };
}
