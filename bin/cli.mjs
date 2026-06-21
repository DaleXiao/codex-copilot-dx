#!/usr/bin/env node

import { ensureAuth, openCodex } from "../src/launcher.mjs";
import { ensureCodexConfig } from "../src/config.mjs";
import { ensureClaudeConfig } from "../src/claude-config.mjs";
import { startAdapter } from "../src/adapter.mjs";
import { refreshVSCodeVersion } from "../src/copilot.mjs";
import { status } from "../src/status.mjs";
import { printUsageSummary } from "../src/usage.mjs";
import { checkForUpdate, localPackageVersion } from "../src/version.mjs";

const ADAPTER_PORT = parseInt(process.env.ADAPTER_PORT || "2026");
const LOCAL_VERSION = localPackageVersion();
const command = process.argv[2];

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

  // Start the in-process adapter.
  await startAdapter(ADAPTER_PORT);

  // Point Codex and Claude Code at the adapter.
  ensureCodexConfig(ADAPTER_PORT);
  ensureClaudeConfig(ADAPTER_PORT);

  // Launch Codex when available.
  openCodex();

  console.log(`
  ${status("ok", "Ready. Codex and Claude Code are using your GitHub Copilot subscription.")}

  Adapter: http://localhost:${ADAPTER_PORT}

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
