import { createImageHostState } from "./image-host-state.mjs";
import { controlImage } from "./image-control.mjs";
import { controlCodexLaunch } from "./codex-launch-control.mjs";
import { serviceSettingsSnapshot, servicePreferences, writeServicePreference,
  writeTerminalAnimationTheme, writeTerminalColorTheme, responseHistoryLimitPreference, writeResponseHistoryLimitMib,
  nightlyUpdatePreference, writeNightlyUpdatePreference, decodedBodyLimitPreference, writeDecodedBodyLimitMib } from "./user-settings.mjs";
import { readPredictionSettings } from "./native-prediction-profile.mjs";
import { cacheRuntimeSnapshot, cleanRuntimeCaches, setHistoryCacheLimit } from "./cache-control.mjs";
import { isTerminalAnimationTheme } from "./terminal-animation.mjs";
import { settingsPreferencesSnapshot, writeSettingsPreferences } from "./settings-preferences.mjs";
import { predictionControlSnapshot, controlPrediction } from "./prediction-control.mjs";
import { imageSetupSummary, configureImageSetup } from "./image-setup.mjs";

export function createServiceControl({ env = process.env, home, providerRuntime, clientIntegration, terminal,
  nightlyStatus = () => null, nightlyChanged = () => {},
  manualUpdate, predictionControl = controlPrediction, imageControl = configureImageSetup, imageHostControl = controlImage, codexLaunchControl = controlCodexLaunch,
  clientVersions,
  adapterPort = 2026, adapterHost = "127.0.0.1",
  readImages = () => imageSetupSummary({ env, home }).configured, readPrediction = () => readPredictionSettings({ env, home }) } = {}) {
  const options = { env, home };
  const imageHostState = createImageHostState();
  let serial = Promise.resolve(), lastOperation = null, pending = 0;
  const featureSnapshot = read => { try { return read(options); } catch { return { status: "unavailable" }; } };
  function snapshot() {
    const { saved, theme, color_theme, historyLimit } = serviceSettingsSnapshot(options), prediction = clientIntegration?.snapshot().prediction;
    let imageConfigured = false, predictionConfigured = false;
    try { imageConfigured = Boolean(readImages()); } catch {}
    try { predictionConfigured = readPrediction().enabled === true; } catch {}
    const image = featureSnapshot(() => imageSetupSummary({ ...options, models: providerRuntime?.imageModels?.().models || [] }));
    const enabled = nightlyUpdatePreference(options), nightly = nightlyStatus();
    const localPrivacy = providerRuntime?.privacy?.snapshot();
    return { source: "service_settings", saved, theme, color_theme, preferences: settingsPreferencesSnapshot(options), local_privacy: localPrivacy,
      features: { prediction: { ...featureSnapshot(predictionControlSnapshot), bridge: prediction?.bridge || "stopped", active: prediction?.active === true }, image: { ...image, runtime: imageHostState.snapshot() } },
      decoded_body: decodedBodyLimitPreference(options), manual_update: { available: typeof manualUpdate === "function" }, last_operation: lastOperation,
      ...(providerRuntime?.errorCaptureSnapshot ? { error_capture: providerRuntime.errorCaptureSnapshot() } : {}),
      ...(providerRuntime?.compaction ? { compaction: providerRuntime.compaction.snapshot() } : {}),
      nightly_update: { enabled, ...nightly, effect: enabled && !nightly ? "next_start" : "immediate" },
      effective: {
        context_compaction_enabled: { value: saved.context_compaction_enabled && Boolean(providerRuntime?.compaction), state: providerRuntime?.compaction ? saved.context_compaction_enabled ? "ready" : "off" : "unavailable" },
        privacy_enabled: { value: localPrivacy?.effective_enabled === true, state: !localPrivacy ? "unavailable" : !localPrivacy.enabled ? "off" : localPrivacy.state === "ready" ? "ready" : "not_ready" },
        terminal_animation_enabled: { value: terminal?.enabled === true && saved.terminal_animation_enabled && !/^(0|false|no|off)$/i.test(env.CCDX_TERMINAL_ANIMATION || ""),
          state: terminal?.enabled === true ? "immediate" : "terminal_unavailable", locked: /^(0|false|no|off)$/i.test(env.CCDX_TERMINAL_ANIMATION || "") },
        open_webui: { value: saved.open_webui, state: "next_start" },
        image_enabled: { value: saved.image_enabled && imageConfigured && image.selected_available === true, state: !imageConfigured ? "needs_github_access" : image.selected_available ? "next_call" : "image_model_unavailable", configured: imageConfigured },
        prediction_enabled: { value: prediction?.active === true, state: !predictionConfigured ? "needs_setup"
          : prediction?.environment?.status === "needs_app_relaunch" ? "needs_app_relaunch" : prediction?.bridge !== "running" ? "needs_service_restart" : "next_config_request", configured: predictionConfigured },
      }, history: { ...historyLimit, ...cacheRuntimeSnapshot().response_history },
      providers: providerRuntime?.snapshot() || null, terminal: terminal?.snapshot?.() || null, client_versions: featureSnapshot(() => clientVersions?.snapshot?.() || null) };
  }
  async function apply(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid setting action");
    const allowed = { preference: ["action", "key", "value"], nightly_update: ["action", "enabled"], animation: ["action", "theme"], color_theme: ["action", "theme"],
      history_limit: ["action", "mib"], history_clean: ["action"], prediction_fix: ["action"],
      prediction: ["action", "operation"], image: ["action", "operation", "model", "evidence", "confirmed"],
      codex_app: ["action", "operation", "intent", "confirmed"],
      update: ["action", "confirmed"], decoded_limit: ["action", "mib"],
      error_capture: ["action", "operation", "source", "model"],
      preferences: ["action", "values", "revision"], reset_preferences: ["action", "revision", "backup_id", "scope"], restore_preferences: ["action", "revision", "backup_id", "scope"],
      provider: ["action", "operation", "provider", "model", "auto_review_model", "auto_review_effort", "account_id"] }[input.action];
    if (!allowed || Object.keys(input).some(key => !allowed.includes(key))) throw new Error("Unknown setting action or field");
    lastOperation = null;
    if (input.action === "error_capture") {
      if (!providerRuntime?.captureUpstreamError) throw new Error("This service cannot capture upstream errors.");
      lastOperation = { feature: "error_capture", result: providerRuntime.captureUpstreamError(input) };
    } else if (input.action === "codex_app") {
      lastOperation = { feature: "codex_app", result: await codexLaunchControl(input.operation, { ...options, host: adapterHost, port: adapterPort,
        integration: clientIntegration, state: imageHostState, intent: input.intent, confirmed: input.confirmed, models: providerRuntime?.imageModels?.().models || [] }) };
    } else if (input.action === "prediction") {
      lastOperation = { feature: "prediction", result: await predictionControl(input.operation, { ...options, integration: clientIntegration }) };
    } else if (input.action === "image") {
      if (["check", "repair", "open", "focus", "restart"].includes(input.operation)) lastOperation = { feature: "image", result: await imageHostControl(input.operation, { ...options, host: adapterHost, port: adapterPort, integration: clientIntegration, state: imageHostState, confirmed: input.confirmed, models: providerRuntime?.imageModels?.().models || [] }) };
      else if (["pause", "resume"].includes(input.operation)) writeServicePreference("image_enabled", input.operation === "resume", options);
      else lastOperation = { feature: "image", result: await imageControl(input, { ...options, providerRuntime, adapterPort, adapterHost }) };
    } else if (input.action === "update") {
      if (input.confirmed !== true) throw new Error("Confirm installation and the idle service switch");
      if (!manualUpdate) throw new Error("This launch cannot update itself; use the installer or start CCDX from its installed command");
      lastOperation = { feature: "update", result: await manualUpdate() };
    } else if (input.action === "decoded_limit") {
      if (decodedBodyLimitPreference(options).source === "environment") throw new Error("Request limit is controlled by the launch environment");
      writeDecodedBodyLimitMib(input.mib, options);
    } else if (["preferences", "reset_preferences", "restore_preferences"].includes(input.action)) {
      if (input.action === "preferences" && Object.hasOwn(input.values || {}, "privacy_enabled")
        && input.values.privacy_enabled !== settingsPreferencesSnapshot(options).values.privacy_enabled) {
        throw Object.assign(new Error("Use local masking controls to prepare or disable protection"), { code: "ccdx_settings_privacy_action_required", statusCode: 400 });
      }
      const before = nightlyUpdatePreference(options);
      writeSettingsPreferences(input, options);
      if (input.action !== "preferences" || Object.keys(input.values || {}).some(key => key.startsWith("privacy_"))) providerRuntime?.privacy?.settingsChanged();
      const current = settingsPreferencesSnapshot(options).values;
      terminal?.apply?.({ ...servicePreferences(options), theme: current.terminal_animation, color_theme: current.terminal_color_theme });
      if (before !== current.nightly_updates) nightlyChanged(current.nightly_updates);
    } else if (input.action === "nightly_update") {
      writeNightlyUpdatePreference(input.enabled, options);nightlyChanged(input.enabled);
    } else if (input.action === "preference") {
      if (input.key === "prediction_enabled") await predictionControl(input.value ? "enable" : "disable", { ...options, integration: clientIntegration });
      else writeServicePreference(input.key, input.value, options);
      terminal?.apply?.({ ...servicePreferences(options) });
    } else if (input.action === "color_theme") {
      writeTerminalColorTheme(input.theme, options);terminal?.apply?.({ color_theme: input.theme });
    } else if (input.action === "animation") {
      if (!isTerminalAnimationTheme(input.theme)) throw new Error("Select a listed animation theme");
      writeTerminalAnimationTheme(input.theme, options);terminal?.apply?.({ theme: input.theme });
    } else if (input.action === "prediction_fix") {
      if (!clientIntegration) throw new Error("Prediction integration is unavailable");
      await predictionControl("repair", { ...options, integration: clientIntegration });
    } else if (input.action === "history_limit") {
      if (responseHistoryLimitPreference(options).source === "environment") throw new Error("History limit is controlled by CCDX_RESPONSE_HISTORY_MAX_BYTES");
      if (!Number.isSafeInteger(input.mib)) throw new Error("History limit must be an integer MiB value");
      const before = cacheRuntimeSnapshot().response_history.maxBytes;
      setHistoryCacheLimit(input.mib * 1024 * 1024);
      try { writeResponseHistoryLimitMib(input.mib, options); } catch (error) { setHistoryCacheLimit(before);throw error; }
    } else if (input.action === "history_clean") cleanRuntimeCaches({ history: true });
    else {
      if (!providerRuntime || !["on", "off", "switch", "auto-review", "account"].includes(input.operation)) throw new Error("Invalid provider operation");
      if (input.operation === "account" && (typeof input.account_id !== "string" || !/^[a-f0-9]{64}$/.test(input.account_id))) throw new Error("Select an available company account");
      if (input.operation === "on" && env.CCDX_M365 === "0") throw new Error("Microsoft 365 is disabled by CCDX_M365=0");
      await providerRuntime.action({ action: input.operation, provider: input.provider, model: input.model, auto_review_model: input.auto_review_model, auto_review_effort: input.auto_review_effort, effort: input.auto_review_effort,
        ...(input.operation === "account" ? { account_id: input.account_id } : {}) });
    }
    return snapshot();
  }
  return { snapshot, busy: () => pending > 0, action(input) {
    if (input?.action === "client_versions") {
      if (Object.keys(input).some(key => key !== "action")) return Promise.reject(new Error("Unknown setting action or field"));
      if (clientVersions?.refresh) void Promise.resolve().then(() => clientVersions.refresh()).catch(() => {});
      return Promise.resolve({ source: "client_versions", scheduled: Boolean(clientVersions) });
    }
    // Image-host evidence must not wait behind a user-initiated App restart:
    // the host sends it with a short deadline as the new App starts.
    if (input?.action === "image" && input.operation === "report") {
      try {
        if (Object.keys(input).some(key => !["action", "operation", "evidence"].includes(key))) throw new Error("Unknown setting action or field");
        imageHostState.report(input.evidence);terminal?.image?.(imageHostState.snapshot());
        return Promise.resolve(snapshot());
      } catch (error) { return Promise.reject(error); }
    }
    const counted = input?.action !== "update";if (counted) pending++;
    const operation = serial.then(() => apply(input)).finally(() => { if (counted) pending--; });serial = operation.catch(() => {});return operation;
  } };
}
