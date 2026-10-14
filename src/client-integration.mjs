import { ensureCodexConfig } from "./config.mjs";
import { readImageProviderConfig } from "./image-provider-config.mjs";
import { ensureCodexThreadCompression } from "./codex-thread-compression.mjs";
import { runInBackground } from "./startup.mjs";
import { createPredictionState } from "./native-prediction-state.mjs";
import { supervisePrediction } from "./native-prediction-recovery.mjs";

// The CLI composes the services; this module owns optional client integration
// lifecycle. It never forwards model requests or depends on dashboard rendering.
export function createClientIntegration({ port, host, info = () => {}, warning = () => {}, configLog,
  startPrediction = async options => (await import("./native-prediction.mjs")).startNativePrediction(options) } = {}) {
  const prediction = createPredictionState();
  let native = null;
  let operation = null, operationName = null, closed = false;
  async function startPredictionBridge(expectedPort) {
    const started = await startPrediction({ state: prediction, warning: info, ...(expectedPort ? { expectedPort } : {}) });
    if (!started) return null;
    if (closed) { await started.close();return null; }
    const port = Number(new URL(started.pacUrl).port);
    prediction.supervising();
    return supervisePrediction({ native: started, state: prediction, warning,
      restart: () => startPrediction({ state: prediction, warning: info, expectedPort: port }) });
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
        const result = retirePredictionIntegration();
        if (result.changed) info("Removed the retired CCDX prediction integration");
        if (result.preserved) warning("Modified prediction settings were preserved");
      } catch (error) { warning(`${error.message}. Core startup will continue.`); }
      const enabled = Boolean(readImageProviderConfig());
      const { imageMcpSkipped } = ensureCodexConfig(port, { host, imageProviderEnabled: enabled, ...(configLog ? { log: configLog } : {}) });
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
      try {
        if (!native?.healthy() || native.enabled?.() === false || native.appCurrent?.() === false) {
          const expectedPort = native ? Number(new URL(native.pacUrl).port) : undefined;
          await native?.close();native = null;
          native = await startPredictionBridge(expectedPort);restarted = Boolean(native);
        }
      } catch (error) { prediction.unavailable(error); }
      let routeError = false;
      if (native && !closed) {
        try {
          await native.prepareRoute?.();
          route = await native.inspectRoute?.() || "unverified";
        } catch { routeError = true;warning("Prediction bridge is ready, but App route inspection failed"); }
      }
      const snapshot = prediction.snapshot();
      const status = !snapshot.configured && snapshot.bridge !== "unavailable" ? "disabled" : snapshot.bridge !== "running" ? "failed"
        : route === "verified" || route === "closed" ? "ready" : route === "missing" ? "needs_app_relaunch" : "route_unverified";
      return { status, bridge_restarted: restarted, app_route: route, ...(routeError ? { route_error: true } : {}), prediction: snapshot };
    }); },
    pacUrl() { return native?.pacUrl || null; },
    launched(route) { prediction.launch(route); },
    snapshot() { return { prediction: prediction.snapshot() }; },
    async close() { closed = true;try { await operation; } finally { await native?.close();native = null; } },
  };
}
