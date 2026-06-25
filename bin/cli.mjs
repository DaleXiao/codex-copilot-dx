#!/usr/bin/env node

import { ensureAuth, openCodex } from "../src/launcher.mjs";
import { ensureCodexConfig } from "../src/config.mjs";
import { ensureClaudeConfig } from "../src/claude-config.mjs";
import { applyClaudeDesktopConfig, formatClaudeDesktopApplyResult, generatedClaudeDesktopApiKey } from "../src/claude-desktop-config.mjs";
import { startAdapter } from "../src/adapter.mjs";
import { refreshVSCodeVersion } from "../src/copilot.mjs";
import { status } from "../src/status.mjs";
import { printUsageSummary } from "../src/usage.mjs";
import { checkForUpdate, localPackageVersion } from "../src/version.mjs";

const ADAPTER_PORT = parseInt(process.env.ADAPTER_PORT || "2026");
const ADAPTER_HOST = process.env.ADAPTER_HOST || "127.0.0.1";
const LOCAL_VERSION = localPackageVersion();
const command = process.argv[2];
const CONFIGURE_CLAUDE_DESKTOP = command === "--configure-claude-desktop" || process.env.CCDX_CONFIGURE_CLAUDE_DESKTOP === "1";

function isLoopbackHost(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(String(host).toLowerCase());
}

if (command === "--version" || command === "-v" || command === "version") {
  console.log(`codex-copilot-dx v${LOCAL_VERSION}`);
  process.exit(0);
}

if (command === "usage") {
  await printUsageSummary();
  process.exit(0);
}

console.log(`
  codex-copilot-dx v${LOCAL_VERSION}
  Use Codex Desktop with GitHub Copilot
`);

checkForUpdate({ currentVersion: LOCAL_VERSION }).then(({ latestVersion, updateAvailable }) => {
  if (!updateAvailable) return;
  console.log(`\n  ${status("warn", `Update available: ${LOCAL_VERSION} -> ${latestVersion}`)}`);
  console.log("  npm install -g codex-copilot-dx@latest\n");
});

try {
  // Ensure GitHub login, using device flow if no token exists.
  await ensureAuth();

  // Refresh the VS Code version in the background; fallback is non-blocking.
  refreshVSCodeVersion();

  if (!isLoopbackHost(ADAPTER_HOST)) {
    console.log(status("warn", `ADAPTER_HOST=${ADAPTER_HOST} exposes the adapter beyond loopback. Use only on trusted networks.`));
  }

  const claudeDesktopApiKey = CONFIGURE_CLAUDE_DESKTOP
    ? (process.env.CCDX_CLAUDE_DESKTOP_API_KEY || process.env.CCDX_PROXY_API_KEY || generatedClaudeDesktopApiKey())
    : (process.env.CCDX_CLAUDE_DESKTOP_API_KEY || process.env.CCDX_PROXY_API_KEY || "");

  // Start the in-process adapter.
  await startAdapter(ADAPTER_PORT, ADAPTER_HOST, { claudeDesktopApiKey });

  // Point Codex and Claude Code at the adapter.
  ensureCodexConfig(ADAPTER_PORT);
  ensureClaudeConfig(ADAPTER_PORT);
  if (CONFIGURE_CLAUDE_DESKTOP) {
    const result = applyClaudeDesktopConfig({
      port: ADAPTER_PORT,
      host: ADAPTER_HOST,
      gatewayApiKey: claudeDesktopApiKey,
    });
    console.log(status("ok", `Configured Claude Desktop gateway profile at ${result.baseUrl}`));
    console.log(formatClaudeDesktopApplyResult(result));
  }

  // Launch Codex when available.
  openCodex();

  console.log(`
  ${status("ok", CONFIGURE_CLAUDE_DESKTOP
    ? "Ready. Codex, Claude Code, and Claude Desktop are using your GitHub Copilot subscription."
    : "Ready. Codex and Claude Code are using your GitHub Copilot subscription.")}

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
