#!/usr/bin/env node

import { ensureAuth, openCodex } from "../src/launcher.mjs";
import { ensureCodexConfig } from "../src/config.mjs";
import { ensureClaudeConfig } from "../src/claude-config.mjs";
import { startAdapter } from "../src/adapter.mjs";
import { refreshVSCodeVersion } from "../src/copilot.mjs";

const ADAPTER_PORT = parseInt(process.env.ADAPTER_PORT || "8148");

console.log(`
  codex-copilot-dx
  Use Codex Desktop with GitHub Copilot
`);

try {
  // 1. 确保 GitHub 登录（无 token 则走 device flow）
  await ensureAuth();

  // 2. 后台异步抓取最新 VSCode 版本（不阻塞，失败用 fallback）
  refreshVSCodeVersion();

  // 3. 启动进程内 adapter
  await startAdapter(ADAPTER_PORT);

  // 4. 配置 Codex 与 Claude Code 指向 adapter
  ensureCodexConfig(ADAPTER_PORT);
  ensureClaudeConfig(ADAPTER_PORT);

  // 5. 启动 Codex
  openCodex();

  console.log(`
  Ready! Codex is using your GitHub Copilot subscription.

  Adapter: http://localhost:${ADAPTER_PORT}

  Press Ctrl+C to stop.
`);

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    process.exit(0);
  });
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
