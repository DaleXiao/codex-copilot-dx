import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PM_STUDIO_2_9_10_RECIPE } from "./pm-studio-asar.mjs";

const fsp = fs.promises;

export const PM_STUDIO_OFFICIAL_REPOSITORY = "gim-home/max-studio";
export const PM_STUDIO_OFFICIAL_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_WEB_ORIGIN = "https://github.com";
const GITHUB_RELEASE_ASSET_ORIGIN = "https://release-assets.githubusercontent.com";
const MAX_REDIRECTS = 2;
const MAX_XATTR_OUTPUT_BYTES = 64 * 1024 * 1024;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SHA256_DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/;
const LOCALE_MISSING_PATTERN = /^(?:Contents\/Resources\/[a-z]{2,3}(?:_(?:[A-Z]{2}|[0-9]{3}))?\.lproj|Contents\/Frameworks\/Electron Framework\.framework\/Versions\/A\/Resources\/[a-z]{2,3}(?:_(?:[A-Z]{2}|[0-9]{3}))?(?:_(?:FEMININE|MASCULINE|NEUTER))?\.lproj(?:\/locale\.pak)?)$/;
const IGNORED_XATTRS = new Set(PM_STUDIO_2_9_10_RECIPE.sourceBundleContent.ignoredXattrs);

function provenanceError(code, message) {
  const error = new Error(message);
  error.name = "PmStudioProvenanceError";
  error.code = code;
  return error;
}

function assertVersionAndArch(version, arch) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw provenanceError("PM_STUDIO_PROVENANCE_INPUT_INVALID", "PM Studio version must be an exact stable version");
  }
  if (arch !== "arm64" && arch !== "x64") {
    throw provenanceError("PM_STUDIO_PROVENANCE_INPUT_INVALID", "PM Studio architecture must be arm64 or x64");
  }
}

function exactReleaseUrl(version) {
  return `${GITHUB_WEB_ORIGIN}/${PM_STUDIO_OFFICIAL_REPOSITORY}/releases/tag/v${version}`;
}

function exactDownloadUrl(version, assetName) {
  return `${GITHUB_WEB_ORIGIN}/${PM_STUDIO_OFFICIAL_REPOSITORY}/releases/download/v${version}/${assetName}`;
}

export function expectedPmStudioAssetName(version, arch) {
  assertVersionAndArch(version, arch);
  return `PM-Studio-${version}-mac-${arch}.zip`;
}

function exactUrl(value, expected) {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.href === expected
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === "";
  } catch {
    return false;
  }
}

export function selectOfficialPmStudioRelease(release, { version, arch } = {}) {
  const assetName = expectedPmStudioAssetName(version, arch);
  const tag = `v${version}`;
  const releaseUrl = exactReleaseUrl(version);
  if (!release || typeof release !== "object"
    || release.tag_name !== tag
    || release.draft !== false
    || release.prerelease !== false
    || !exactUrl(release.html_url, releaseUrl)
    || !Array.isArray(release.assets)) {
    throw provenanceError("PM_STUDIO_PROVENANCE_RELEASE_INVALID", "Official PM Studio release metadata is not exact");
  }

  const matches = release.assets.filter((asset) => asset?.name === assetName);
  if (matches.length !== 1) {
    throw provenanceError("PM_STUDIO_PROVENANCE_ASSET_INVALID", "Official PM Studio release asset is missing or ambiguous");
  }
  const asset = matches[0];
  const digest = typeof asset.digest === "string" ? SHA256_DIGEST_PATTERN.exec(asset.digest) : null;
  const downloadUrl = exactDownloadUrl(version, assetName);
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0
    || !digest
    || !exactUrl(asset.browser_download_url, downloadUrl)) {
    throw provenanceError("PM_STUDIO_PROVENANCE_ASSET_INVALID", "Official PM Studio release asset cannot be verified");
  }

  return {
    repository: PM_STUDIO_OFFICIAL_REPOSITORY,
    version,
    tag,
    arch,
    releaseUrl,
    asset: {
      name: assetName,
      size: asset.size,
      sha256: digest[1],
      downloadUrl,
    },
  };
}

