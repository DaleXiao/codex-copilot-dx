import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { atomicWriteFilePairSync, atomicWriteFileSync } from "./atomic-file.mjs";
import { githubTokenFingerprint, normalizeGithubIdentity } from "./github-identity.mjs";
import { readBoundedFileSync, MAX_TOKEN_FILE_BYTES } from "./bounded-file.mjs";
import { additionalGithubSources, readAdditionalGithubSource } from "./auth-sources.mjs";

const DISABLE_TOKEN_DISCOVERY_VALUES = new Set(["1", "true", "yes"]);
const MAX_AUTH_JSON_BYTES = 1024 * 1024;
const pathKey = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

export function managedGithubTokenPath(home = os.homedir()) {
  return path.join(home, ".local", "share", "ccdx", "github_token");
}

export function legacyGithubTokenPath(home = os.homedir()) {
  return path.join(home, ".local", "share", "copilot-api", "github_token");
}

export function githubTokenPath(home = os.homedir()) {
  const managed = managedGithubTokenPath(home);
  try { fs.lstatSync(managed);return managed; }
  catch (error) { if (error.code !== "ENOENT") return managed; }
  return legacyGithubTokenPath(home);
}

export function githubTokenLockPath(home = os.homedir()) {
  return `${legacyGithubTokenPath(home)}.lock`;
}

export function githubTokenMetadataPath(home = os.homedir()) {
  return `${githubTokenPath(home)}.account.json`;
}

export function githubReauthMessage(reason, home = os.homedir()) {
  return `${reason}
Run ccdx source github reauth to sign in again.
The saved sign-in is kept until verification succeeds.`;
}

function expandHome(filePath, home = os.homedir()) {
  if (!filePath) return "";
  if (filePath === "~") return home;
  if (filePath.startsWith("~/")) return path.join(home, filePath.slice(2));
  return filePath;
}

function isTokenDiscoveryDisabled(env = process.env) {
  return DISABLE_TOKEN_DISCOVERY_VALUES.has(String(env.CCDX_DISABLE_TOKEN_DISCOVERY || "").toLowerCase());
}

