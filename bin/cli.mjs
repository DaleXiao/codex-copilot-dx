#!/usr/bin/env node

import { ensureAuth, openCodex } from "../src/launcher.mjs";
import { ensureCodexConfig } from "../src/config.mjs";
import { ensureClaudeConfig } from "../src/claude-config.mjs";
import { applyClaudeDesktopConfig, formatClaudeDesktopApplyResult, generatedClaudeDesktopApiKey, loadManagedClaudeDesktopApiKey } from "../src/claude-desktop-config.mjs";
import { startAdapter } from "../src/adapter.mjs";
import { cacheModelEndpoints, listModels, refreshVSCodeVersion } from "../src/copilot.mjs";
import { claudeDesktopModelDefsFromCopilotModels, claudeDesktopModelIds, codexAutoReviewModelStatus, gptModelIdsFromCopilotModels, parseModelAliasEnv } from "../src/models.mjs";
import { status } from "../src/status.mjs";
import { configureLogging } from "../src/log.mjs";
import { flushUsageWrites, printUsageSummary } from "../src/usage.mjs";
import { checkForUpdate, localPackageVersion } from "../src/version.mjs";
import { runDoctor } from "../src/doctor.mjs";
import { adapterBaseUrl, checkRunningAdapter } from "../src/running-adapter.mjs";
import { assertSafeAdapterHost, isLoopbackHost } from "../src/security.mjs";
import { isValidModelList, loadModelCache, saveModelCache } from "../src/model-cache.mjs";
import { initializeModelRegistry, runInBackground } from "../src/startup.mjs";
import { cliHelp, parseCliArgs, parseRuntimeOptions } from "../src/cli-options.mjs";
import { closeHttpServer } from "../src/shutdown.mjs";

const LOCAL_VERSION = localPackageVersion();
const CLI_BANNER = `codex-copilot-dx v${LOCAL_VERSION} by Dale Xiao`;

let CLI;
try {
  CLI = parseCliArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error("Run codex-copilot-dx --help for usage.");
  process.exit(2);
}

