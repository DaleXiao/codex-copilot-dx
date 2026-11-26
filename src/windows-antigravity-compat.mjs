import path from "node:path";
import { readBoundedResponseText } from "./upstream-body.mjs";

export const windowsAntigravityManifestUrl = "https://raw.githubusercontent.com/DaleXiao/codex-copilot-dx/antigravity-compat/windows-antigravity.json";
const refreshIntervalMs = 5 * 60 * 1000;
const maxManifestBytes = 16 * 1024;
const sha256 = /^[a-f0-9]{64}$/;
const releaseVersion = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export function parseWindowsAntigravityManifest(value) {
  if (value?.schema !== 1 || !Array.isArray(value.releases) || value.releases.length > 12) throw new Error("Invalid Antigravity compatibility metadata");
  const releases = new Map();
  for (const { version, x64, arm64 } of value.releases) {
    if (typeof version !== "string" || !releaseVersion.test(version) || releases.has(version)
      || ![x64, arm64].every(files => Array.isArray(files) && files.length === 3 && files.every(hash => typeof hash === "string" && sha256.test(hash)))) {
      throw new Error("Invalid Antigravity compatibility entry");
    }
    releases.set(version, [x64, arm64]);
  }
  return releases;
}

async function configuredReleaseFetch(env) {
  const [{ inspectPackageUpdateEnvironment }, { createNpmReleaseFetch }] = await Promise.all([
    import("./package-update.mjs"), import("./release-install.mjs"),
  ]);
  const { npm } = inspectPackageUpdateEnvironment({ env });
  if (!npm) throw new Error("Configured npm downloader is unavailable");
  return createNpmReleaseFetch(path.win32.join(path.win32.dirname(npm), "node_modules/npm/bin/npm-cli.js"), { env });
}

export function createWindowsAntigravityManifest({ getFetch = configuredReleaseFetch, now = Date.now } = {}) {
  let releases = new Map(), nextRefresh = 0, pending;
  return async (version, { env = process.env } = {}) => {
    const release = version.replace(/^(\d+\.\d+\.\d+)\.0$/, "$1");
    if (!releaseVersion.test(release)) return [];
    if (!releases.has(release) && !pending && now() >= nextRefresh) {
      nextRefresh = now() + refreshIntervalMs;
      pending = (async () => {
        const fetch = await getFetch(env);
        const signal = AbortSignal.timeout(5000);
        const response = await fetch(windowsAntigravityManifestUrl, { signal, redirect: "error" });
        if (!response.ok) { await response.body?.cancel(); return; }
        const text = await readBoundedResponseText(response, { signal, maxBytes: maxManifestBytes, label: "Antigravity compatibility metadata" });
        releases = parseWindowsAntigravityManifest(JSON.parse(text));
      })().catch(() => undefined).finally(() => { pending = undefined; });
    }
    if (!releases.has(release)) await pending;
    return releases.get(release) || [];
  };
}
