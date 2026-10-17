#!/usr/bin/env node

import { ensureAuth, openCodex } from "../src/launcher.mjs";
import { startAdapter } from "../src/adapter.mjs";
import { defaultCopilotClient, refreshVSCodeVersion } from "../src/copilot.mjs";
import { status } from "../src/status.mjs";
import { configureLogging } from "../src/log.mjs";
import { flushUsageWrites, printUsageSummary } from "../src/usage.mjs";
import { checkForUpdate, localPackageVersion } from "../src/version.mjs";
import { runDoctor } from "../src/doctor.mjs";
import { adapterBaseUrl, checkRunningAdapter } from "../src/running-adapter.mjs";
import { assertSafeAdapterHost, isLoopbackHost } from "../src/security.mjs";
import { runInBackground } from "../src/startup.mjs";
import { cliCommandName, cliHelp, parseAdapterAddressOptions, parseAdapterProbeOptions, parseCliArgs, parseRuntimeOptions } from "../src/cli-options.mjs";
import { formatAdapterStatus, readAdapterStatus } from "../src/cli-status.mjs";
import { closeHttpServer } from "../src/shutdown.mjs";
import { autoReviewModelPreference, autoReviewPreference, responseHistoryLimitPreference, terminalAnimationPreference, servicePreferences } from "../src/user-settings.mjs";
import { formatLiveCopilotModels } from "../src/cli-models.mjs";
import { runAuthCommand } from "../src/cli-auth.mjs";
import { createProfileRuntime } from "../src/profile-runtime.mjs";
import { createProfileModelRuntime } from "../src/profile-model-runtime.mjs";
import { createCodexModelCatalog } from "../src/codex-model-catalog.mjs";
import { createProviderRuntime } from "../src/provider-runtime.mjs";
import { setResponseHistoryMaxBytes } from "../src/response-history.mjs";
import { startupBanner, startupCheck, startupReady, startupLogger, predictionStartupCheck, providerStartupChecks } from "../src/startup-ui.mjs";
import { createTerminalConsole } from "../src/terminal-console.mjs";
import { createServiceControl } from "../src/service-control.mjs";
import { openDashboard } from "../src/browser-launch.mjs";

const LOCAL_VERSION = localPackageVersion();
const CLI_NAME = cliCommandName();
const CLI_BANNER = `${CLI_NAME} v${LOCAL_VERSION} by Dale Xiao`;

let CLI;
try {
  CLI = parseCliArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error(`Run ${CLI_NAME} --help for usage.`);
  process.exit(2);
}

