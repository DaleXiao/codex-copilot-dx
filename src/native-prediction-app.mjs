import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { installedWindowsPredictionAppAsync, windowsPredictionProfile } from "./native-prediction-windows.mjs";

const execute = promisify(execFile);
const checks = new WeakMap();
const stat = file => {
  const value = fs.statSync(file);
  if (!value.isFile()) throw new Error("App identity is not a regular file");
  return { size: value.size, mtimeMs: value.mtimeMs };
};
const matches = (file, size, mtimeMs) => {
  const value = stat(file);
  return value.size === size && value.mtimeMs === mtimeMs;
};

// Installation identity is independent of renderer chunks and prediction
// implementation strings. Live responses decide whether an overlay applies.
export async function installedPredictionApp({ exec = execute, platform = process.platform, ...options } = {}) {
  if (platform === "win32") {
    const app = await installedWindowsPredictionAppAsync({ ...options, exec });
    const identity = stat(app.app);
    return { ...app, identity_version: 2, executable: app.app, ...identity,
      profile: windowsPredictionProfile({ app, env: options.env, preferredProfile: options.preferredProfile }) };
  }
  if (platform !== "darwin") throw new Error("Prediction App discovery supports macOS and Windows only");
  for (const app of ["/Applications/ChatGPT.app", "/Applications/Codex.app"]) {
    const metadata = path.join(app, "Contents", "Info.plist");
    if (!fs.existsSync(metadata)) continue;
    const info = stat(metadata);
    const result = await exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", metadata],
      { encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024 });
    const parsed = JSON.parse(String(result?.stdout ?? result));
    if (parsed?.CFBundleIdentifier !== "com.openai.codex" || !["ChatGPT", "Codex"].includes(parsed.CFBundleExecutable)) {
      throw new Error("Unknown Codex App identity; prediction setup was preserved");
    }
    const executable = path.join(app, "Contents", "MacOS", parsed.CFBundleExecutable), identity = stat(executable);
    const key = JSON.stringify([app, info, identity]);
    let cache = checks.get(exec);
    if (!cache) { cache = new Map();checks.set(exec, cache); }
    if (!cache.has(key)) {
      while (cache.size >= 2) cache.delete(cache.keys().next().value);
      const pending = (async () => {
        await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", '=identifier "com.openai.codex" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"', app],
          { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 });
        if (!matches(metadata, info.size, info.mtimeMs) || !matches(executable, identity.size, identity.mtimeMs)) {
          throw new Error("Codex App changed during identity verification");
        }
        return { app, identity_version: 2, executable, ...identity, metadata,
          metadataSize: info.size, metadataMtimeMs: info.mtimeMs };
      })();
      cache.set(key, pending);
      pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
    }
    return { ...await cache.get(key) };
  }
  throw new Error("A registered Codex App was not found; prediction setup was preserved");
}

export function predictionAppMatches(app) {
  try {
    return app?.identity_version === 2 && matches(app.executable, app.size, app.mtimeMs)
      && (!app.metadata || matches(app.metadata, app.metadataSize, app.metadataMtimeMs));
  } catch { return false; }
}
