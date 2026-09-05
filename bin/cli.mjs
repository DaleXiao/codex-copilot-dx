#!/usr/bin/env node

import { ensureAuth, openCodex } from "../src/launcher.mjs";
import { ensureCodexConfig } from "../src/config.mjs";
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
import { cliCommandName, cliHelp, parseAdapterProbeOptions, parseCliArgs, parseRuntimeOptions } from "../src/cli-options.mjs";
import { formatAdapterStatus, readAdapterStatus } from "../src/cli-status.mjs";
import { closeHttpServer } from "../src/shutdown.mjs";
import { runAutoReviewModelCommand } from "../src/auto-review-model.mjs";
import { autoReviewModelPreference, terminalAnimationPreference } from "../src/user-settings.mjs";
import { fetchLiveCopilotModels, formatLiveCopilotModels } from "../src/cli-models.mjs";
import { runAuthCommand } from "../src/cli-auth.mjs";
import { createProfileRuntime } from "../src/profile-runtime.mjs";
import { createProfileModelRuntime } from "../src/profile-model-runtime.mjs";
import { createCodexModelCatalog } from "../src/codex-model-catalog.mjs";

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
if (CLI.command === "usage") {
  await printUsageSummary({
    format: CLI.outputFormat || "auto",
    output: process.stdout,
  });
  process.exit(0);
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
    const catalog = await fetchLiveCopilotModels({ profile: CLI.profile });
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
    await runAutoReviewModelCommand({ commandName: CLI_NAME });
    process.exit(0);
  } catch (e) {
    console.error(status("err", e.message));
    process.exit(1);
  }
}
if (CLI.command === "update") {
  try {
    const { runPackageUpdateCommand } = await import("../src/package-update.mjs");
    await runPackageUpdateCommand({ commandName: CLI_NAME, source: CLI.updateSource });
    process.exit(0);
  } catch (e) {
    console.error(status("err", e.message));
    process.exit(1);
  }
}
let RUNTIME;
try {
  RUNTIME = parseRuntimeOptions(process.env);
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

  console.log(status("ok", `Using existing adapter at ${running.baseUrl}`));
  ensureCodexConfig(ADAPTER_PORT, { host: ADAPTER_HOST });

  await openCodex();
  console.log(`
  ${status("ok", "Ready, using the existing ccdx adapter")}

  Adapter: ${running.baseUrl}
`);
  return true;
}

if (CLI.command === "doctor") {
  const checks = await runDoctor({
    commandName: CLI_NAME,
    port: ADAPTER_PORT,
    host: ADAPTER_HOST,
    online: CLI.online,
    compat: CLI.compat,
  });
  process.exit(checks.some((check) => check.kind === "err") ? 1 : 0);
}

console.log(`
  ${CLI_BANNER}
  Use Codex App with GitHub Copilot
`);

async function printUpdateNotice() {
  try {
    const { latestVersion, updateAvailable } = await checkForUpdate({ currentVersion: LOCAL_VERSION });
    if (!updateAvailable) return;
    console.log(`\n  ${status("warn", `Update available: ${LOCAL_VERSION} -> ${latestVersion}`)}`);
    console.log("  npm install -g codex-copilot-dx@latest\n");
  } catch {
    // Never block startup on the update check.
  }
}

try {
  assertSafeAdapterHost(ADAPTER_HOST, process.env);
  void runInBackground(printUpdateNotice);
  if (await reuseRunningAdapterIfAvailable()) process.exit(0);

  // Ensure GitHub login, using device flow if no token exists.
  await ensureAuth();

  const profileRuntime = createProfileRuntime({ codexClient: defaultCopilotClient });
  const profileModels = createProfileModelRuntime({
    codexClient: profileRuntime.codexClient,
    codexCredentialFingerprint: profileRuntime.codexCredentialFingerprint,
    timeoutMs: MODEL_REFRESH_TIMEOUT_MS,
    commandName: CLI_NAME,
    autoReviewModelResolver: () => autoReviewModelPreference().model,
  });

  // Refresh the VS Code version in the background; fallback is non-blocking.
  void refreshVSCodeVersion();
  await profileModels.initialize();

  if (!isLoopbackHost(ADAPTER_HOST)) {
    console.log(status("warn", `ADAPTER_HOST=${ADAPTER_HOST} exposes the adapter beyond loopback because CCDX_ALLOW_LAN=1 is set. Use only on trusted networks.`));
  }

  // Start the in-process adapter.
  const terminalAnimationTheme = terminalAnimationPreference().theme;
  const codexModelCatalog = createCodexModelCatalog();
  activeServer = await startAdapter(ADAPTER_PORT, ADAPTER_HOST, {
    autoReviewModelResolver: () => autoReviewModelPreference().model,
    codexClient: profileRuntime.codexClient,
    codexModelCatalog,
    codexModelRegistry: profileModels.codexRegistry,
    showRequestId: CLI.showRequestId,
    upstreamTimeoutMs: RUNTIME.upstreamTimeoutMs,
    streamHandshakeTimeoutMs: RUNTIME.streamHandshakeTimeoutMs,
    streamIdleTimeoutMs: RUNTIME.streamIdleTimeoutMs,
    terminalAnimationTheme,
  });

  // Point Codex App at the adapter.
  ensureCodexConfig(ADAPTER_PORT, { host: ADAPTER_HOST });

  // Launch Codex when available.
  await openCodex();

  // Periodically refresh the model list + endpoint cache so a long-running
  // adapter picks up newly released models without a restart.
  const refreshIntervalMs = RUNTIME.modelRefreshIntervalMs;
  if (Number.isFinite(refreshIntervalMs) && refreshIntervalMs > 0) {
    modelRefreshTimer = setInterval(() => {
      profileModels.refreshAll().catch(() => {});
    }, refreshIntervalMs);
    modelRefreshTimer.unref?.();
  }

  console.log(`
  ${status("ok", "Ready, Codex App is ready to use")}

  Adapter: ${adapterBaseUrl(ADAPTER_HOST, ADAPTER_PORT)}

  Press Ctrl+C to stop.
`);

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${status("wait", `Shutting down on ${signal}...`)}`);
    let exitCode = 0;
    try {
      if (modelRefreshTimer) clearInterval(modelRefreshTimer);
      const result = await closeHttpServer(activeServer, { timeoutMs: RUNTIME.shutdownTimeoutMs });
      if (result.forced) console.warn(status("warn", "Forced remaining adapter connections closed"));
      await flushUsageWrites();
    } catch (e) {
      exitCode = 1;
      console.error(status("err", `Shutdown failed: ${e.message}`));
    } finally {
      LOGGING.cleanup();
      process.exit(exitCode);
    }
  };
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
} catch (e) {
  console.error(status("err", e.message));
  await closeHttpServer(activeServer, { timeoutMs: RUNTIME.shutdownTimeoutMs }).catch(() => {});
  await flushUsageWrites();
  LOGGING.cleanup();
  process.exit(1);
}
