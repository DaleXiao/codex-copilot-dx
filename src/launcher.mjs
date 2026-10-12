import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { installedWindowsPredictionApp, windowsPredictionAppProcesses } from "./native-prediction-windows.mjs";
import { status } from "./status.mjs";

export { ensureAuth } from "./auth.mjs";

// Prefer the Codex bundle identifier, then fall back to its known app paths.
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

export async function openCodex({ env = process.env, spawnImpl = spawn, platform = process.platform, predictionPacUrl = null, predictionApp = null, predictionProfile = null,
  resolveWindowsApp = installedWindowsPredictionApp, windowsAppProcesses = windowsPredictionAppProcesses } = {}) {
  if (platform === "win32" && autoLaunchEnabled(env) && typeof predictionPacUrl === "string"
    && /^http:\/\/127\.0\.0\.1:\d{1,5}\/proxy\.pac$/.test(predictionPacUrl)
    && typeof predictionApp === "string" && path.win32.isAbsolute(predictionApp)) {
    try {
      if (typeof predictionProfile !== "string" || !path.win32.isAbsolute(predictionProfile)
        || /[\0\r\n]/.test(predictionProfile) || !fs.existsSync(path.win32.join(predictionProfile, "Local State"))) {
        throw new Error("Verified Windows browser profile is unavailable; prediction launch was skipped");
      }
      const override = String(env.CODEX_ELECTRON_USER_DATA_PATH || "").trim();
      if (override && path.win32.resolve(override).toLowerCase() !== path.win32.normalize(predictionProfile).toLowerCase()) {
        throw new Error("Existing browser profile override differs from prediction trust; it was preserved");
      }
      const current = resolveWindowsApp({ env });
      if (path.win32.normalize(current.app).toLowerCase() !== path.win32.normalize(predictionApp).toLowerCase()) {
        throw new Error("Windows Codex App changed; prediction launch was skipped");
      }
      const running = windowsAppProcesses(current.app, { env });
      if (running.length) {
        if (running.length === 1 && running[0].readable && running[0].route === predictionPacUrl) {
          console.log(status("ok", "Running Codex App uses the current prediction route"));return true;
        }
        throw new Error("Running Codex App uses an old or unverified prediction route. Fully quit the App, then run ccdx again; no process was stopped");
      }
      const launched = await new Promise(resolve => {
        const child = spawnImpl(current.app, [`--user-data-dir=${predictionProfile}`, `--proxy-pac-url=${predictionPacUrl}`], {
          cwd: path.win32.dirname(current.app), env: { ...env, CODEX_ELECTRON_USER_DATA_PATH: predictionProfile },
          stdio: "ignore", detached: true, shell: false,
        });
        child.once("error", () => resolve(false));
        child.once("spawn", () => { child.unref(); resolve(true); });
      });
      console.log(status(launched ? "info" : "warn", launched ? "Codex launch requested; prediction status will show when configuration traffic is observed" : "Could not launch the registered Windows Codex App"));
      return launched;
    } catch (error) {
      console.log(status("warn", `Optional Windows prediction launch skipped: ${error.message}`));
      return false;
    }
  }
  if (platform !== "darwin") {
    console.log(status("warn", "Automatic launch requires macOS or an enabled Windows prediction setup"));
    console.log(status("info", "Open Codex App manually; it will connect to the adapter."));
    return false;
  }

  if (!autoLaunchEnabled(env)) {
    console.log(status("info", "Auto-launch disabled (CCDX_AUTO_LAUNCH=0); open Codex App manually."));
    return false;
  }

  const extraArgs = typeof predictionPacUrl === "string" && /^http:\/\/127\.0\.0\.1:\d{1,5}\/proxy\.pac$/.test(predictionPacUrl)
    && APP_PATH_CANDIDATES.includes(predictionApp)
    ? ["--args", `--proxy-pac-url=${predictionPacUrl}`] : [];
  const attempts = extraArgs.length ? [[predictionApp]] : launchAttempts();
  for (const attempt of attempts) {
    const args = [...attempt, ...extraArgs];
    if (await tryOpen(args, { spawnImpl })) {
      console.log(status("ok", "Codex app launched"));
      return true;
    }
  }

  console.log(status("warn", "Could not launch the Codex app (checked com.openai.codex, Codex.app, ChatGPT.app)"));
  console.log(status("info", "Open Codex App manually; it will connect to the adapter."));
  console.log(status("info", "Download it from https://openai.com/codex"));
  return false;
}
