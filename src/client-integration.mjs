import { ensureCodexConfig } from "./config.mjs";
import { readImageProviderConfig } from "./image-provider-config.mjs";
import { ensureCodexThreadCompression } from "./codex-thread-compression.mjs";
import { runInBackground } from "./startup.mjs";
import { createPredictionState } from "./native-prediction-state.mjs";

// The CLI composes the services; this module owns optional client integration
// lifecycle. It never forwards model requests or depends on dashboard rendering.
export function createClientIntegration({ port, host, info = () => {}, warning = () => {} } = {}) {
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
      const { imageMcpSkipped } = ensureCodexConfig(port, { host, imageProviderEnabled: enabled });
      if (enabled && !imageMcpSkipped) {
        try {
          const { syncEnabledImageSkill } = await import("./cli-image.mjs");
          syncEnabledImageSkill({ adapterPort: port, adapterHost: host });
        } catch (error) { warning(`Image guidance could not be updated: ${error.message}`); }
      }
      return { compressionSetup: runInBackground(ensureCodexThreadCompression) };
    },
    async start() {
      try {
        const { startNativePrediction } = await import("./native-prediction.mjs");
        native = await startNativePrediction({ state: prediction, warning: info });
      } catch (error) { prediction.unavailable(error); warning(`${error.message}. Core startup will continue.`); }
      return native;
    },
    pacUrl() { return native?.pacUrl || null; },
    snapshot() { return { prediction: prediction.snapshot() }; },
    async close() { await native?.close(); native = null; },
  };
}
