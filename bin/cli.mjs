#!/usr/bin/env node

import { ensureAuth, openCodex } from "../src/launcher.mjs";
import { ensureCodexConfig } from "../src/config.mjs";
import { ensureClaudeConfig } from "../src/claude-config.mjs";
import { applyClaudeDesktopConfig, formatClaudeDesktopApplyResult, generatedClaudeDesktopApiKey } from "../src/claude-desktop-config.mjs";
import { startAdapter } from "../src/adapter.mjs";
import { listModels, refreshVSCodeVersion } from "../src/copilot.mjs";
import { claudeDesktopModelDefsFromCopilotModels, claudeDesktopModelIds, gptModelIdsFromCopilotModels, parseModelAliasEnv } from "../src/models.mjs";
import { status } from "../src/status.mjs";
import { configureLogging } from "../src/log.mjs";
import { printUsageSummary } from "../src/usage.mjs";
import { checkForUpdate, localPackageVersion } from "../src/version.mjs";
import { runDoctor } from "../src/doctor.mjs";
import { checkRunningAdapter } from "../src/running-adapter.mjs";
import { assertSafeAdapterHost, isLoopbackHost } from "../src/security.mjs";

const ADAPTER_PORT = parseInt(process.env.ADAPTER_PORT || "2026");
const ADAPTER_HOST = process.env.ADAPTER_HOST || "127.0.0.1";
const MODEL_REFRESH_TIMEOUT_MS = parseInt(process.env.CCDX_MODEL_REFRESH_TIMEOUT_MS || "5000", 10);
const EXISTING_ADAPTER_TIMEOUT_MS = parseInt(process.env.CCDX_EXISTING_ADAPTER_TIMEOUT_MS || "500", 10);
const LOCAL_VERSION = localPackageVersion();
const command = process.argv[2];
const CONFIGURE_CLAUDE_DESKTOP = command === "--configure-claude-desktop" || process.env.CCDX_CONFIGURE_CLAUDE_DESKTOP === "1";
const LOGGING = configureLogging();

if (LOGGING.filePath) {
  console.log(status("info", `Debug log: ${LOGGING.filePath}`));
  if (LOGGING.level === "debug") console.log(status("debug", "Debug logging enabled"));
}

async function refreshClaudeDesktopModelDefs() {
  if (parseModelAliasEnv(process.env.CCDX_CLAUDE_MODEL_ALIASES).length) {
    console.log(status("info", "Using CCDX_CLAUDE_MODEL_ALIASES for Claude models"));
    return undefined;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MODEL_REFRESH_TIMEOUT_MS);
  try {
    const { status: httpStatus, body } = await listModels({ signal: ctrl.signal });
    if (httpStatus < 200 || httpStatus >= 300) {
      throw new Error(`Copilot models returned HTTP ${httpStatus}`);
    }
    const models = JSON.parse(body);
    const gptModelIds = gptModelIdsFromCopilotModels(models);
    if (gptModelIds.length) {
      console.log(status("ok", `Refreshed GPT models from GitHub Copilot: ${gptModelIds.join(", ")}`));
    } else {
      console.log(status("warn", "Copilot models response contained no GPT models"));
    }

    const modelDefs = claudeDesktopModelDefsFromCopilotModels(models);
    if (!modelDefs.length) throw new Error("Copilot models response contained no Claude models");
    console.log(status("ok", `Refreshed Claude models from GitHub Copilot: ${modelDefs.map((model) => model.id).join(", ")}`));
    return modelDefs;
  } catch (e) {
    console.log(status("warn", `Could not refresh Claude models; using built-in model list (${e.message})`));
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function currentClaudeDesktopApiKey() {
  return process.env.CCDX_CLAUDE_DESKTOP_API_KEY || process.env.CCDX_PROXY_API_KEY || "";
}

async function reuseRunningAdapterIfAvailable() {
  const running = await checkRunningAdapter({
    port: ADAPTER_PORT,
    host: ADAPTER_HOST,
    timeoutMs: EXISTING_ADAPTER_TIMEOUT_MS,
  });
  if (!running.ok) return false;

  console.log(status("ok", `Using existing adapter at ${running.baseUrl}`));
  ensureCodexConfig(ADAPTER_PORT);
  ensureClaudeConfig(ADAPTER_PORT);

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

  openCodex();
  console.log(`
  ${status("ok", "Ready, using the existing codex-copilot-dx adapter")}

  Adapter: ${running.baseUrl}
`);
  return true;
}

if (command === "--version" || command === "-v" || command === "version") {
  console.log(`codex-copilot-dx v${LOCAL_VERSION}`);
  process.exit(0);
}

if (command === "usage") {
  await printUsageSummary();
  process.exit(0);
}

if (command === "doctor" || command === "--doctor") {
  await runDoctor({ port: ADAPTER_PORT, host: ADAPTER_HOST });
  process.exit(0);
}

console.log(`
  codex-copilot-dx v${LOCAL_VERSION}
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

// Await the update check up front so the notice is shown even on the
// "reuse existing adapter" path, which exits early below.
await printUpdateNotice();

try {
  assertSafeAdapterHost(ADAPTER_HOST, process.env);
  if (await reuseRunningAdapterIfAvailable()) process.exit(0);

  // Ensure GitHub login, using device flow if no token exists.
  await ensureAuth();

  // Refresh the VS Code version in the background; fallback is non-blocking.
  refreshVSCodeVersion();
  const claudeDesktopModelDefs = await refreshClaudeDesktopModelDefs();

  if (!isLoopbackHost(ADAPTER_HOST)) {
    console.log(status("warn", `ADAPTER_HOST=${ADAPTER_HOST} exposes the adapter beyond loopback because CCDX_ALLOW_LAN=1 is set. Use only on trusted networks.`));
  }

  const claudeDesktopApiKey = CONFIGURE_CLAUDE_DESKTOP
    ? (currentClaudeDesktopApiKey() || generatedClaudeDesktopApiKey())
    : currentClaudeDesktopApiKey();

  // Start the in-process adapter.
  await startAdapter(ADAPTER_PORT, ADAPTER_HOST, { claudeDesktopApiKey, claudeDesktopModelDefs });

  // Point Codex and Claude Code at the adapter.
  ensureCodexConfig(ADAPTER_PORT);
  ensureClaudeConfig(ADAPTER_PORT);
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
  openCodex();

  // Periodically refresh the model list + endpoint cache so a long-running
  // adapter picks up newly released models without a restart.
  const refreshIntervalMs = parseInt(process.env.CCDX_MODEL_REFRESH_INTERVAL_MS || String(30 * 60 * 1000), 10);
  if (Number.isFinite(refreshIntervalMs) && refreshIntervalMs > 0) {
    const timer = setInterval(() => {
      refreshClaudeDesktopModelDefs().catch(() => {});
    }, refreshIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  console.log(`
  ${status("ok", "Ready, Claude Code, Claude App and Codex App are now ready to use")}

  Adapter: http://${ADAPTER_HOST}:${ADAPTER_PORT}

  Press Ctrl+C to stop.
`);

  process.on("SIGINT", () => {
    console.log(`\n${status("wait", "Shutting down...")}`);
    process.exit(0);
  });
} catch (e) {
  console.error(status("err", e.message));
  process.exit(1);
}
