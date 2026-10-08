import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readAdapterStatus } from "./cli-status.mjs";

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
  home = os.homedir(), platform = process.platform, running,
  host, port, fetchImpl = fetch, readFileFn = fs.readFileSync,
  execFileFn = promisify(execFile), readStatus = readAdapterStatus,
} = {}) {
  const checks = [];
  if (platform === "darwin") {
    const seen = new Set();
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
      }
    }
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
  checks.push({ kind: "info", message: "App-internal model cache is not externally verified; process age alone does not prove a stale catalog" });
  return checks;
}
