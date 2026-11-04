import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexPaths } from "./codex-paths.mjs";
import { withFileLockSync } from "./lock.mjs";
import { atomicWriteFileIfChangedSync } from "./atomic-file.mjs";
import { computeImageMcpCodexConfig } from "./config.mjs";
import { parseCodexToml } from "./config-toml.mjs";
import { removeLegacyImageGuidance } from "./legacy-image-guidance.mjs";

export function legacyImageProviderPath({ env = process.env, home = os.homedir() } = {}) {
  return path.join(String(env.XDG_CONFIG_HOME || "").trim() || path.join(home, ".config"), "codex-copilot-dx", "image-provider.json");
}

export function retireLegacyImages({ env = process.env, home = os.homedir(), codexPath = codexPaths({ env, home }).config,
  adapterPort = 2026, adapterHost = "127.0.0.1" } = {}) {
  const providerPath = legacyImageProviderPath({ env, home });
  const credentialRemoved = fs.existsSync(providerPath);
  fs.rmSync(providerPath, { force: true });
  const guidance = removeLegacyImageGuidance({ codexPath });
  let configChanged = false, preservedMcp = false;
  if (fs.existsSync(codexPath)) withFileLockSync(`${codexPath}.ccdx.lock`, () => {
    const before = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(codexPath));
    const config = computeImageMcpCodexConfig(before, { enabled: false, adapterPort, adapterHost });
    if (config.changed) {
      if (fs.readFileSync(codexPath, "utf8") !== before) throw new Error("Codex configuration changed during image retirement");
      atomicWriteFileIfChangedSync(codexPath, config.content);configChanged = true;
    }
    preservedMcp = Boolean(parseCodexToml(config.content).mcp_servers?.ccdx_image);
  });
  return { changed: credentialRemoved || configChanged || guidance.changed, credentialRemoved, configChanged,
    preserved: preservedMcp || Boolean(guidance.preserved), preservedMcp, preservedGuidance: Boolean(guidance.preserved) };
}
