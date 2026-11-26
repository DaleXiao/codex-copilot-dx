import { status } from "./status.mjs";
import { checkForUpdate } from "./version.mjs";
import { parseAdapterProbeOptions, parseRuntimeOptions } from "./cli-options.mjs";

export async function runForegroundService({ CLI, LOCAL_VERSION, CLI_NAME }) {
  let serviceWorker = null;
  if (CLI.command === "start" && !(process.send && process.env.CCDX_SUPERVISED_SERVICE === "1")) {
    const { nightlyUpdatePreference } = await import("./user-settings.mjs");
    const { checkRunningAdapter } = await import("./running-adapter.mjs");

    const { installedUpdateEnvironment } = await import("./nightly-update.mjs");
    const address = parseAdapterProbeOptions(process.env);
    const existing = await checkRunningAdapter({ host: address.adapterHost, port: address.adapterPort, timeoutMs: address.existingAdapterTimeoutMs });
    let environment;
    try { if (!existing.ok && !existing.incompatible) environment = installedUpdateEnvironment(); }
    catch { if (nightlyUpdatePreference()) console.warn(status("warn", "Dashboard updates need a writable, matching npm installation. Starting without automatic updates.")); }
    if (environment) {
      const { runServiceSupervisor } = await import("./service-supervisor.mjs");
      try { process.exit(await runServiceSupervisor({ environment })); }
      catch { console.warn(status("warn", "Nightly runtime preparation failed. Starting without automatic updates.")); }
    }
  }

  const { ensureAuth, openCodex, autoLaunchEnabled } = await import("./launcher.mjs");
  const { startAdapter } = await import("./adapter.mjs");
  const { defaultCopilotClient, refreshVSCodeVersion } = await import("./copilot.mjs");
  const { configureLogging } = await import("./log.mjs");
  const { flushUsageWrites } = await import("./usage.mjs");
  const { failureHistoryPath } = await import("./failure-history.mjs");
  const { runDoctor } = await import("./doctor.mjs");
  const { adapterBaseUrl, checkRunningAdapter } = await import("./running-adapter.mjs");
  const { assertSafeAdapterHost, isLoopbackHost } = await import("./security.mjs");
  const { runInBackground } = await import("./startup.mjs");
  const { readAdapterStatus } = await import("./cli-status.mjs");
  const { closeHttpServer } = await import("./shutdown.mjs");
  const { autoReviewModelPreference, autoReviewPreference, responseHistoryLimitPreference, terminalAnimationPreference, servicePreferences, serviceSettingsSnapshot, nightlyUpdatePreference } = await import("./user-settings.mjs");
  const { createProfileRuntime } = await import("./profile-runtime.mjs");
  const { createProfileModelRuntime } = await import("./profile-model-runtime.mjs");
  const { createCodexModelCatalog } = await import("./codex-model-catalog.mjs");
  const { createProviderRuntime } = await import("./provider-runtime.mjs");
  const { setResponseHistoryMaxBytes } = await import("./response-history.mjs");
  const { startupBanner, startupCheck, startupReady, startupLogger, predictionStartupCheck, imageStartupCheck, providerStartupChecks, createStartupPresentation } = await import("./startup-ui.mjs");
  const { createTerminalConsole } = await import("./terminal-console.mjs");
  const { createServiceControl } = await import("./service-control.mjs");
  const { openDashboard } = await import("./browser-launch.mjs");

  if (CLI.command === "start" && process.send && process.env.CCDX_SUPERVISED_SERVICE === "1") {
    const { createServiceWorker } = await import("./service-worker.mjs");
    serviceWorker = await createServiceWorker();
  }

  let RUNTIME;
  try {
    RUNTIME = parseRuntimeOptions(process.env);
    setResponseHistoryMaxBytes(responseHistoryLimitPreference().bytes);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }

  const ADAPTER_PORT = RUNTIME.adapterPort;
  const ADAPTER_HOST = RUNTIME.adapterHost;
  const MODEL_REFRESH_TIMEOUT_MS = RUNTIME.modelRefreshTimeoutMs;
  const EXISTING_ADAPTER_TIMEOUT_MS = RUNTIME.existingAdapterTimeoutMs;
  let LOGGING = configureLogging({ env: serviceWorker?.warming ? { ...process.env, CCDX_LOG_PATH: "" } : process.env });
  if (serviceWorker?.warming) LOGGING.setTerminalSink(() => {});
  let activeServer = null;
  let modelRefreshTimer = null;
  let shuttingDown = false;
  let nativePrediction = null;
  let clientIntegration = null;
  let providerRuntime = null;
  let terminalConsole = null;
  const webUiUrl = `http://${ADAPTER_HOST === "::1" ? "[::1]" : "127.0.0.1"}:${ADAPTER_PORT}`;
  let versionMonitor = null, versionModule = null;
  const clientVersions = {
    snapshot: () => versionMonitor?.snapshot() || null,
    refresh() {
      if (shuttingDown || serviceWorker?.warming || serviceWorker?.draining || serviceWorker?.preserving) return Promise.resolve(clientVersions.snapshot());
      versionModule ||= import("./client-versions.mjs").then(({ createClientVersionMonitor, clientVersionName }) => {
        if (shuttingDown) return null;
        versionMonitor = createClientVersionMonitor({ onChange: names => {
          console.log(status("info", `Installed ${names.map(clientVersionName).join(" and ")} updated; checking managed capability configuration`));
          if(names.includes("claude"))void providerRuntime?.refreshClientCapabilities?.().catch(()=>{});
        } });
        return versionMonitor;
      }).catch(error => { versionModule = null;throw error; });
      return versionModule.then(monitor => monitor?.refresh());
    },
  };
  async function launchDashboard() {
    try {
      const result = await openDashboard(webUiUrl, { enabled: !CLI.noBrowser && servicePreferences().open_webui });
      if (result.state === "unavailable") console.warn(startupCheck("warn", "Dashboard", `Could not open browser. Open ${webUiUrl}`));
    } catch (error) { console.warn(startupCheck("warn", "Dashboard", error.message)); }
  }

  async function clientIntegrations() {
    if (!clientIntegration) {
      const { createClientIntegration } = await import("./client-integration.mjs");
      clientIntegration = createClientIntegration({ port: ADAPTER_PORT, host: ADAPTER_HOST,
        configLog: startupLogger("Config"),
        info: (message) => console.log(startupCheck("info", "App", message)), warning: (message) => console.warn(startupCheck("warn", "App", message)) });
    }
    return clientIntegration;
  }

  if (LOGGING.filePath) {
    console.log(status("info", `Details log: ${LOGGING.filePath}`));
    if (LOGGING.level === "debug") console.log(status("debug", "Detailed logging on"));
  }

  async function reuseRunningAdapterIfAvailable() {
    const running = await checkRunningAdapter({
      port: ADAPTER_PORT,
      host: ADAPTER_HOST,
      timeoutMs: EXISTING_ADAPTER_TIMEOUT_MS,
    });
    if (running.incompatible) {
      const found = running.data?.version || "unknown";
      throw new Error(`Adapter ${found} is already running at ${running.baseUrl}, but this CLI is ${LOCAL_VERSION}. Stop the existing process and run ${CLI_NAME} again.`);
    }
    if (!running.ok) return false;

    void fetch(`${webUiUrl}/_ccdx/ui/settings`, { method: "POST", headers: { "X-CCDX-Dashboard": "1", Origin: webUiUrl, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "client_versions" }), signal: AbortSignal.timeout(1000) }).catch(() => {});
    const serviceStatus = readAdapterStatus({ host: ADAPTER_HOST, port: ADAPTER_PORT }).catch(() => null);
    console.log(startupCheck("ok", "Service", `Using running service: ${running.baseUrl}`));
    console.log(startupCheck("info", "Sign-in", "Using saved sign-in; not rechecked"));
    const codexEnabled = (await serviceStatus)?.data?.providers?.connections?.clients?.find(client => client.id === "codex")?.enabled !== false;
    const { compressionSetup, imageEnabled, imageMcpSkipped } = codexEnabled ? await configureCodexClient() : { compressionSetup: Promise.resolve(), imageEnabled: false, imageMcpSkipped: false };

    let predictionPacUrl = null;
    let predictionApp = null;
    let predictionProfile = null;
    let persistedPredictionRoute = false;
    let predictionConfigured = false;
    let launchRoute = "unknown";
    try {
      const { readPredictionSettings } = await import("./native-prediction-profile.mjs");
      const preference = readPredictionSettings();
      predictionConfigured = preference.enabled;
      if (preference.enabled && codexEnabled) {
        predictionPacUrl = running.data?.native_prediction_pac || null;
        predictionApp = preference.app?.app;
        predictionProfile = preference.app?.profile;
        const { hasInstalledPredictionRoute } = await import("./native-prediction-route.mjs");
        const { predictionPaths } = await import("./native-prediction-profile.mjs");
        persistedPredictionRoute = hasInstalledPredictionRoute({ ...predictionPaths({ app: preference.app }), pacUrl: predictionPacUrl });
        if (!predictionPacUrl) console.warn(status("warn", "Restart ccdx to activate the newly enabled prediction bridge"));
      }
    } catch (error) { console.warn(status("warn", error.message)); }
    const imageHost = codexEnabled && imageEnabled && autoLaunchEnabled() ? await (await clientIntegrations()).imageHostLaunch() : null;
    if (codexEnabled) await openCodex({ predictionPacUrl, predictionApp, predictionProfile, persistedPredictionRoute, imageHost,
      onPredictionRoute: route => { launchRoute = route; }, log: startupLogger("App") });
    console.log(predictionStartupCheck({ configured: predictionConfigured, bridge: predictionPacUrl ? "running" : "unknown", launch_route: launchRoute }));
    console.log(imageStartupCheck({ enabled: imageEnabled, prepared: Boolean(imageHost), skipped: imageMcpSkipped }));
    console.log(providerStartupChecks((await serviceStatus)?.data));
    console.log(startupReady({ baseUrl: running.baseUrl, commandName: CLI_NAME, reused: true }));
    await launchDashboard();
    await compressionSetup;
    return true;
  }

  async function configureCodexClient() {
    if (serviceWorker?.preserving) return { compressionSetup: Promise.resolve(), imageEnabled: false, imageMcpSkipped: false };
    return (await clientIntegrations()).configure();
  }

  if (CLI.command === "doctor") {
    const checks = await runDoctor({
      commandName: CLI_NAME,
      port: ADAPTER_PORT,
      host: ADAPTER_HOST,
      online: CLI.online,
      compat: CLI.compat,
      fix: CLI.fix,
      json: CLI.json,
    });
    await LOGGING.cleanup();
    process.exit(checks.some((check) => check.kind === "err" || (CLI.fix && check.result && check.kind === "warn")) ? 1 : 0);
  }

  console.log(`\n${startupBanner({ commandName: CLI_NAME, version: LOCAL_VERSION })}\n`);
  const startupPresentation = createStartupPresentation({ verbose: CLI.verbose === true || CLI.showRequestId === true || LOGGING.level === "debug" || serviceWorker?.warming });
  if (startupPresentation.enabled) LOGGING.setTerminalSink((method, args) => startupPresentation.log(method, args));

  async function printUpdateNotice() {
    try {
      const { latestVersion, updateAvailable } = await checkForUpdate({ currentVersion: LOCAL_VERSION });
      if (!updateAvailable) return;
      console.warn(`\n${status("warn", `Update available: ${LOCAL_VERSION} -> ${latestVersion}. Run ${CLI_NAME} update github to update, then restart ${CLI_NAME}.`)}\n`);
    } catch {
      // Never block startup on the update check.
    }
  }

  try {
    assertSafeAdapterHost(ADAPTER_HOST, process.env);
    if (process.platform === "win32") {
      try {
        const { inspectWindowsCommand } = await import("./windows-command.mjs");
        const command = inspectWindowsCommand({ repair: true });
        if (command.changed) console.log(startupCheck("ok", "Command", "Windows command ready; use ccdx"));
        else if (command.status === "preserved") console.warn(startupCheck("warn", "Command", "Existing launcher preserved; use ccdx.cmd doctor to inspect it"));
      } catch { console.warn(startupCheck("warn", "Command", "Command setup skipped; service will start")); }
    }
    if (!serviceWorker?.warming && await reuseRunningAdapterIfAvailable()) {
      // Ready is already displayed; finish the bounded check before this short-lived CLI exits.
      await printUpdateNotice();
      serviceWorker?.reused();
      startupPresentation.finish();await LOGGING.cleanup();
      process.exit(0);
    }

    // Restore the opted-in listener alongside authentication/model initialization;
    // a slow company-proxy setup must not delay the core listener.
    const earlyIntegration = await clientIntegrations();

    let profileRuntime = createProfileRuntime({ codexClient: defaultCopilotClient });
    let startupComplete = false;
    const profileModels = createProfileModelRuntime({
      codexClient: profileRuntime.codexClient,
      codexCredentialFingerprint: () => profileRuntime.codexCredentialFingerprint,
      timeoutMs: MODEL_REFRESH_TIMEOUT_MS,
      commandName: CLI_NAME,
      autoReviewModelResolver: () => autoReviewModelPreference().model,
      log: (kind, message) => console.log(startupComplete ? status(kind, message) : startupCheck(kind, "Models", message)),
    });
    providerRuntime = createProviderRuntime({ githubClient: profileRuntime.codexClient, githubRegistry: profileModels.codexRegistry,
      persistSourceState: true,
      refreshGithubCatalog: () => profileModels.refreshCodex({ strict: true }),
      corePort: ADAPTER_PORT, preserveClientConfiguration: () => serviceWorker?.preserving === true || serviceWorker?.draining === true,
      clientVersionsSnapshot: clientVersions.snapshot,
      clientAccessChanged: async enabled => { earlyIntegration.setPredictionActive(enabled && servicePreferences().prediction_enabled);if (enabled) await earlyIntegration.configure(); },
      githubCredentialFingerprint: () => profileRuntime.codexCredentialFingerprint,
      log: (kind, message) => console.log(startupComplete ? status(kind, message) : startupCheck(kind, "M365", message)) });
    const codexEnabled = providerRuntime.connections().clients.find(client => client.id === "codex").enabled;
    if (!codexEnabled && !serviceWorker?.warming && !serviceWorker?.preserving) earlyIntegration.retireImages();
    const predictionSetup = codexEnabled && !serviceWorker?.warming ? runInBackground(() => earlyIntegration.start({ autoSetup: !serviceWorker?.preserving })) : Promise.resolve(null);
    const m365Setup = runInBackground(() => providerRuntime.start());
    if (providerRuntime.selection().codex === "github") {
      try { await ensureAuth({ log: startupLogger("Sign-in"), interactive: serviceWorker?.preserving !== true,
        onImportedAuth: imported => profileRuntime.codexClient.reuseVerifiedAuth(imported) }); }
      catch (error) { if (serviceWorker?.preserving) throw error;console.warn(startupCheck("warn", "Sign-in", "Sign-in unavailable. Use the dashboard or ccdx source github login; saved credentials kept.")); }
    } else {
      if (providerRuntime.selection().codex === "m365") await m365Setup;
      const source = providerRuntime.connections().providers.find(source => source.id === providerRuntime.selection().codex);
      console.log(startupCheck("info", "Source", source ? `Codex source: ${source.name}` : "Codex access off"));
    }
    profileRuntime = createProfileRuntime({ codexClient: defaultCopilotClient });

    // Refresh the VS Code version in the background; fallback is non-blocking.
    void refreshVSCodeVersion();
    if (providerRuntime.selection().codex === "github" || serviceWorker?.needsGithub) {
      await profileModels.initialize();
      if (serviceWorker?.warming) await profileModels.refreshAll();
      // Provider setup can run before GitHub's directory exists. Reconcile again
      // before opening the App, then join any existing stale-cache refresh.
      const refreshing = profileModels.codexRegistry.refreshInFlight ? profileModels.refreshAll() : null;
      await providerRuntime.syncClients(["codex"]);
      void refreshing?.then(() => providerRuntime.selection().codex === "github" && providerRuntime.syncClients(["codex"])).catch(() => {});
    }
    if (profileModels.codexRegistry.source !== "live") {
      console.log(startupCheck("info", "Models", `${profileModels.codexRegistry.source} list loaded${profileModels.codexRegistry.refreshInFlight ? "; refreshing" : ""}`));
    }

    if (!isLoopbackHost(ADAPTER_HOST)) {
      console.log(status("warn", `ADAPTER_HOST=${ADAPTER_HOST} exposes the adapter beyond loopback because CCDX_ALLOW_LAN=1 is set. Use only on trusted networks.`));
    }

    // Start the in-process adapter.
    const terminalAnimationTheme = terminalAnimationPreference().theme;
    terminalConsole = createTerminalConsole({ baseUrl: webUiUrl, verbose: CLI.verbose === true || CLI.showRequestId === true || LOGGING.level === "debug",
      snapshot: () => activeServer?.ccdxSnapshot?.() || {},
      subscribe: listener => activeServer?.ccdxSubscribeActivity?.(listener),
      preferences: () => { const { saved, theme, color_theme } = serviceSettingsSnapshot();return { ...saved, theme, color_theme }; } });
    const serviceControl = createServiceControl({ providerRuntime, clientIntegration: earlyIntegration, terminal: terminalConsole, clientVersions,
      adapterPort: ADAPTER_PORT, adapterHost: ADAPTER_HOST, manualUpdate: serviceWorker ? () => serviceWorker.requestUpdate() : undefined,
      nightlyStatus: () => serviceWorker?.status() || null, nightlyChanged: enabled => serviceWorker?.preferenceChanged(enabled) });
    const codexModelCatalog = createCodexModelCatalog();
    activeServer = await startAdapter(serviceWorker?.warming ? 0 : ADAPTER_PORT, serviceWorker?.warming ? "127.0.0.1" : ADAPTER_HOST, {
      log: startupLogger("Service"),
      failureHistoryFile: process.env.CCDX_DISABLE_USAGE === "1" ? undefined : failureHistoryPath(),
      autoReviewModelResolver: () => autoReviewPreference(),
      codexClient: providerRuntime.source("github").client,
      codexModelCatalog,
      codexModelRegistry: profileModels.codexRegistry,
      providerRuntime,
      showRequestId: CLI.showRequestId,
      upstreamTimeoutMs: RUNTIME.upstreamTimeoutMs,
      streamHandshakeTimeoutMs: RUNTIME.streamHandshakeTimeoutMs,
      streamIdleTimeoutMs: RUNTIME.streamIdleTimeoutMs,
      terminalAnimationTheme,
      terminalActivity: terminalConsole,
      handoffState: serviceWorker?.takeState(), isDraining: () => serviceWorker?.draining === true,
      dashboardOptions: { serviceControl, clientVersions, host: ADAPTER_HOST, port: ADAPTER_PORT,
        credentialsChanged: () => { defaultCopilotClient.invalidateCredentials();profileRuntime = createProfileRuntime({ codexClient: defaultCopilotClient }); },
        applyAnimation: theme => terminalConsole.apply({ theme }) },
      nativePredictionPac: () => clientIntegration?.pacUrl() || null,
      fixPrediction: async () => (await import("./prediction-control.mjs")).controlPrediction("repair", { integration: await clientIntegrations() }),
      clientIntegrationSnapshot: () => clientIntegration?.snapshot() || null,
    });

    // Point Codex App at the adapter.
    const { compressionSetup, imageEnabled, imageMcpSkipped } = codexEnabled ? await configureCodexClient() : { compressionSetup: Promise.resolve(), imageEnabled: false, imageMcpSkipped: false };

    // Optional native prediction setup must never prevent the core adapter from running.
    nativePrediction = await predictionSetup;
    const persistentRoute = await nativePrediction?.prepareRoute();

    // Launch Codex when available. A running App is never forcibly restarted.
    const imageHost = codexEnabled && imageEnabled && autoLaunchEnabled() ? await clientIntegration.imageHostLaunch() : null;
    if (codexEnabled) await openCodex({ predictionPacUrl: nativePrediction?.pacUrl, predictionApp: nativePrediction?.app, predictionProfile: nativePrediction?.profile, imageHost,
      preparePredictionRoute: () => nativePrediction?.prepareRoute(), persistedPredictionRoute: persistentRoute?.status === "installed",
      onPredictionRoute: route => clientIntegration?.launched(route), log: startupLogger("App") });
    console.log(predictionStartupCheck(clientIntegration?.snapshot().prediction));
    console.log(imageStartupCheck({ enabled: imageEnabled, prepared: Boolean(imageHost), skipped: imageMcpSkipped }));
    console.log(providerStartupChecks(activeServer.ccdxSnapshot?.()));

    // Periodically refresh the model list + endpoint cache so a long-running
    // adapter picks up newly released models without a restart.
    const refreshIntervalMs = RUNTIME.modelRefreshIntervalMs;
    if (Number.isFinite(refreshIntervalMs) && refreshIntervalMs > 0) {
      modelRefreshTimer = setInterval(() => {
        if (providerRuntime.selection().codex === "github") profileModels.refreshAll().then(() => providerRuntime.selection().codex === "github" && providerRuntime.syncClients(["codex"])).catch(() => {});
        providerRuntime.refresh().catch(() => {});
        void clientVersions.refresh().catch(() => {});
      }, refreshIntervalMs);
      modelRefreshTimer.unref?.();
    }

    startupComplete = true;
    if (!startupPresentation.enabled) console.log(startupReady({ baseUrl: adapterBaseUrl(ADAPTER_HOST, ADAPTER_PORT), commandName: CLI_NAME }));
    void clientVersions.refresh().catch(() => {});
    runInBackground(printUpdateNotice);
    await launchDashboard();
    if (!serviceWorker?.warming) {
      startupPresentation.finish();for (const [method, args] of startupPresentation.warnings) terminalConsole.log(method, args);
      terminalConsole.start();if (!terminalConsole.enabled && startupPresentation.enabled) process.stdout.write(startupReady({ baseUrl: adapterBaseUrl(ADAPTER_HOST, ADAPTER_PORT), commandName: CLI_NAME }));
      LOGGING.setTerminalSink((method, args) => terminalConsole.log(method, args));
    }

    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      LOGGING.setTerminalSink(serviceWorker?.draining ? () => {} : null);terminalConsole?.cleanup();
      console.log(`\n${status("wait", `Stopping: ${signal}`)}`);
      let exitCode = 0;
      try {
        if (modelRefreshTimer) clearInterval(modelRefreshTimer);
        versionMonitor?.close();
        const result = await closeHttpServer(activeServer, { timeoutMs: RUNTIME.shutdownTimeoutMs });
        if (result.forced) console.warn(status("warn", "Remaining service connections closed"));
        await clientIntegration?.close();
        await providerRuntime?.close();
        await flushUsageWrites();
      } catch (e) {
        exitCode = 1;
        console.error(status("err", `Could not stop: ${e.message}`));
      } finally {
        await LOGGING.cleanup();
        process.exit(exitCode);
      }
    };
    process.once("SIGINT", () => { void shutdown("SIGINT"); });
    process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
    await compressionSetup;
    if (serviceWorker) {
      const { clientStateFingerprint, serviceBusinessState } = await import("./service-worker.mjs");
      if (serviceWorker.preserving) providerRuntime.validateLocalKeys();
      await serviceWorker.ready({
        notice: code => console.warn(status("warn", `Update notice: ${code}. See Checks & repairs in the WebUI.`)),
        stop: () => shutdown("supervisor"),
        exportState: () => ({ ...activeServer.ccdxExportState(), providers: providerRuntime.exportPrivateState() }),
        importState: async state => { await activeServer.ccdxImportState(state);providerRuntime.importPrivateState(state.providers); },
        release: async () => {
          terminalConsole.pause();await flushUsageWrites();await LOGGING.cleanup();
          LOGGING = configureLogging({ env: { ...process.env, CCDX_LOG_PATH: "" } });LOGGING.setTerminalSink(() => {});
          await closeHttpServer(activeServer, { timeoutMs: RUNTIME.shutdownTimeoutMs });await earlyIntegration.pauseForUpdate();
        },
        resume: async () => {
          if (!activeServer.listening) await new Promise((resolve, reject) => { activeServer.once("error", reject);activeServer.listen(ADAPTER_PORT, ADAPTER_HOST, () => { activeServer.off("error", reject);resolve(); }); });
          await earlyIntegration.start({ autoSetup: false });earlyIntegration.setPredictionActive(servicePreferences().prediction_enabled);
          await LOGGING.cleanup();LOGGING = configureLogging();terminalConsole.start();LOGGING.setTerminalSink((method, args) => terminalConsole.log(method, args));
        },
        promote: async () => {
          await closeHttpServer(activeServer, { timeoutMs: RUNTIME.shutdownTimeoutMs });
          await new Promise((resolve, reject) => { activeServer.once("error", reject);activeServer.listen(ADAPTER_PORT, ADAPTER_HOST, () => { activeServer.off("error", reject);resolve(); }); });
          if (codexEnabled) { nativePrediction = await earlyIntegration.start({ autoSetup: false });await nativePrediction?.prepareRoute();earlyIntegration.setPredictionActive(servicePreferences().prediction_enabled); }
        },
        activate: async () => {
          await LOGGING.cleanup();try { LOGGING = configureLogging(); } catch { LOGGING = configureLogging({ env: { ...process.env, CCDX_LOG_PATH: "" } }); }
          terminalConsole.start();LOGGING.setTerminalSink((method, args) => terminalConsole.log(method, args));
          earlyIntegration.retireImages();
          setImmediate(() => void clientVersions.refresh().catch(() => {}));
        },
        inspect: () => {
          const data = activeServer.ccdxSnapshot(), routes = data.requests.by_route;
          let fingerprint = null;try { fingerprint = clientStateFingerprint(); } catch {}
          return { version: LOCAL_VERSION, fingerprint, business: serviceBusinessState(providerRuntime),
            busy: !fingerprint || activeServer.ccdxBusy() || clientIntegration.busy() || serviceControl.busy() || data.models.refresh_in_flight === true || data.model_activity.active === null,
            health: { github: profileRuntime.codexClient.runtimeStatus().token_cached === true && !profileModels.codexRegistry.lastError,
              m365: data.providers?.m365?.state === "ready", prediction: earlyIntegration.bridgeHealthy() },
            activity: { active: data.model_activity.active || 0, total: ["responses", "responses_compact", "messages"].reduce((n, key) => n + (routes[key]?.total || 0), data.image_generation?.total || 0) } };
        },
      });
    }
  } catch (e) {
    startupPresentation.finish();LOGGING.setTerminalSink(null);terminalConsole?.cleanup();
    console.error(status("err", e.message));
    await clientIntegration?.close().catch(() => {});
    await providerRuntime?.close().catch(() => {});
    await closeHttpServer(activeServer, { timeoutMs: RUNTIME.shutdownTimeoutMs }).catch(() => {});
    await flushUsageWrites();
    await LOGGING.cleanup();
    process.exit(1);
  }
}