if (CLI.command === "help") {
  console.log(cliHelp());
  process.exit(0);
}
if (CLI.command === "version") {
  console.log(CLI_BANNER);
  process.exit(0);
}
if (CLI.command === "usage") {
  await printUsageSummary();
  process.exit(0);
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
const CONFIGURE_CLAUDE_DESKTOP = CLI.configureClaudeDesktop || process.env.CCDX_CONFIGURE_CLAUDE_DESKTOP === "1";
const LOGGING = configureLogging();
const MODEL_REGISTRY = { modelDefs: undefined, models: undefined, source: "built-in" };
let activeServer = null;
let modelRefreshTimer = null;
let shuttingDown = false;

if (LOGGING.filePath) {
  console.log(status("info", `Debug log: ${LOGGING.filePath}`));
  if (LOGGING.level === "debug") console.log(status("debug", "Debug logging enabled"));
}

function applyModelsToRegistry(models, source, { updateClaudeModels = true } = {}) {
  if (!isValidModelList(models)) throw new Error("Copilot models response contained no valid models");
  const modelDefs = updateClaudeModels
    ? claudeDesktopModelDefsFromCopilotModels(models)
    : MODEL_REGISTRY.modelDefs;
  cacheModelEndpoints(models);
  MODEL_REGISTRY.models = models;
  if (updateClaudeModels && modelDefs.length) {
    MODEL_REGISTRY.modelDefs = modelDefs;
    MODEL_REGISTRY.source = source;
  }
  return modelDefs;
}

function loadCachedModelRegistry() {
  const cached = loadModelCache();
  if (!cached) return false;
  try {
    const customAliases = parseModelAliasEnv(process.env.CCDX_CLAUDE_MODEL_ALIASES).length > 0;
    applyModelsToRegistry(cached, "cache", { updateClaudeModels: !customAliases });
    return true;
  } catch {
    return false;
  }
}

async function refreshClaudeDesktopModelDefs() {
  const customAliases = parseModelAliasEnv(process.env.CCDX_CLAUDE_MODEL_ALIASES).length > 0;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MODEL_REFRESH_TIMEOUT_MS);
  try {
    const { status: httpStatus, body } = await listModels({ signal: ctrl.signal });
    if (httpStatus < 200 || httpStatus >= 300) {
      throw new Error(`Copilot models returned HTTP ${httpStatus}`);
    }
    const models = JSON.parse(body);
    const autoReview = codexAutoReviewModelStatus(models);
    if (!autoReview.available) {
      console.log(status("warn", `Auto-review target ${autoReview.upstreamModel} is unavailable: ${autoReview.reason}. Run codex-copilot-dx doctor --compat to verify the live path.`));
    }
    const gptModelIds = gptModelIdsFromCopilotModels(models);
    if (gptModelIds.length) {
      console.log(status("ok", `Refreshed GPT models from GitHub Copilot: ${gptModelIds.join(", ")}`));
    } else {
      console.log(status("warn", "Copilot models response contained no GPT models"));
    }

    const modelDefs = applyModelsToRegistry(models, "live", { updateClaudeModels: !customAliases });
    try {
      saveModelCache(models);
    } catch (e) {
      console.log(status("warn", `Could not persist the Copilot model cache (${e.message})`));
    }
    if (customAliases) {
      console.log(status("info", "Using CCDX_CLAUDE_MODEL_ALIASES for Claude models"));
    } else if (modelDefs?.length) {
      console.log(status("ok", `Refreshed Claude models from GitHub Copilot: ${modelDefs.map((model) => model.id).join(", ")}`));
    } else {
      console.log(status("warn", "Copilot models response contained no Claude models; using built-in Claude models"));
    }
    return modelDefs;
  } catch (e) {
    const fallback = MODEL_REGISTRY.modelDefs?.length ? `${MODEL_REGISTRY.source} model list` : "built-in model list";
    const message = ctrl.signal.aborted
      ? `Model refresh timed out after ${MODEL_REFRESH_TIMEOUT_MS}ms; using ${fallback}`
      : `Could not refresh model list; using ${fallback} (${e.message})`;
    console.log(status("warn", message));
    return MODEL_REGISTRY.modelDefs;
  } finally {
    clearTimeout(timer);
  }
}

function currentClaudeDesktopApiKey() {
  return String(process.env.CCDX_CLAUDE_DESKTOP_API_KEY || process.env.CCDX_PROXY_API_KEY || "").trim();
}

async function reuseRunningAdapterIfAvailable() {
  const running = await checkRunningAdapter({
    port: ADAPTER_PORT,
    host: ADAPTER_HOST,
    timeoutMs: EXISTING_ADAPTER_TIMEOUT_MS,
  });
  if (running.incompatible) {
    const found = running.data?.version || "unknown";
    throw new Error(`Adapter ${found} is already running at ${running.baseUrl}, but this CLI is ${LOCAL_VERSION}. Stop the existing process and run codex-copilot-dx again.`);
  }
  if (!running.ok) return false;

  console.log(status("ok", `Using existing adapter at ${running.baseUrl}`));
  ensureCodexConfig(ADAPTER_PORT, { host: ADAPTER_HOST });
  ensureClaudeConfig(ADAPTER_PORT, { host: ADAPTER_HOST });

  if (CONFIGURE_CLAUDE_DESKTOP) {
    const claudeDesktopApiKey = currentClaudeDesktopApiKey();
    if (claudeDesktopApiKey) {
      const result = applyClaudeDesktopConfig({
        port: ADAPTER_PORT,
        host: ADAPTER_HOST,
        gatewayApiKey: claudeDesktopApiKey,
        modelIds: claudeDesktopModelIds(process.env),
      });
      console.log(status("ok", `Configured Claude App gateway profile at ${result.baseUrl}`));
      console.log(formatClaudeDesktopApplyResult(result));
    } else {
      console.log(status("warn", "Existing adapter is running; skip Claude App profile update unless CCDX_CLAUDE_DESKTOP_API_KEY or CCDX_PROXY_API_KEY is set"));
    }
  } else {
    console.log(status("ok", "Claude App support available with --configure-claude-desktop"));
  }

  await openCodex();
  console.log(`
  ${status("ok", "Ready, using the existing codex-copilot-dx adapter")}

  Adapter: ${running.baseUrl}
`);
  return true;
}

