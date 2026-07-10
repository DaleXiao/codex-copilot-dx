import { spawn } from "node:child_process";
import { status } from "./status.mjs";

export { ensureAuth } from "./auth.mjs";

// The Codex desktop app was folded into the ChatGPT app, but it keeps the
// original bundle identifier. Launching by bundle id works for both the old
// Codex.app and the new ChatGPT.app regardless of where they are installed.
const CODEX_BUNDLE_ID = "com.openai.codex";
const APP_PATH_CANDIDATES = [
  "/Applications/Codex.app",
  "/Applications/ChatGPT.app",
];

export function autoLaunchEnabled(env = process.env) {
  const raw = env.CCDX_AUTO_LAUNCH;
  if (raw === undefined || raw === "") return true;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

// Run `open` and resolve to true only when it exits successfully.
function tryOpen(args, { spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl("open", args, { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

// Build the ordered list of launch attempts: bundle id first, then paths.
export function launchAttempts() {
  return [["-b", CODEX_BUNDLE_ID], ...APP_PATH_CANDIDATES.map((path) => [path])];
}

export async function openCodex({ env = process.env, spawnImpl = spawn, platform = process.platform } = {}) {
  if (platform !== "darwin") {
    console.log(status("warn", "Auto-launch is only supported on macOS"));
    console.log(status("info", "Open Codex or the ChatGPT app manually; it will connect to the adapter."));
    return false;
  }

  if (!autoLaunchEnabled(env)) {
    console.log(status("info", "Auto-launch disabled (CCDX_AUTO_LAUNCH=0); open Codex or the ChatGPT app manually."));
    return false;
  }

  for (const args of launchAttempts()) {
    if (await tryOpen(args, { spawnImpl })) {
      console.log(status("ok", "Codex app launched"));
      return true;
    }
  }

  console.log(status("warn", "Could not launch the Codex app (checked com.openai.codex, Codex.app, ChatGPT.app)"));
  console.log(status("info", "Open Codex or the ChatGPT app manually; it will connect to the adapter."));
  console.log(status("info", "Download it from https://openai.com/codex"));
  return false;
}