function safeHeaders(response) {
  return response?.headers && typeof response.headers.get === "function"
    ? response.headers
    : new Headers(response?.headers || {});
}

async function fetchOfficialRelease({ version, arch, fetchImpl, signal }) {
  const url = `${GITHUB_API_ORIGIN}/repos/${PM_STUDIO_OFFICIAL_REPOSITORY}/releases/tags/v${version}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    throw provenanceError("PM_STUDIO_PROVENANCE_RELEASE_FETCH_FAILED", "Could not fetch official PM Studio release metadata");
  }
  if (!response || response.redirected === true || response.status !== 200 || typeof response.json !== "function") {
    throw provenanceError("PM_STUDIO_PROVENANCE_RELEASE_FETCH_FAILED", "Could not fetch official PM Studio release metadata");
  }
  let release;
  try {
    release = await response.json();
  } catch {
    throw provenanceError("PM_STUDIO_PROVENANCE_RELEASE_INVALID", "Official PM Studio release metadata is invalid");
  }
  return selectOfficialPmStudioRelease(release, { version, arch });
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function validateRedirect(currentUrl, location) {
  let current;
  let next;
  try {
    current = new URL(currentUrl);
    next = new URL(location, current);
  } catch {
    throw provenanceError("PM_STUDIO_PROVENANCE_REDIRECT_INVALID", "Official PM Studio artifact redirect is not allowed");
  }
  if (next.protocol !== "https:"
    || next.username !== ""
    || next.password !== ""
    || next.port !== ""
    || next.hash !== "") {
    throw provenanceError("PM_STUDIO_PROVENANCE_REDIRECT_INVALID", "Official PM Studio artifact redirect is not allowed");
  }
  const allowed = current.origin === GITHUB_WEB_ORIGIN
    ? next.origin === GITHUB_RELEASE_ASSET_ORIGIN
    : current.origin === GITHUB_RELEASE_ASSET_ORIGIN && next.origin === GITHUB_RELEASE_ASSET_ORIGIN;
  if (!allowed) {
    throw provenanceError("PM_STUDIO_PROVENANCE_REDIRECT_INVALID", "Official PM Studio artifact redirect is not allowed");
  }
  return next.href;
}

function sameDigest(actual, expected) {
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function writeChunk(file, chunk) {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  let offset = 0;
  while (offset < value.length) {
    const { bytesWritten } = await file.write(value, offset, value.length - offset, null);
    if (bytesWritten <= 0) {
      throw provenanceError("PM_STUDIO_PROVENANCE_DOWNLOAD_FAILED", "Official PM Studio artifact download failed");
    }
    offset += bytesWritten;
  }
}

async function streamArtifact(response, { archivePath, asset, maxDownloadBytes }) {
  const headers = safeHeaders(response);
  const contentLength = headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(contentLength)) {
      throw provenanceError("PM_STUDIO_PROVENANCE_DOWNLOAD_SIZE_MISMATCH", "Official PM Studio artifact length is invalid");
    }
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > maxDownloadBytes) {
      throw provenanceError("PM_STUDIO_PROVENANCE_DOWNLOAD_TOO_LARGE", "Official PM Studio artifact exceeds the download limit");
    }
    if (declared !== asset.size) {
      throw provenanceError("PM_STUDIO_PROVENANCE_DOWNLOAD_SIZE_MISMATCH", "Official PM Studio artifact length does not match release metadata");
    }
  }
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== "function") {
    throw provenanceError("PM_STUDIO_PROVENANCE_DOWNLOAD_FAILED", "Official PM Studio artifact has no streaming body");
  }

  const hash = createHash("sha256");
  let size = 0;
  let file;
  try {
    file = await fsp.open(archivePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    for await (const chunk of response.body) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.length;
      if (!Number.isSafeInteger(size) || size > maxDownloadBytes) {
        throw provenanceError("PM_STUDIO_PROVENANCE_DOWNLOAD_TOO_LARGE", "Official PM Studio artifact exceeds the download limit");
      }
      hash.update(value);
      await writeChunk(file, value);
    }
  } catch (error) {
    if (error?.code?.startsWith?.("PM_STUDIO_PROVENANCE_")) throw error;
    throw provenanceError("PM_STUDIO_PROVENANCE_DOWNLOAD_FAILED", "Official PM Studio artifact download failed");
  } finally {
    if (file) await file.close().catch(() => {});
  }

  if (size !== asset.size) {
    throw provenanceError("PM_STUDIO_PROVENANCE_DOWNLOAD_SIZE_MISMATCH", "Official PM Studio artifact size does not match release metadata");
  }
  const digest = hash.digest("hex");
  if (!sameDigest(digest, asset.sha256)) {
    throw provenanceError("PM_STUDIO_PROVENANCE_DOWNLOAD_DIGEST_MISMATCH", "Official PM Studio artifact digest does not match release metadata");
  }
}

async function downloadArtifact({ selected, archivePath, fetchImpl, maxDownloadBytes, signal }) {
  let currentUrl = selected.asset.downloadUrl;
  let redirects = 0;
  for (;;) {
    let response;
    try {
      response = await fetchImpl(currentUrl, { method: "GET", redirect: "manual", signal });
    } catch {
      throw provenanceError("PM_STUDIO_PROVENANCE_DOWNLOAD_FAILED", "Official PM Studio artifact download failed");
    }
    if (!response || response.redirected === true) {
      throw provenanceError("PM_STUDIO_PROVENANCE_REDIRECT_INVALID", "Official PM Studio artifact redirect is not allowed");
    }
    if (response.status >= 300 && response.status < 400 && !isRedirectStatus(response.status)) {
      throw provenanceError("PM_STUDIO_PROVENANCE_REDIRECT_INVALID", "Official PM Studio artifact redirect is not allowed");
    }
    if (isRedirectStatus(response.status)) {
      if (redirects >= MAX_REDIRECTS) {
        throw provenanceError("PM_STUDIO_PROVENANCE_REDIRECT_INVALID", "Official PM Studio artifact redirect is not allowed");
      }
      const location = safeHeaders(response).get("location");
      if (!location) {
        throw provenanceError("PM_STUDIO_PROVENANCE_REDIRECT_INVALID", "Official PM Studio artifact redirect is not allowed");
      }
      currentUrl = validateRedirect(currentUrl, location);
      redirects += 1;
      continue;
    }
    if (response.status !== 200) {
      throw provenanceError("PM_STUDIO_PROVENANCE_DOWNLOAD_FAILED", "Official PM Studio artifact download failed");
    }
    await streamArtifact(response, { archivePath, asset: selected.asset, maxDownloadBytes });
    return;
  }
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function findExtractedApp(destination) {
  const candidates = [];
  const visit = async (directory) => {
    const names = await fsp.readdir(directory);
    names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    for (const name of names) {
      const entryPath = path.join(directory, name);
      const stat = await fsp.lstat(entryPath);
      if (name === "PM Studio.app") {
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw provenanceError("PM_STUDIO_PROVENANCE_EXTRACT_INVALID", "Extracted PM Studio app is not an ordinary directory");
        }
        candidates.push(entryPath);
        await visit(entryPath);
        continue;
      }
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await visit(entryPath);
      } else if (stat.isSymbolicLink() || stat.isFile()) {
        if (stat.isFile() && stat.nlink !== 1) {
          throw provenanceError("PM_STUDIO_PROVENANCE_EXTRACT_INVALID", "Extracted PM Studio artifact contains a hard link");
        }
      } else {
        throw provenanceError("PM_STUDIO_PROVENANCE_EXTRACT_INVALID", "Extracted PM Studio artifact contains an unsupported entry");
      }
    }
  };
  await visit(destination);
  if (candidates.length !== 1) {
    throw provenanceError("PM_STUDIO_PROVENANCE_EXTRACT_INVALID", "Extracted artifact must contain exactly one PM Studio.app");
  }
  return candidates[0];
}

function sameFileIdentity(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

async function hashRegularFile(filePath, expected) {
  let file;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    file = await fsp.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = await file.stat({ bigint: true });
    if (!sameFileIdentity(expected, before)) {
      throw provenanceError("PM_STUDIO_PROVENANCE_TREE_CHANGED", "PM Studio app changed while it was being verified");
    }
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat({ bigint: true });
    if (!sameFileIdentity(before, after)) {
      throw provenanceError("PM_STUDIO_PROVENANCE_TREE_CHANGED", "PM Studio app changed while it was being verified");
    }
    const pathAfter = await fsp.lstat(filePath, { bigint: true });
    if (!sameFileIdentity(before, pathAfter)) {
      throw provenanceError("PM_STUDIO_PROVENANCE_TREE_CHANGED", "PM Studio app changed while it was being verified");
    }
  } catch (error) {
    if (error?.code?.startsWith?.("PM_STUDIO_PROVENANCE_")) throw error;
    throw provenanceError("PM_STUDIO_PROVENANCE_TREE_INVALID", "PM Studio app contains an unreadable file");
  } finally {
    if (file) await file.close().catch(() => {});
  }
  return hash.digest("hex");
}

function defaultReadXattrOutput(appPath) {
  if (process.platform !== "darwin") return "";
  const result = spawnSync("/usr/bin/xattr", ["-r", "-s", "-x", "-l", appPath], {
    encoding: "utf8",
    maxBuffer: MAX_XATTR_OUTPUT_BYTES,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw provenanceError("PM_STUDIO_PROVENANCE_XATTR_INVALID",
      "PM Studio extended attributes could not be inspected");
  }
  return result.stdout;
}

function parseXattrOutput(output, root) {
  const byPath = new Map();
  const seen = new Set();
  let current = null;
  const flush = () => {
    if (!current) return;
    if (!IGNORED_XATTRS.has(current.name)) {
      const key = `${current.relative}\0${current.name}`;
      if (seen.has(key)) {
        throw provenanceError("PM_STUDIO_PROVENANCE_XATTR_INVALID",
          "PM Studio contains a duplicate extended attribute");
      }
      seen.add(key);
      const value = Buffer.from(current.hex.join(""), "hex");
      const attributes = byPath.get(current.relative) || [];
      attributes.push([current.name, value.length, createHash("sha256").update(value).digest("hex")]);
      byPath.set(current.relative, attributes);
    }
    current = null;
  };

  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.lastIndexOf(": ");
    if ((line === `${root}:` || line.startsWith(`${root}: `) || line.startsWith(`${root}${path.sep}`))
      && separator >= root.length && line.endsWith(":")) {
      flush();
      const target = line.slice(0, separator);
      const relative = target === root ? "." : path.relative(root, target).split(path.sep).join("/");
      if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
        throw provenanceError("PM_STUDIO_PROVENANCE_XATTR_INVALID",
          "PM Studio extended attribute path escapes the app bundle");
      }
      const name = line.slice(separator + 2, -1);
      if (!name) {
        throw provenanceError("PM_STUDIO_PROVENANCE_XATTR_INVALID",
          "PM Studio contains an unnamed extended attribute");
      }
      current = { relative, name, hex: [] };
      continue;
    }
    if (!current) {
      throw provenanceError("PM_STUDIO_PROVENANCE_XATTR_INVALID",
        "PM Studio extended attributes could not be parsed");
    }
    const data = line.includes("  |") ? line.slice(0, line.indexOf("  |")) : line;
    const tokens = data.trim().split(/\s+/);
    if (!/^[0-9a-f]{8}$/i.test(tokens[0])
      || tokens.slice(1).some((token) => !/^[0-9a-f]{2}$/i.test(token))) {
      throw provenanceError("PM_STUDIO_PROVENANCE_XATTR_INVALID",
        "PM Studio extended attribute bytes could not be parsed");
    }
    current.hex.push(...tokens.slice(1));
  }
  flush();
  for (const attributes of byPath.values()) {
    attributes.sort((left, right) => Buffer.compare(Buffer.from(left[0]), Buffer.from(right[0])));
  }
  return byPath;
}

async function snapshotAppTree(appPath, readXattrOutput) {
  const root = path.resolve(appPath);
  let rootStat;
  let rootReal;
  try {
    rootStat = await fsp.lstat(root, { bigint: true });
    rootReal = await fsp.realpath(root);
  } catch {
    throw provenanceError("PM_STUDIO_PROVENANCE_TREE_INVALID", "PM Studio app path is not readable");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw provenanceError("PM_STUDIO_PROVENANCE_TREE_INVALID", "PM Studio app path is not an ordinary directory");
  }

  const entries = new Map();
  const normalizedPaths = new Map();
  const remember = (relative) => {
    const normalized = relative.normalize("NFC");
    const existing = normalizedPaths.get(normalized);
    if (existing && existing !== relative) {
      throw provenanceError("PM_STUDIO_PROVENANCE_TREE_INVALID", "PM Studio app contains colliding paths");
    }
    normalizedPaths.set(normalized, relative);
  };
  remember(".");
  entries.set(".", { type: "directory", mode: Number(rootStat.mode & 0o7777n) });

  const visit = async (directory, expectedDirectoryStat) => {
    let names;
    try {
      names = await fsp.readdir(directory);
    } catch {
      throw provenanceError("PM_STUDIO_PROVENANCE_TREE_INVALID", "PM Studio app contains an unreadable directory");
    }
    names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    for (const name of names) {
      const fullPath = path.join(directory, name);
      const relative = path.relative(root, fullPath).split(path.sep).join("/");
      let stat;
      try {
        stat = await fsp.lstat(fullPath, { bigint: true });
      } catch {
        throw provenanceError("PM_STUDIO_PROVENANCE_TREE_CHANGED", "PM Studio app changed while it was being verified");
      }
      remember(relative);
      const mode = Number(stat.mode & 0o7777n);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        entries.set(relative, { type: "directory", mode });
        await visit(fullPath, stat);
      } else if (stat.isSymbolicLink()) {
        let target;
        let targetReal;
        try {
          target = await fsp.readlink(fullPath);
          if (path.isAbsolute(target)) throw new Error("absolute");
          const lexicalTarget = path.resolve(path.dirname(fullPath), target);
          if (!isWithin(root, lexicalTarget)) throw new Error("escape");
          targetReal = await fsp.realpath(fullPath);
        } catch {
          throw provenanceError("PM_STUDIO_PROVENANCE_SYMLINK_INVALID", "PM Studio app contains an unsafe symlink");
        }
        if (!isWithin(rootReal, targetReal)) {
          throw provenanceError("PM_STUDIO_PROVENANCE_SYMLINK_INVALID", "PM Studio app contains an unsafe symlink");
        }
        let pathAfter;
        try {
          pathAfter = await fsp.lstat(fullPath, { bigint: true });
        } catch {
          throw provenanceError("PM_STUDIO_PROVENANCE_TREE_CHANGED", "PM Studio app changed while it was being verified");
        }
        if (!sameFileIdentity(stat, pathAfter)) {
          throw provenanceError("PM_STUDIO_PROVENANCE_TREE_CHANGED", "PM Studio app changed while it was being verified");
        }
        entries.set(relative, { type: "symlink", mode, target });
      } else if (stat.isFile()) {
        if (stat.nlink !== 1n) {
          throw provenanceError("PM_STUDIO_PROVENANCE_HARDLINK_INVALID", "PM Studio app contains a hard-linked file");
        }
        entries.set(relative, {
          type: "file",
          mode,
          size: stat.size.toString(),
          sha256: await hashRegularFile(fullPath, stat),
        });
      } else {
        throw provenanceError("PM_STUDIO_PROVENANCE_TREE_INVALID", "PM Studio app contains an unsupported entry");
      }
    }
    let directoryAfter;
    try {
      directoryAfter = await fsp.lstat(directory, { bigint: true });
    } catch {
      throw provenanceError("PM_STUDIO_PROVENANCE_TREE_CHANGED", "PM Studio app changed while it was being verified");
    }
    if (!sameFileIdentity(expectedDirectoryStat, directoryAfter)) {
      throw provenanceError("PM_STUDIO_PROVENANCE_TREE_CHANGED", "PM Studio app changed while it was being verified");
    }
  };
  await visit(root, rootStat);
  let xattrOutput;
  try {
    xattrOutput = await readXattrOutput(root);
  } catch (error) {
    if (error?.code?.startsWith?.("PM_STUDIO_PROVENANCE_")) throw error;
    throw provenanceError("PM_STUDIO_PROVENANCE_XATTR_INVALID",
      "PM Studio extended attributes could not be inspected");
  }
  const xattrs = parseXattrOutput(xattrOutput, root);
  for (const [relative, attributes] of xattrs) {
    const entry = entries.get(relative);
    if (!entry) {
      throw provenanceError("PM_STUDIO_PROVENANCE_TREE_CHANGED",
        "PM Studio changed while its extended attributes were being verified");
    }
    entry.xattrs = attributes;
  }
  for (const entry of entries.values()) entry.xattrs ||= [];
  return entries;
}

function entriesEqual(left, right) {
  if (left.type !== right.type || left.mode !== right.mode) return false;
  if (JSON.stringify(left.xattrs) !== JSON.stringify(right.xattrs)) return false;
  if (left.type === "file") return left.size === right.size && left.sha256 === right.sha256;
  if (left.type === "symlink") return left.target === right.target;
  return true;
}

export async function comparePmStudioAppTrees(installedAppPath, officialAppPath, {
  readXattrOutput = defaultReadXattrOutput,
} = {}) {
  if (typeof installedAppPath !== "string" || !installedAppPath
    || typeof officialAppPath !== "string" || !officialAppPath) {
    throw provenanceError("PM_STUDIO_PROVENANCE_INPUT_INVALID", "Both PM Studio app paths are required");
  }
  if (typeof readXattrOutput !== "function") {
    throw provenanceError("PM_STUDIO_PROVENANCE_INPUT_INVALID",
      "PM Studio extended attribute reader is invalid");
  }
  const installed = await snapshotAppTree(installedAppPath, readXattrOutput);
  const official = await snapshotAppTree(officialAppPath, readXattrOutput);
  const ignoredMissing = [];

  for (const [relative, officialEntry] of official) {
    const installedEntry = installed.get(relative);
    if (!installedEntry) {
      if (LOCALE_MISSING_PATTERN.test(relative)) {
        ignoredMissing.push(relative);
        continue;
      }
      throw provenanceError("PM_STUDIO_PROVENANCE_TREE_MISMATCH", `Installed PM Studio is missing ${relative}`);
    }
    if (!entriesEqual(installedEntry, officialEntry)) {
      throw provenanceError("PM_STUDIO_PROVENANCE_TREE_MISMATCH", `Installed PM Studio differs at ${relative}`);
    }
  }
  for (const relative of installed.keys()) {
    if (!official.has(relative)) {
      throw provenanceError("PM_STUDIO_PROVENANCE_TREE_MISMATCH", `Installed PM Studio contains an extra entry at ${relative}`);
    }
  }

  return {
    matched: true,
    comparedEntries: official.size - ignoredMissing.length,
    ignoredMissing,
  };
}

function validateVerificationOptions({
  installedAppPath,
  version,
  arch,
  fetchImpl,
  extractor,
  maxDownloadBytes,
  readXattrOutput,
}) {
  assertVersionAndArch(version, arch);
  if (typeof installedAppPath !== "string" || !installedAppPath
    || typeof fetchImpl !== "function"
    || typeof extractor !== "function"
    || typeof readXattrOutput !== "function"
    || !Number.isSafeInteger(maxDownloadBytes)
    || maxDownloadBytes <= 0) {
    throw provenanceError("PM_STUDIO_PROVENANCE_INPUT_INVALID", "PM Studio provenance options are invalid");
  }
}

export async function verifyOfficialPmStudioProvenance({
  installedAppPath,
  version,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  extractor,
  tmpRoot = os.tmpdir(),
  maxDownloadBytes = PM_STUDIO_OFFICIAL_MAX_DOWNLOAD_BYTES,
  readXattrOutput = defaultReadXattrOutput,
  signal,
} = {}) {
  validateVerificationOptions({
    installedAppPath,
    version,
    arch,
    fetchImpl,
    extractor,
    maxDownloadBytes,
    readXattrOutput,
  });
  const selected = await fetchOfficialRelease({ version, arch, fetchImpl, signal });
  if (selected.asset.size > maxDownloadBytes) {
    throw provenanceError("PM_STUDIO_PROVENANCE_DOWNLOAD_TOO_LARGE", "Official PM Studio artifact exceeds the download limit");
  }

  let workspace;
  try {
    let resolvedTmpRoot;
    try {
      resolvedTmpRoot = await fsp.realpath(tmpRoot);
      const stat = await fsp.stat(resolvedTmpRoot);
      if (!stat.isDirectory()) throw new Error("not a directory");
      workspace = await fsp.mkdtemp(path.join(resolvedTmpRoot, "ccdx-pm-official-"));
      await fsp.chmod(workspace, 0o700);
    } catch {
      throw provenanceError("PM_STUDIO_PROVENANCE_TEMP_FAILED", "Could not create a private PM Studio verification directory");
    }

    const archivePath = path.join(workspace, selected.asset.name);
    const destination = path.join(workspace, "extracted");
    await fsp.mkdir(destination, { mode: 0o700 });
    await fsp.chmod(destination, 0o700);
    await downloadArtifact({ selected, archivePath, fetchImpl, maxDownloadBytes, signal });

    try {
      await extractor({
        archivePath,
        destination,
        version: selected.version,
        arch: selected.arch,
        asset: {
          name: selected.asset.name,
          size: selected.asset.size,
          sha256: selected.asset.sha256,
        },
      });
    } catch {
      throw provenanceError("PM_STUDIO_PROVENANCE_EXTRACT_FAILED", "Could not extract the official PM Studio artifact");
    }

    let officialAppPath;
    try {
      officialAppPath = await findExtractedApp(destination);
    } catch (error) {
      if (error?.code?.startsWith?.("PM_STUDIO_PROVENANCE_")) throw error;
      throw provenanceError("PM_STUDIO_PROVENANCE_EXTRACT_INVALID", "Extracted PM Studio artifact is invalid");
    }
    const comparison = await comparePmStudioAppTrees(installedAppPath, officialAppPath, {
      readXattrOutput,
    });
    return {
      verified: true,
      repository: selected.repository,
      version: selected.version,
      tag: selected.tag,
      arch: selected.arch,
      releaseUrl: selected.releaseUrl,
      asset: {
        name: selected.asset.name,
        size: selected.asset.size,
        sha256: selected.asset.sha256,
      },
      comparison,
    };
  } finally {
    if (workspace) await fsp.rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  }
}