if (CLI.command === "doctor") {
  const checks = await runDoctor({
    port: ADAPTER_PORT,
    host: ADAPTER_HOST,
    online: CLI.online,
    compat: CLI.compat,
  });
  process.exit(checks.some((check) => check.kind === "err") ? 1 : 0);
}

console.log(`
  ${CLI_BANNER}
  Use Codex Desktop, Claude Code, and Claude App with GitHub Copilot
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

  // Refresh the VS Code version in the background; fallback is non-blocking.
  void refreshVSCodeVersion();
  const modelInitialization = await initializeModelRegistry({
    loadCached: loadCachedModelRegistry,
    currentModelDefs: () => MODEL_REGISTRY.modelDefs,
    refresh: refreshClaudeDesktopModelDefs,
  });
  const claudeDesktopModelDefs = modelInitialization.modelDefs;

  if (!isLoopbackHost(ADAPTER_HOST)) {
    console.log(status("warn", `ADAPTER_HOST=${ADAPTER_HOST} exposes the adapter beyond loopback because CCDX_ALLOW_LAN=1 is set. Use only on trusted networks.`));
  }

  const configuredClaudeDesktopApiKey = currentClaudeDesktopApiKey();
  const restoredClaudeDesktopApiKey = configuredClaudeDesktopApiKey ? "" : loadManagedClaudeDesktopApiKey({
    port: ADAPTER_PORT,
    host: ADAPTER_HOST,
  });
  if (restoredClaudeDesktopApiKey) {
    console.log(status("ok", "Restored Claude App gateway key from the managed profile"));
  }
  const claudeDesktopApiKey = configuredClaudeDesktopApiKey
    || restoredClaudeDesktopApiKey
    || (CONFIGURE_CLAUDE_DESKTOP ? generatedClaudeDesktopApiKey() : "");

  // Start the in-process adapter.
  activeServer = await startAdapter(ADAPTER_PORT, ADAPTER_HOST, {
    claudeDesktopApiKey,
    claudeDesktopModelDefs,
    modelRegistry: MODEL_REGISTRY,
    showRequestId: CLI.showRequestId,
    upstreamTimeoutMs: RUNTIME.upstreamTimeoutMs,
    streamHandshakeTimeoutMs: RUNTIME.streamHandshakeTimeoutMs,
    streamIdleTimeoutMs: RUNTIME.streamIdleTimeoutMs,
  });

  // Point Codex and Claude Code at the adapter.
  ensureCodexConfig(ADAPTER_PORT, { host: ADAPTER_HOST });
  ensureClaudeConfig(ADAPTER_PORT, { host: ADAPTER_HOST });
  if (CONFIGURE_CLAUDE_DESKTOP) {
    const result = applyClaudeDesktopConfig({
      port: ADAPTER_PORT,
      host: ADAPTER_HOST,
      gatewayApiKey: claudeDesktopApiKey,
      modelIds: claudeDesktopModelIds(process.env, { modelDefs: claudeDesktopModelDefs }),
    });
    console.log(status("ok", `Configured Claude App gateway profile at ${result.baseUrl}`));
    console.log(formatClaudeDesktopApplyResult(result));
  } else {
    console.log(status("ok", "Claude App support available with --configure-claude-desktop"));
  }

  // Launch Codex when available.
  await openCodex();

  // Periodically refresh the model list + endpoint cache so a long-running
  // adapter picks up newly released models without a restart.
  const refreshIntervalMs = RUNTIME.modelRefreshIntervalMs;
  if (Number.isFinite(refreshIntervalMs) && refreshIntervalMs > 0) {
    modelRefreshTimer = setInterval(() => {
      refreshClaudeDesktopModelDefs().catch(() => {});
    }, refreshIntervalMs);
    modelRefreshTimer.unref?.();
  }

  console.log(`
  ${status("ok", "Ready, Claude Code, Claude App and Codex App are now ready to use")}

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
