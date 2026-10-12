import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { operationError } from "./operation-error.mjs";

const GITHUB_LATEST_RELEASE_URL = "https://github.com/DaleXiao/codex-copilot-dx/releases/latest";

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

export function githubReleaseVersion(tag) {
  if (typeof tag !== "string" || tag.length > 64) return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (!match || !match.slice(1).every((part) => Number.isSafeInteger(Number(part)))) return null;
  return match.slice(1).join(".");
}

export async function lookupLatestRelease({ fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(GITHUB_LATEST_RELEASE_URL, {
      headers: { Accept: "text/html", "User-Agent": "codex-copilot-dx" },
      redirect: "manual",
      signal: controller.signal,
    });
    void resp.body?.cancel?.().catch(() => {});
    if ([403, 429].includes(resp.status)) throw operationError("github_rate_limit", `GitHub release lookup was refused (HTTP ${resp.status}); retry later. No update was installed.`, { status: resp.status });
    if (![301, 302, 303, 307, 308].includes(resp.status)) throw operationError("github_http_error", `GitHub release lookup returned HTTP ${resp.status}; no stable release redirect was received. No update was installed.`, { status: resp.status });
    let url;
    try { url = new URL(resp.headers.get("location"), GITHUB_LATEST_RELEASE_URL); } catch {}
    const match = url?.pathname.match(/^\/DaleXiao\/codex-copilot-dx\/releases\/tag\/([^/]+)$/i);
    const tagName = match?.[1], version = githubReleaseVersion(tagName);
    if (!url || url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash || !version) {
      throw operationError("github_invalid_redirect", "GitHub did not return a valid stable release tag for this repository. No update was installed.");
    }
    return { version, tagName };
  } catch (error) {
    if (error.code?.startsWith("github_")) throw error;
    if (controller.signal.aborted) throw operationError("github_timeout", "GitHub release lookup timed out. No update was installed.");
    throw operationError(error.cause?.code || "github_network_error", "Could not connect to the GitHub release page. Check your network or proxy. No update was installed.");
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchLatestRelease(options = {}) {
  try { return await lookupLatestRelease(options); } catch { return null; }
}

export async function fetchLatestVersion(options) {
  return (await fetchLatestRelease(options))?.version || null;
}

export async function checkForUpdate({ currentVersion = localPackageVersion(), fetchImpl, timeoutMs } = {}) {
  const latestVersion = await fetchLatestVersion({ fetchImpl, timeoutMs });
  return {
    currentVersion,
    latestVersion,
    updateAvailable: latestVersion ? isVersionGreater(latestVersion, currentVersion) : false,
  };
}
