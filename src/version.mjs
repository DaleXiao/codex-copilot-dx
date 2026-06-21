import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY_LATEST_URL = "https://registry.npmjs.org/codex-copilot-dx/latest";

export function localPackageVersion() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
  return pkg.version;
}

function parseVersion(version) {
  return String(version || "")
    .split(/[+-]/)[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function isVersionGreater(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const len = Math.max(left.length, right.length, 3);
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff > 0) return true;
    if (diff < 0) return false;
  }
  return false;
}

export async function fetchLatestVersion({ fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(REGISTRY_LATEST_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForUpdate({ currentVersion = localPackageVersion(), fetchImpl, timeoutMs } = {}) {
  const latestVersion = await fetchLatestVersion({ fetchImpl, timeoutMs });
  return {
    currentVersion,
    latestVersion,
    updateAvailable: latestVersion ? isVersionGreater(latestVersion, currentVersion) : false,
  };
}