function splitPathList(value) {
  return String(value || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function localAuthRoots(home, env = process.env) {
  const roots = [
    path.join(home, "Library", "Application Support"),
    env.APPDATA ? expandHome(env.APPDATA, home) : "",
    env.LOCALAPPDATA ? expandHome(env.LOCALAPPDATA, home) : "",
    env.XDG_CONFIG_HOME ? expandHome(env.XDG_CONFIG_HOME, home) : path.join(home, ".config"),
  ].filter(Boolean);
  const seen = new Set();
  return roots.filter(root => { const key = pathKey(root);if (seen.has(key)) return false;seen.add(key);return true; });
}

function addAuthJsonSource(sources, seen, filePath) {
  if (seen.has(pathKey(filePath))) return;
  if (!fs.existsSync(filePath)) return;
  seen.add(pathKey(filePath));
  sources.push({ type: "auth-json", path: filePath });
}

function localAuthJsonSources(home, env = process.env) {
  const sources = [];
  const seen = new Set();

  for (const root of localAuthRoots(home, env)) {
    let appDirs;
    try {
      appDirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    if (appDirs.length > 256) Object.defineProperty(sources, "incomplete", { value: true, configurable: true });
    for (const appDirent of appDirs.slice(0, 256)) {
      if (sources.length >= 128) {
        Object.defineProperty(sources, "incomplete", { value: true, configurable: true });return sources;
      }
      if (!appDirent.isDirectory()) continue;
      const appDir = path.join(root, appDirent.name);
      addAuthJsonSource(sources, seen, path.join(appDir, "auth.json"));

      const profilesDir = path.join(appDir, "profiles");
      let profileDirs;
      try {
        profileDirs = fs.readdirSync(profilesDir, { withFileTypes: true });
      } catch {
        continue;
      }

      if (profileDirs.length > 64) Object.defineProperty(sources, "incomplete", { value: true, configurable: true });
      for (const profileDirent of profileDirs.slice(0, 64)) {
        if (sources.length >= 128) {
          Object.defineProperty(sources, "incomplete", { value: true, configurable: true });return sources;
        }
        if (!profileDirent.isDirectory()) continue;
        addAuthJsonSource(sources, seen, path.join(profilesDir, profileDirent.name, "auth.json"));
      }
    }
  }

  return sources;
}

function explicitTokenFileSources(home, env = process.env) {
  const paths = [];
  if (typeof env.CCDX_GITHUB_TOKEN_PATH === "string" && env.CCDX_GITHUB_TOKEN_PATH.trim()) {
    paths.push(env.CCDX_GITHUB_TOKEN_PATH.trim());
  }
  paths.push(...splitPathList(env.CCDX_GITHUB_TOKEN_PATHS));

  const seen = new Set();
  return paths
    .map((filePath) => expandHome(filePath, home))
    .filter((filePath) => {
      if (seen.has(pathKey(filePath))) return false;
      seen.add(pathKey(filePath));
      return true;
    })
    .map((filePath) => ({
      type: "token-file",
      name: "configured token file",
      path: filePath,
    }));
}

function looksLikeCopilotAuthJson(json) {
  if (!json || typeof json !== "object") return false;
  if (json.ghcAuth || json.gitHubTokens || json.githubToken || json.githubCopilot || json.copilot) return true;
  return typeof json.access_token === "string" && Boolean(json.copilotAccess || json.copilotToken || json.copilot_token);
}

function readSmallJson(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_AUTH_JSON_BYTES) return null;
  return JSON.parse(readBoundedFileSync(filePath, { encoding: "utf8", maxBytes: MAX_AUTH_JSON_BYTES }));
}

export function githubTokenSources({
  home = os.homedir(),
  env = process.env,
} = {}) {
  if (isTokenDiscoveryDisabled(env)) return [];
  const sources = [];
  if (typeof env.CCDX_GITHUB_TOKEN === "string" && env.CCDX_GITHUB_TOKEN.trim()) {
    sources.push({ type: "env", name: "CCDX_GITHUB_TOKEN", token: env.CCDX_GITHUB_TOKEN.trim() });
  }
  sources.push(...explicitTokenFileSources(home, env));
  const local = localAuthJsonSources(home, env);
  sources.push(...local);
  sources.push(...additionalGithubSources(home, env));
  if (local.incomplete) Object.defineProperty(sources, "incomplete", { value: true });
  return sources;
}

export function sourceDescription(source) {
  if (!source) return "unknown source";
  if (source.type === "env") return source.name;
  if (source.type === "token-file") return `${source.name} (${source.path})`;
  if (source.type === "auth-json") return `local auth file (${source.path})`;
  if (source.type === "opencode-auth") return `OpenCode Copilot auth (${source.path})`;
  if (source.type === "github-cli") return "GitHub CLI (github.com)";
  return source.path || source.name || "unknown source";
}

export function extractGithubTokenFromAuthJson(json) {
  const candidates = [
    json?.ghcAuth?.gitHubTokens?.access_token,
    json?.ghcAuth?.gitHubTokens?.accessToken,
    json?.ghcAuth?.githubToken,
    json?.gitHubTokens?.access_token,
    json?.gitHubTokens?.accessToken,
    json?.githubToken,
    json?.access_token,
    json?.accessToken,
  ];
  return candidates.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

export function readGithubTokenSource(source, options = {}) {
  if (source?.type === "env") return source.token || "";
  if (source?.type === "token-file") return readBoundedFileSync(source.path, { encoding: "utf8", maxBytes: MAX_TOKEN_FILE_BYTES }).trim();
  if (source?.type === "auth-json") {
    const json = readSmallJson(source.path);
    if (!looksLikeCopilotAuthJson(json)) return "";
    return extractGithubTokenFromAuthJson(json);
  }
  return readAdditionalGithubSource(source, { readJson: readSmallJson, ...options });
}

export function readSavedGithubToken(home = os.homedir()) {
  const filePath = githubTokenPath(home);
  if (!fs.existsSync(filePath)) return "";
  return readBoundedFileSync(filePath, { encoding: "utf8", maxBytes: MAX_TOKEN_FILE_BYTES }).trim();
}

export function readGithubTokenMetadata(home = os.homedir(), token = null) {
  try {
    const parsed = JSON.parse(readBoundedFileSync(githubTokenMetadataPath(home), { encoding: "utf8" }));
    if (token && parsed.token_fingerprint !== githubTokenFingerprint(token)) return null;
    const identity = normalizeGithubIdentity(parsed);
    return identity ? { ...identity, token_fingerprint: parsed.token_fingerprint || "" } : null;
  } catch {
    return null;
  }
}

function githubTokenMetadataData(identity, token, now = () => new Date()) {
  const normalized = normalizeGithubIdentity(identity);
  if (!normalized) return null;
  const timestamp = now();
  const updatedAt = timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString();
  return `${JSON.stringify({
    ...normalized,
    token_fingerprint: githubTokenFingerprint(token),
    updated_at: updatedAt,
  }, null, 2)}\n`;
}

export function writeGithubTokenMetadata(identity, home = os.homedir(), token = "", {
  now = () => new Date(),
  writeFile = atomicWriteFileSync,
} = {}) {
  const metadata = githubTokenMetadataData(identity, token, now);
  if (metadata === null) return false;
  const filePath = githubTokenMetadataPath(home);
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  writeFile(filePath, metadata, { mode: 0o600, preserveMode: false });
  fs.chmodSync(filePath, 0o600);
  return true;
}

export function writeToken(token, home = os.homedir(), identity = null, {
  now = () => new Date(),
  writeFile = atomicWriteFileSync,
  unlinkFile = fs.unlinkSync,
  managed = false,
} = {}) {
  const GITHUB_TOKEN_PATH = managed ? managedGithubTokenPath(home) : githubTokenPath(home);
  const directory = path.dirname(GITHUB_TOKEN_PATH);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  atomicWriteFilePairSync(
    GITHUB_TOKEN_PATH,
    token,
    `${GITHUB_TOKEN_PATH}.account.json`,
    githubTokenMetadataData(identity, token, now),
    { mode: 0o600, writeFile, unlinkFile },
  );
}

