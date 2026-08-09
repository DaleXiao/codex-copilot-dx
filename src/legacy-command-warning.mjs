import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-file.mjs";

export const LEGACY_COMMAND_WARNING_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const LEGACY_COMMAND_WARNING = "codex-copilot-dx is deprecated; use ccdx instead. The compatibility alias will be removed in a future breaking release.";

export function legacyCommandWarningPath({ env = process.env, home = os.homedir() } = {}) {
  const xdgCacheHome = String(env.XDG_CACHE_HOME || "").trim();
  const cacheRoot = xdgCacheHome || path.join(home, ".cache");
  return path.join(cacheRoot, "codex-copilot-dx", "legacy-command-warning");
}

export function shouldShowLegacyCommandWarning({
  env = process.env,
  home = os.homedir(),
  interactive = process.stderr.isTTY === true,
  now = Date.now(),
} = {}) {
  if (!interactive) return false;
  const filePath = legacyCommandWarningPath({ env, home });
  try {
    const previous = Number.parseInt(fs.readFileSync(filePath, "utf8"), 10);
    if (Number.isFinite(previous) && Math.abs(now - previous) < LEGACY_COMMAND_WARNING_INTERVAL_MS) {
      return false;
    }
  } catch {
    // A missing or unreadable cache must not prevent the compatibility command.
  }
  try {
    atomicWriteFileSync(filePath, `${now}\n`, { mode: 0o600 });
  } catch {
    // The warning remains best effort when the cache directory is read-only.
  }
  return true;
}
