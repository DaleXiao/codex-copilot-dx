import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createNpmReleaseFetch, stableVersion } from "./release-install.mjs";
import { isVersionGreater } from "./version.mjs";
import { ADAPTER_VERSION } from "./running-adapter.mjs";
import { readBoundedResponseText } from "./upstream-body.mjs";

const API = "https://api.github.com/repos/DaleXiao/codex-copilot-dx/releases";
const run = promisify(execFile);

async function releaseFetch() {
  const env = process.env, windows = process.platform === "win32", paths = windows ? path.win32 : path;
  const search = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] || "";
  const npm = search.split(windows ? ";" : ":").filter(Boolean)
    .map(directory => paths.join(directory.replace(/^"|"$/g, ""), windows ? "npm.cmd" : "npm"))
    .find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
  if (!npm) throw new Error("npm unavailable");
  const cli = windows ? paths.join(paths.dirname(npm), "node_modules", "npm", "bin", "npm-cli.js") : fs.realpathSync(npm);
  // Read only the installer's named network settings, off the service event loop.
  const { stdout } = await run(process.execPath, [cli, "config", "get", "--global", "https-proxy", "proxy", "noproxy", "cafile", "strict-ssl", "offline"],
    { env, encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true });
  return createNpmReleaseFetch(cli, { env, exec: () => stdout });
}

export function createDashboardUpdateStatus({ currentVersion = ADAPTER_VERSION, fetchFactory = releaseFetch, now = Date.now, timeoutMs = 4000 } = {}) {
  let pending, snapshot, attemptedAt = -Infinity, currentDate = null;
  const current = () => ({ version: currentVersion, published_at: currentDate });
  async function metadata(fetchImpl, suffix, expectedVersion) {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(`${API}/${suffix}`, { signal, redirect: "error",
      headers: { Accept: "application/vnd.github+json", "User-Agent": "codex-copilot-dx", "X-GitHub-Api-Version": "2022-11-28" } });
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error("Release metadata unavailable"), { code: [403, 429].includes(response.status) ? "rate_limited" : "unavailable" });
    }
    const value = JSON.parse(await readBoundedResponseText(response, { maxBytes: 128 * 1024, signal, label: "Release metadata" }));
    const version = stableVersion(value.tag_name);
    if (!version || value.draft !== false || value.prerelease !== false || expectedVersion && version !== expectedVersion) throw new Error("Invalid stable release");
    const date = typeof value.published_at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value.published_at) && Number.isFinite(Date.parse(value.published_at))
      && new Date(value.published_at).toISOString().replace(".000Z", "Z") === value.published_at
      ? new Date(value.published_at).toISOString() : null;
    return { version, published_at: date };
  }
  return async () => {
    if (pending) return structuredClone(await pending);
    const ttl = snapshot?.status === "checked" ? 5 * 60 * 1000 : 60 * 1000;
    if (snapshot && now() - attemptedAt < ttl) return structuredClone(snapshot);
    attemptedAt = now();
    pending = (async () => {
      try {
        const fetchImpl = await fetchFactory();
        const latest = await metadata(fetchImpl, "latest");
        if (latest.version === currentVersion) currentDate = latest.published_at;
        else if (!currentDate && stableVersion(currentVersion)) {
          try { currentDate = (await metadata(fetchImpl, `tags/v${currentVersion}`, currentVersion)).published_at; } catch { /* The date can be unknown without hiding a verified newer release. */ }
        }
        snapshot = { source: "release_status", status: "checked", current: current(), latest,
          update_available: isVersionGreater(latest.version, currentVersion), checked_at: new Date(now()).toISOString(), last_success_at: new Date(now()).toISOString() };
      } catch (error) {
        snapshot = { source: "release_status", status: error.code === "rate_limited" ? "rate_limited" : "unavailable", current: current(),
          latest: snapshot?.latest || null, update_available: false, checked_at: new Date(now()).toISOString(), last_success_at: snapshot?.last_success_at || null };
      }
      return snapshot;
    })();
    try { return structuredClone(await pending); } finally { pending = null; }
  };
}

export const dashboardUpdateStatus = createDashboardUpdateStatus();
