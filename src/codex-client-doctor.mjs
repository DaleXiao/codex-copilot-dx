import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readAdapterStatus } from "./cli-status.mjs";
import { codexPaths } from "./codex-paths.mjs";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { formatPredictionEnvironment } from "./native-prediction-state.mjs";

export function parseRunningCodexApps(stdout) {
  const apps = new Map();
  for (const line of String(stdout).split("\n")) {
    const match = /^\s*(\d+)\s+.*\/(ChatGPT|Codex)\.app\/Contents\//.exec(line);
    if (!match) continue;
    const name = `${match[2]}.app`;
    const pids = apps.get(name) || [];
    if (pids.length < 8) pids.push(Number(match[1]));
    apps.set(name, pids);
  }
  return [...apps].map(([name, pids]) => ({ name, pids }));
}

export async function inspectCodexClient({
  home = os.homedir(), env = process.env, platform = process.platform, running,
  host, port, fetchImpl = fetch, readFileFn = (file, encoding) => readBoundedFileSync(file, { encoding, maxBytes: 8 * 1024 * 1024 }),
  execFileFn = promisify(execFile), readStatus = readAdapterStatus,
} = {}) {
  const checks = [];
  if (platform === "darwin") {
    const seen = new Set(), versions = new Set();
    for (const root of ["/Applications", path.join(home, "Applications")]) {
      for (const name of ["ChatGPT.app", "Codex.app"]) {
        try {
          const plist = readFileFn(path.join(root, name, "Contents", "Info.plist"), "utf8");
          const version = /<key>CFBundleShortVersionString<\/key>\s*<string>([0-9A-Za-z.+_-]{1,64})<\/string>/.exec(plist)?.[1];
          if (version && !seen.has(`${name}/${version}`)) {
            checks.push({ kind: "info", message: `Installed ${name}: App version ${version}` });
            seen.add(`${name}/${version}`);
          }
        } catch {}
        try {
          const metadata = JSON.parse(readFileFn(path.join(root, name, "Contents", "Resources", "codex-cli", "codex-package.json"), "utf8"));
          if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+_-]+)?$/.test(metadata.version || "")) versions.add(metadata.version);
        } catch { /* Older app bundles may not publish CLI package metadata. */ }
      }
    }
    for (const version of versions) checks.push({ kind: "info", message: `Bundled Codex CLI: ${version}` });
    try {
      const cache = JSON.parse(readFileFn(path.join(codexPaths({ home, env }).directory, "models_cache.json"), "utf8"));
      const core = value => /^(\d+\.\d+\.\d+)/.exec(String(value || ""))?.[1];
      const current = new Set([...versions].map(core));
      if (current.size === 1 && core(cache.client_version) && !current.has(core(cache.client_version))) {
        checks.push({ kind: "warn", message: `Model cache client ${core(cache.client_version)} differs from bundled CLI ${[...current][0]}; fully quit and reopen the App once after updating. This does not prove a failed catalog.` });
      }
    } catch { /* Cache contents are optional and never repaired by this read-only check. */ }
    try {
      // comm contains executable names, never command-line arguments or environments.
      const { stdout } = await execFileFn("ps", ["-axo", "pid=,comm="], { timeout: 1500, maxBuffer: 256 * 1024, encoding: "utf8" });
      const apps = parseRunningCodexApps(stdout);
      for (const app of apps) checks.push({ kind: "info", message: `Running ${app.name}: PID ${app.pids.join(", ")}; fully quit with Command-Q before reopening (closing the window may keep it running)` });
      if (!apps.length) checks.push({ kind: "info", message: "No running Codex/ChatGPT App process observed" });
    } catch { checks.push({ kind: "info", message: "Running Codex App processes could not be inspected" }); }
  }
  if (running?.ok || running?.incompatible) {
    try {
      const { data } = await readStatus({ host, port, fetchImpl, timeoutMs: 1500 });
      const source = ["live", "cache", "built-in"].includes(data.models?.source) ? data.models.source : "unknown";
      checks.push({ kind: "info", message: `Running adapter ${data.version}; upstream model directory source: ${source}` });
      const prediction = data.client_integrations?.prediction;
      if (prediction?.environment) checks.push({ kind: prediction.environment.status === "adapted" ? "info" : "warn", message: formatPredictionEnvironment(prediction.environment) });
      const catalog = data.models?.client_catalog;
      const observed = catalog?.last_request;
      if (!catalog) {
        checks.push({ kind: "info", message: "Running adapter does not expose client-catalog diagnostics; upgrade and restart CCDX" });
      } else if (observed) {
        const version = /^[0-9]+\.[0-9]+\.[0-9]+$/.test(observed.client_version || "") ? observed.client_version : "unknown";
        const app = ["ChatGPT.app", "Codex.app", "custom binary"].includes(observed.application) ? observed.application : "unknown App";
        checks.push({ kind: "info", message: `Last catalog request: client ${version}, ${app}, ${observed.source === "bundled" ? "bundled" : "unavailable"}; version match ${observed.matched === true ? "observed" : "not verified"}` });
      } else checks.push({ kind: "info", message: "No client model-catalog request observed by this adapter" });
    } catch { checks.push({ kind: "info", message: "Client model-catalog diagnostics unavailable from the running adapter" }); }
  }
  checks.push({ kind: "info", message: "App adoption of the model cache is not externally verified; process age alone does not prove a stale catalog" });
  return checks;
}