if (CLI.command === "help") {
  console.log(cliHelp(CLI_NAME, CLI.helpTopic));
  process.exit(0);
}
if (CLI.command === "version") {
  console.log(CLI_BANNER);
  process.exit(0);
}
if (CLI.command === "m365") {
  try {
    const { runM365Command } = await import("../src/cli-m365.mjs");
    const address = parseAdapterAddressOptions(process.env);
    await runM365Command({ ...CLI, host: address.adapterHost, port: address.adapterPort });
    process.exit(0);
  } catch (error) { console.error(status("err", error.message));process.exit(1); }
}
if (CLI.command === "animation") {
  try {
    const { runAnimationCommand } = await import("../src/cli-animation.mjs");
    await runAnimationCommand({ commandName: CLI_NAME });
    process.exit(0);
  } catch (e) {
    console.error(status("err", e.message));
    process.exit(1);
  }
}
if (CLI.command === "image") {
  try {
    const address = CLI.action === "enable"
      ? parseAdapterAddressOptions(process.env)
      : { adapterPort: 2026, adapterHost: "127.0.0.1" };
    const { runImageCommand } = await import("../src/cli-image.mjs");
    await runImageCommand({
      action: CLI.action,
      commandName: CLI_NAME,
      adapterPort: address.adapterPort,
      adapterHost: address.adapterHost,
    });
    process.exit(0);
  } catch (e) {
    console.error(status("err", e.message));
    process.exit(1);
  }
}
if (CLI.command === "suggestion") {
  try {
    const { retirePredictionIntegration } = await import("../src/prediction-retirement.mjs");
    const result = retirePredictionIntegration({ dryRun: CLI.action === "status" });
    console.log("The CCDX prediction panel has been retired and cannot be enabled.");
    if (CLI.action === "status" && result.changed) console.log(`Legacy settings remain; run ${CLI_NAME} suggestion off to clean them up.`);
    if (result.preserved) console.warn("Modified prediction settings were preserved.");
    process.exit(0);
  } catch (error) {
    console.error(status("err", error.message));
    process.exit(1);
  }
}
if (CLI.command === "prediction") {
  try {
    const { runPredictionCommand } = await import("../src/native-prediction.mjs");
    const result = await runPredictionCommand({ action: CLI.action, repairRuntime: async () => {
      const { requestPredictionFix } = await import("../src/native-prediction-fix.mjs");
      const probe = parseAdapterProbeOptions(process.env);
      return requestPredictionFix({ host: probe.adapterHost, port: probe.adapterPort });
    }, runtimeSnapshot: () => {
      const probe = parseAdapterProbeOptions(process.env);
      return readAdapterStatus({ host: probe.adapterHost, port: probe.adapterPort, timeoutMs: probe.existingAdapterTimeoutMs }).then(({ data }) => data);
    } });
    process.exit(CLI.action === "fix" ? result.exitCode : 0);
  } catch (error) {
    console.error(status("err", error.message));
    process.exit(1);
  }
}
if (CLI.command === "usage") {
  try {
    await printUsageSummary({
      format: CLI.outputFormat || "auto",
      provider: CLI.provider || "",
      output: process.stdout,
    });
    process.exit(0);
  } catch (e) {
    console.error(status("err", e.message));
    process.exit(1);
  }
}
if (CLI.command === "cache") {
  try {
    const probe = parseAdapterProbeOptions(process.env);
    const { runCacheCommand } = await import("../src/cli-cache.mjs");
    await runCacheCommand({
      action: CLI.action,
      limitMib: CLI.limitMib,
      resetLimit: CLI.resetLimit,
      history: CLI.history,
      yes: CLI.yes,
      host: probe.adapterHost,
      port: probe.adapterPort,
      timeoutMs: probe.existingAdapterTimeoutMs,
    });
    process.exit(0);
  } catch (e) {
    console.error(status("err", e.message));
    process.exit(1);
  }
}
if (CLI.command === "limits") {
  try {
    const probe = parseAdapterProbeOptions(process.env);
    const { runLimitsCommand } = await import("../src/cli-limits.mjs");
    await runLimitsCommand({
      action: CLI.action,
      limitMib: CLI.limitMib,
      resetLimit: CLI.resetLimit,
      host: probe.adapterHost,
      port: probe.adapterPort,
      timeoutMs: probe.existingAdapterTimeoutMs,
    });
    process.exit(0);
  } catch (e) {
    console.error(status("err", e.message));
    process.exit(1);
  }
}
if (CLI.command === "retired") {
  console.error(status("err", `${CLI.integration} integration was retired in ccdx 0.7.0.`));
  if (CLI.integration === "PM Studio") {
    console.error(status("info", "Update or reinstall PM Studio to remove an older CCDX app patch."));
  } else {
    console.error(status("info", "Remove any old CCDX endpoint from the client before using a different provider."));
  }
  process.exit(1);
}
if (CLI.command === "auth") {
  try {
    const result = await runAuthCommand({
      action: CLI.action,
      profile: CLI.profile,
      online: CLI.online,
      reauth: CLI.reauth,
      expectedLogin: CLI.expectedLogin,
      commandName: CLI_NAME,
      format: CLI.outputFormat || "auto",
      output: process.stdout,
    });
    if (result.output) console.log(result.output);
    process.exit(0);
  } catch (e) {
    console.error(status("err", e.message));
    process.exit(1);
  }
}
if (CLI.command === "status") {
  let probe;
  try {
    probe = parseAdapterProbeOptions(process.env);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  try {
    const snapshot = await readAdapterStatus({
      host: probe.adapterHost,
      port: probe.adapterPort,
      timeoutMs: probe.existingAdapterTimeoutMs,
    });
    console.log(formatAdapterStatus(snapshot, { commandName: CLI_NAME, cliVersion: LOCAL_VERSION }));
    process.exit(0);
  } catch (e) {
    console.error(status("err", e.message));
    process.exit(1);
  }
}
if (CLI.command === "models") {
  try {
    const { fetchActiveProviderModels } = await import("../src/cli-m365.mjs");
    const catalog = await fetchActiveProviderModels();
    console.log(formatLiveCopilotModels(catalog, {
      commandName: CLI_NAME,
      format: CLI.outputFormat || "auto",
      output: process.stdout,
    }));
    process.exit(0);
  } catch (e) {
    console.error(status("err", e.message));
    process.exit(1);
  }
}
if (CLI.command === "auto-review-model") {
  try {
    const { runProviderAutoReviewCommand } = await import("../src/cli-m365.mjs");
    const address = parseAdapterAddressOptions(process.env);
    await runProviderAutoReviewCommand({ commandName: CLI_NAME, host: address.adapterHost, port: address.adapterPort });
    process.exit(0);
  } catch (e) {
    console.error(status("err", e.message));
    process.exit(1);
  }
}
if (CLI.command === "update") {
  try {
    const { runPackageUpdateCommand } = await import("../src/package-update.mjs");
    await runPackageUpdateCommand({ commandName: CLI_NAME, source: CLI.updateSource, allowRemote: CLI.allowRemote });
    process.exit(0);
  } catch (e) {
    console.error(status("err", e.message));
    process.exit(1);
  }
}
if (CLI.command === "doctor" && CLI.configOnly) {
  let probe;
  try {
    probe = parseAdapterAddressOptions(process.env);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const checks = await runDoctor({
    commandName: CLI_NAME,
    configOnly: true,
    host: probe.adapterHost,
    port: probe.adapterPort,
  });
  process.exit(checks.some((check) => check.kind === "err") ? 1 : 0);
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
const LOGGING = configureLogging();
let activeServer = null;
let modelRefreshTimer = null;
let shuttingDown = false;
let nativePrediction = null;
let clientIntegration = null;
let providerRuntime = null;
let terminalConsole = null;
const webUiUrl = `http://${ADAPTER_HOST === "::1" ? "[::1]" : "127.0.0.1"}:${ADAPTER_PORT}`;
async function launchDashboard() {
  try {
    const result = await openDashboard(webUiUrl, { enabled: !CLI.noBrowser && servicePreferences().open_webui });
    if (result.state === "unavailable") console.warn(startupCheck("warn", "WebUI", `Browser unavailable; open ${webUiUrl}`));
  } catch (error) { console.warn(startupCheck("warn", "WebUI", error.message)); }
}

async function clientIntegrations() {
  if (!clientIntegration) {
    const { createClientIntegration } = await import("../src/client-integration.mjs");
    clientIntegration = createClientIntegration({ port: ADAPTER_PORT, host: ADAPTER_HOST,
      configLog: startupLogger("Config"),
      info: (message) => console.log(startupCheck("info", "Client", message)), warning: (message) => console.warn(startupCheck("warn", "Client", message)) });
  }
  return clientIntegration;
}

if (LOGGING.filePath) {
  console.log(status("info", `Debug log: ${LOGGING.filePath}`));
  if (LOGGING.level === "debug") console.log(status("debug", "Debug logging enabled"));
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

  const serviceStatus = readAdapterStatus({ host: ADAPTER_HOST, port: ADAPTER_PORT }).catch(() => null);
  console.log(startupCheck("ok", "Adapter", `Using existing service at ${running.baseUrl}`));
  console.log(startupCheck("info", "Auth", "Using existing service credentials; not rechecked"));
  const { compressionSetup, imageEnabled, imageMcpSkipped } = await configureCodexClient();

  let predictionPacUrl = null;
  let predictionApp = null;
  let predictionProfile = null;
  let persistedPredictionRoute = false;
  let predictionConfigured = false;
  let launchRoute = "unknown";
  try {
    const { readPredictionSettings } = await import("../src/native-prediction-profile.mjs");
    const preference = readPredictionSettings();
    predictionConfigured = preference.enabled;
    if (preference.enabled) {
      predictionPacUrl = running.data?.native_prediction_pac || null;
      predictionApp = preference.app?.app;
      predictionProfile = preference.app?.profile;
      const { hasInstalledPredictionRoute } = await import("../src/native-prediction-route.mjs");
      const { predictionPaths } = await import("../src/native-prediction-profile.mjs");
      persistedPredictionRoute = hasInstalledPredictionRoute({ ...predictionPaths({ app: preference.app }), pacUrl: predictionPacUrl });
      if (!predictionPacUrl) console.warn(status("warn", "Restart ccdx to activate the newly enabled prediction bridge"));
    }
  } catch (error) { console.warn(status("warn", error.message)); }
  await openCodex({ predictionPacUrl, predictionApp, predictionProfile, persistedPredictionRoute,
    onPredictionRoute: route => { launchRoute = route; }, log: startupLogger("App") });
  console.log(predictionStartupCheck({ configured: predictionConfigured, bridge: predictionPacUrl ? "running" : "unknown", launch_route: launchRoute }));
  console.log(startupCheck(imageEnabled && imageMcpSkipped ? "warn" : "info", "Images", imageEnabled
    ? imageMcpSkipped ? "Client setup skipped; see warning above" : "Configured; provider not tested" : "Off"));
  console.log(providerStartupChecks((await serviceStatus)?.data));
  console.log(startupReady({ baseUrl: running.baseUrl, commandName: CLI_NAME, reused: true }));
  await launchDashboard();
  await compressionSetup;
  return true;
}

async function configureCodexClient() {
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
      const { inspectWindowsCommand } = await import("../src/windows-command.mjs");
      const command = inspectWindowsCommand({ repair: true });
      if (command.changed) console.log(startupCheck("ok", "Command", "Windows command entry updated; use ccdx next time"));
      else if (command.status === "preserved") console.warn(startupCheck("warn", "Command", "Existing launcher preserved; use ccdx.cmd doctor to inspect it"));
    } catch { console.warn(startupCheck("warn", "Command", "Optional command setup skipped; core startup will continue")); }
  }
  const updateNotice = runInBackground(printUpdateNotice);
  if (await reuseRunningAdapterIfAvailable()) {
    // Ready is already displayed; finish the bounded check before this short-lived CLI exits.
    await updateNotice;
    await LOGGING.cleanup();
    process.exit(0);
  }

  // Restore the opted-in listener alongside authentication/model initialization;
  // a slow company-proxy setup must not delay the core listener.
  const earlyIntegration = await clientIntegrations();
  const predictionSetup = runInBackground(() => earlyIntegration.start());

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
    corePort: ADAPTER_PORT,
    githubCredentialFingerprint: () => profileRuntime.codexCredentialFingerprint,
    log: (kind, message) => console.log(startupComplete ? status(kind, message) : startupCheck(kind, "M365", message)) });
  const m365Setup = runInBackground(() => providerRuntime.start());
  if (providerRuntime.selection().codex === "github") {
    try { await ensureAuth({ log: startupLogger("Auth") }); }
    catch (error) { if (!await m365Setup) throw error;console.warn(startupCheck("warn", "Auth", "GitHub authorization is unavailable; Microsoft 365 is independent. Check ccdx m365 status or switch")); }
  } else {
    await m365Setup;
    console.log(startupCheck("info", "Provider", "Codex uses the explicitly selected Microsoft 365 backup"));
  }
  profileRuntime = createProfileRuntime({ codexClient: defaultCopilotClient });

  // Refresh the VS Code version in the background; fallback is non-blocking.
  void refreshVSCodeVersion();
  if (providerRuntime.selection().codex === "github") await profileModels.initialize();
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
    preferences: () => ({ ...servicePreferences(), theme: terminalAnimationPreference().theme }) });
  const serviceControl = createServiceControl({ providerRuntime, clientIntegration: earlyIntegration, terminal: terminalConsole });
  const codexModelCatalog = createCodexModelCatalog();
  activeServer = await startAdapter(ADAPTER_PORT, ADAPTER_HOST, {
    log: startupLogger("Adapter"),
    autoReviewModelResolver: () => autoReviewPreference(),
    codexClient: profileRuntime.codexClient,
    codexModelCatalog,
    codexModelRegistry: profileModels.codexRegistry,
    providerRuntime,
    showRequestId: CLI.showRequestId,
    upstreamTimeoutMs: RUNTIME.upstreamTimeoutMs,
    streamHandshakeTimeoutMs: RUNTIME.streamHandshakeTimeoutMs,
    streamIdleTimeoutMs: RUNTIME.streamIdleTimeoutMs,
    terminalAnimationTheme,
    terminalActivity: terminalConsole,
    dashboardOptions: { serviceControl, applyAnimation: theme => terminalConsole.apply({ theme }) },
    nativePredictionPac: () => clientIntegration?.pacUrl() || null,
    fixPrediction: async () => (await clientIntegrations()).fix(),
    clientIntegrationSnapshot: () => clientIntegration?.snapshot() || null,
  });

  // Point Codex App at the adapter.
  const { compressionSetup, imageEnabled, imageMcpSkipped } = await configureCodexClient();

  // Optional native prediction setup must never prevent the core adapter from running.
  nativePrediction = await predictionSetup;
  const persistentRoute = await nativePrediction?.prepareRoute();

  // Launch Codex when available. A running App is never forcibly restarted.
  await openCodex({ predictionPacUrl: nativePrediction?.pacUrl, predictionApp: nativePrediction?.app, predictionProfile: nativePrediction?.profile,
    preparePredictionRoute: () => nativePrediction?.prepareRoute(), persistedPredictionRoute: persistentRoute?.status === "installed",
    onPredictionRoute: route => clientIntegration?.launched(route), log: startupLogger("App") });
  console.log(predictionStartupCheck(clientIntegration?.snapshot().prediction));
  console.log(startupCheck(imageEnabled && imageMcpSkipped ? "warn" : "info", "Images", imageEnabled
    ? imageMcpSkipped ? "Client setup skipped; see warning above" : "Configured; provider not tested" : "Off"));
  console.log(providerStartupChecks(activeServer.ccdxSnapshot?.()));

  // Periodically refresh the model list + endpoint cache so a long-running
  // adapter picks up newly released models without a restart.
  const refreshIntervalMs = RUNTIME.modelRefreshIntervalMs;
  if (Number.isFinite(refreshIntervalMs) && refreshIntervalMs > 0) {
    modelRefreshTimer = setInterval(() => {
      if (providerRuntime.selection().codex === "github") profileModels.refreshAll().catch(() => {});
      providerRuntime.refresh().catch(() => {});
    }, refreshIntervalMs);
    modelRefreshTimer.unref?.();
  }

  startupComplete = true;
  console.log(startupReady({ baseUrl: adapterBaseUrl(ADAPTER_HOST, ADAPTER_PORT), commandName: CLI_NAME }));
  await launchDashboard();
  terminalConsole.start();LOGGING.setTerminalSink((method, args) => terminalConsole.log(method, args));

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    LOGGING.setTerminalSink(null);terminalConsole?.cleanup();
    console.log(`\n${status("wait", `Shutting down on ${signal}...`)}`);
    let exitCode = 0;
    try {
      if (modelRefreshTimer) clearInterval(modelRefreshTimer);
      await clientIntegration?.close();
      await providerRuntime?.close();
      const result = await closeHttpServer(activeServer, { timeoutMs: RUNTIME.shutdownTimeoutMs });
      if (result.forced) console.warn(status("warn", "Forced remaining adapter connections closed"));
      await flushUsageWrites();
    } catch (e) {
      exitCode = 1;
      console.error(status("err", `Shutdown failed: ${e.message}`));
    } finally {
      await LOGGING.cleanup();
      process.exit(exitCode);
    }
  };
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  await compressionSetup;
} catch (e) {
  LOGGING.setTerminalSink(null);terminalConsole?.cleanup();
  console.error(status("err", e.message));
  await clientIntegration?.close().catch(() => {});
  await providerRuntime?.close().catch(() => {});
  await closeHttpServer(activeServer, { timeoutMs: RUNTIME.shutdownTimeoutMs }).catch(() => {});
  await flushUsageWrites();
  await LOGGING.cleanup();
  process.exit(1);
}
