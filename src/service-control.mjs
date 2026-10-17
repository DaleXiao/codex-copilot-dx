import { readUserSettings, servicePreferences, writeServicePreference, terminalAnimationPreference,
  writeTerminalAnimationTheme, responseHistoryLimitPreference, writeResponseHistoryLimitMib } from "./user-settings.mjs";
import { readImageProviderConfig } from "./image-provider-config.mjs";
import { readPredictionSettings } from "./native-prediction-profile.mjs";
import { cacheRuntimeSnapshot, cleanRuntimeCaches, setHistoryCacheLimit } from "./cache-control.mjs";
import { isTerminalAnimationTheme } from "./terminal-animation.mjs";

export function createServiceControl({ env = process.env, home, providerRuntime, clientIntegration, terminal,
  readImages = () => readImageProviderConfig({ env, home }), readPrediction = () => readPredictionSettings({ env, home }) } = {}) {
  const options = { env, home };
  let serial = Promise.resolve();
  function snapshot() {
    readUserSettings({ ...options, strict: true });
    const saved = servicePreferences(options), prediction = clientIntegration?.snapshot().prediction;
    let imageConfigured = false, predictionConfigured = false;
    try { imageConfigured = Boolean(readImages()); } catch {}
    try { predictionConfigured = readPrediction().enabled === true; } catch {}
    return { source: "service_settings", saved, theme: terminalAnimationPreference(options).theme,
      effective: {
        terminal_animation_enabled: { value: terminal?.enabled === true && saved.terminal_animation_enabled && !/^(0|false|no|off)$/i.test(env.CCDX_TERMINAL_ANIMATION || ""),
          state: terminal?.enabled === true ? "immediate" : "terminal_unavailable", locked: /^(0|false|no|off)$/i.test(env.CCDX_TERMINAL_ANIMATION || "") },
        open_webui: { value: saved.open_webui, state: "next_start" },
        image_enabled: { value: saved.image_enabled && imageConfigured, state: imageConfigured ? "next_call" : "needs_setup", configured: imageConfigured },
        prediction_enabled: { value: prediction?.active === true, state: !predictionConfigured ? "needs_setup"
          : prediction?.environment?.status === "needs_app_relaunch" ? "needs_app_relaunch" : prediction?.bridge !== "running" ? "needs_service_restart" : "next_config_request", configured: predictionConfigured },
      }, history: { ...responseHistoryLimitPreference(options), ...cacheRuntimeSnapshot().response_history },
      providers: providerRuntime?.snapshot() || null, terminal: terminal?.snapshot?.() || null };
  }
  async function apply(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid setting action");
    const allowed = { preference: ["action", "key", "value"], animation: ["action", "theme"],
      history_limit: ["action", "mib"], history_clean: ["action"], prediction_fix: ["action"],
      provider: ["action", "operation", "provider", "model", "auto_review_model"] }[input.action];
    if (!allowed || Object.keys(input).some(key => !allowed.includes(key))) throw new Error("Unknown setting action or field");
    if (input.action === "preference") {
      writeServicePreference(input.key, input.value, options);
      if (input.key === "prediction_enabled") clientIntegration?.setPredictionActive(input.value);
      terminal?.apply?.({ ...servicePreferences(options) });
    } else if (input.action === "animation") {
      if (!isTerminalAnimationTheme(input.theme)) throw new Error("Select a listed animation theme");
      writeTerminalAnimationTheme(input.theme, options);terminal?.apply?.({ theme: input.theme });
    } else if (input.action === "prediction_fix") {
      if (!clientIntegration) throw new Error("Prediction integration is unavailable");
      await clientIntegration.fix();
    } else if (input.action === "history_limit") {
      if (responseHistoryLimitPreference(options).source === "environment") throw new Error("History limit is controlled by CCDX_RESPONSE_HISTORY_MAX_BYTES");
      if (!Number.isSafeInteger(input.mib)) throw new Error("History limit must be an integer MiB value");
      const before = cacheRuntimeSnapshot().response_history.maxBytes;
      setHistoryCacheLimit(input.mib * 1024 * 1024);
      try { writeResponseHistoryLimitMib(input.mib, options); } catch (error) { setHistoryCacheLimit(before);throw error; }
    } else if (input.action === "history_clean") cleanRuntimeCaches({ history: true });
    else {
      if (!providerRuntime || !["on", "off", "switch"].includes(input.operation)) throw new Error("Invalid provider operation");
      if (input.operation === "on" && env.CCDX_M365 === "0") throw new Error("Microsoft 365 is disabled by CCDX_M365=0");
      await providerRuntime.action({ action: input.operation, provider: input.provider, model: input.model, auto_review_model: input.auto_review_model });
    }
    return snapshot();
  }
  return { snapshot, action(input) { const operation = serial.then(() => apply(input));serial = operation.catch(() => {});return operation; } };
}
