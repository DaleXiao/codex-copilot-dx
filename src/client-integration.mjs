import { ensureCodexConfig } from "./config.mjs";
import { readImageProviderConfig } from "./image-provider-config.mjs";
import { ensureCodexThreadCompression } from "./codex-thread-compression.mjs";
import { runInBackground } from "./startup.mjs";
import { createPredictionState } from "./native-prediction-state.mjs";
import { supervisePrediction } from "./native-prediction-recovery.mjs";

// The CLI composes the services; this module owns optional client integration
// lifecycle. It never forwards model requests or depends on dashboard rendering.
export function createClientIntegration({ port, host, info = () => {}, warning = () => {}, configLog } = {}) {
  const prediction = createPredictionState();
  let native = null;
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
    async start() {
      try {
        const { startNativePrediction } = await import("./native-prediction.mjs");
        native = await startNativePrediction({ state: prediction, warning: info });
        if (native) {
          const expectedPort = Number(new URL(native.pacUrl).port);
          native = supervisePrediction({ native, state: prediction, warning,
            restart: () => startNativePrediction({ state: prediction, warning: info, expectedPort }) });
        }
      } catch (error) { prediction.unavailable(error); warning(`${error.message}. Core startup will continue.`); }
      return native;
    },
    pacUrl() { return native?.pacUrl || null; },
    launched(route) { prediction.launch(route); },
    snapshot() { return { prediction: prediction.snapshot() }; },
    async close() { await native?.close(); native = null; },
  };
}
