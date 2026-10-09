import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/DaleXiao/codex-copilot-dx/releases/latest";
const MAX_RELEASE_BYTES = 256 * 1024;

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

async function readReleaseJson(response, signal) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error("GitHub release response has no readable body");
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks = [];
  let bytes = 0;
  let complete = false;
  try {
    if (Number(response.headers?.get?.("content-length")) > MAX_RELEASE_BYTES) {
      throw new Error("GitHub release response is too large");
    }
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_RELEASE_BYTES) throw new Error("GitHub release response is too large");
      chunks.push(Buffer.from(value));
    }
    if (signal.aborted) throw new Error("GitHub release request timed out");
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

export async function fetchLatestRelease({ fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(GITHUB_LATEST_RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "codex-copilot-dx" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!resp.ok) {
      void resp.body?.cancel?.().catch(() => {});
      return null;
    }
    const data = await readReleaseJson(resp, controller.signal);
    const version = githubReleaseVersion(data?.tag_name);
    return version && data.draft === false && data.prerelease === false
      ? { version, tagName: data.tag_name }
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
