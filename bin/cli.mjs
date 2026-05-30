#!/usr/bin/env node

import { ensureAuth, startCopilotApi, openCodex } from "../src/launcher.mjs";
import { ensureCodexConfig } from "../src/config.mjs";
import { startAdapter } from "../src/adapter.mjs";

const COPILOT_PORT = parseInt(process.env.COPILOT_API_PORT || "4141");
const ADAPTER_PORT = parseInt(process.env.ADAPTER_PORT || "4142");

console.log(`
  codex-copilot-dx
  Use Codex Desktop with GitHub Copilot
`);

try {
  // 1. Ensure GitHub auth
  await ensureAuth();

  // 2. Start copilot-api (for legacy models)
  const copilotProc = await startCopilotApi(COPILOT_PORT);

  // 3. Start adapter
  await startAdapter(ADAPTER_PORT);

  // 4. Configure Codex
  ensureCodexConfig(ADAPTER_PORT);

  // 5. Launch Codex
  openCodex();

  console.log(`
  Ready! Codex is using your GitHub Copilot subscription.

  Adapter:     http://localhost:${ADAPTER_PORT}
  copilot-api: http://localhost:${COPILOT_PORT}

  Press Ctrl+C to stop.
`);

  // Keep alive
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    copilotProc?.kill();
    process.exit(0);
  });
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
