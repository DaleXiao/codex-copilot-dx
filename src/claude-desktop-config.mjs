import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { claudeDesktopModelIds } from "./models.mjs";
import { status } from "./status.mjs";
import { atomicWriteFileIfChangedSync, atomicWriteFileSync } from "./atomic-file.mjs";

const CONFIG_FILE = "claude_desktop_config.json";
const CONFIG_LIBRARY_DIR = "configLibrary";
export const DEFAULT_CLAUDE_DESKTOP_PROFILE_ID = "00000000-0000-4000-8000-000000202600";
export const DEFAULT_CLAUDE_DESKTOP_PROFILE_NAME = "Codex Copilot DX";

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function valueOrDefault(value, fallback) {
  const trimmed = String(value || "").trim();
  return trimmed || fallback;
}

function isLoopbackHost(host) {
  const normalized = String(host || "").toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return ["127.0.0.1", "localhost", "::1"].includes(normalized);
}

function localGatewayBaseUrl(host, port) {
  const safeHost = String(host || "127.0.0.1");
  const urlHost = safeHost.includes(":") && !safeHost.startsWith("[") ? `[${safeHost}]` : safeHost;
  return `http://${urlHost}:${port}`;
}

export function claudeDesktopPaths(home = os.homedir(), platform = process.platform, env = process.env) {
  if (platform === "win32") {
    const localAppData = valueOrDefault(env.LOCALAPPDATA, path.join(home, "AppData", "Local"));
    return pathsFromDirs(path.join(localAppData, "Claude"), path.join(localAppData, "Claude-3p"));
  }
  const appSupport = path.join(home, "Library", "Application Support");
  return pathsFromDirs(path.join(appSupport, "Claude"), path.join(appSupport, "Claude-3p"));
}

function pathsFromDirs(normalDir, threepDir) {
  const configLibraryPath = path.join(threepDir, CONFIG_LIBRARY_DIR);
  return {
    normalConfigPath: path.join(normalDir, CONFIG_FILE),
    threepConfigPath: path.join(threepDir, CONFIG_FILE),
    configLibraryPath,
    metaPath: path.join(configLibraryPath, "_meta.json"),
  };
}

export function validateClaudeDesktopBaseUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Claude App gateway base URL is not valid: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Claude App gateway base URL must use http or https");
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error("Claude App allows http only for loopback; use https for LAN or remote gateways");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Claude App gateway base URL must be the root URL without /v1, query, or hash");
  }
}

function isGatewayProfileField(key) {
  return [
    "inferenceProvider",
    "inferenceGatewayBaseUrl",
    "inferenceGatewayApiKey",
    "inferenceGatewayAuthScheme",
    "inferenceModels",
  ].includes(key);
}

export function computeClaudeDesktopProfile(sourceProfile = {}, {
  baseUrl,
  gatewayApiKey,
  modelIds = claudeDesktopModelIds(),
} = {}) {
  validateClaudeDesktopBaseUrl(baseUrl);
  if (!String(gatewayApiKey || "").trim()) {
    throw new Error("Claude App gateway API key is required");
  }

  const profile = {};
  for (const [key, value] of Object.entries(sourceProfile || {})) {
    if (key === "enterpriseConfig" || isGatewayProfileField(key)) continue;
    profile[key] = jsonClone(value);
  }

  profile.inferenceProvider = "gateway";
  profile.inferenceGatewayBaseUrl = baseUrl;
  profile.inferenceGatewayApiKey = gatewayApiKey;
  profile.inferenceGatewayAuthScheme = "bearer";
  profile.inferenceModels = JSON.stringify(modelIds);
  if (!profile.disableDeploymentModeChooser) profile.disableDeploymentModeChooser = "true";
  return profile;
}

export function computeClaudeDesktopMeta(meta = {}, profileId = DEFAULT_CLAUDE_DESKTOP_PROFILE_ID, profileName = DEFAULT_CLAUDE_DESKTOP_PROFILE_NAME) {
  const out = { ...(meta || {}) };
  const entries = Array.isArray(out.entries) ? out.entries : [];
  out.entries = [
    ...entries.filter((entry) => entry?.id !== profileId),
    { id: profileId, name: profileName },
  ];
  out.appliedId = profileId;
  return out;
}

export function computeDeploymentConfig(config = {}) {
  return { ...(config || {}), deploymentMode: "3p" };
}

function readJsonFile(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    if (e?.code === "ENOENT") return fallback;
    throw e;
  }
}

function writeJsonFile(filePath, data) {
  return atomicWriteFileIfChangedSync(filePath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

function snapshotFiles(files) {
  return files.map((filePath) => {
    try {
      return { filePath, exists: true, data: fs.readFileSync(filePath) };
    } catch (e) {
      if (e?.code === "ENOENT") return { filePath, exists: false };
      throw e;
    }
  });
}

function restoreSnapshots(snapshots) {
  for (const snapshot of snapshots) {
    if (!snapshot.exists) {
      fs.rmSync(snapshot.filePath, { force: true });
      continue;
    }
    atomicWriteFileSync(snapshot.filePath, snapshot.data, { mode: 0o600 });
  }
}

function readActiveProfile(paths) {
  const meta = readJsonFile(paths.metaPath, {});
  const appliedId = String(meta.appliedId || "").trim();
  if (!appliedId) return {};
  return readJsonFile(path.join(paths.configLibraryPath, `${appliedId}.json`), {});
}

export function loadManagedClaudeDesktopApiKey({
  port = 2026,
  host = "127.0.0.1",
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
} = {}) {
  try {
    const paths = claudeDesktopPaths(home, platform, env);
    const meta = readJsonFile(paths.metaPath, {});
    if (String(meta.appliedId || "").trim() !== DEFAULT_CLAUDE_DESKTOP_PROFILE_ID) return "";

    const profilePath = path.join(paths.configLibraryPath, `${DEFAULT_CLAUDE_DESKTOP_PROFILE_ID}.json`);
    const profile = readJsonFile(profilePath, {});
    if (profile.inferenceProvider !== "gateway") return "";
    if (String(profile.inferenceGatewayAuthScheme || "").trim().toLowerCase() !== "bearer") return "";

    const profileBaseUrl = String(profile.inferenceGatewayBaseUrl || "").trim();
    validateClaudeDesktopBaseUrl(profileBaseUrl);
    if (new URL(profileBaseUrl).href !== new URL(localGatewayBaseUrl(host, port)).href) return "";

    const apiKey = String(profile.inferenceGatewayApiKey || "").trim();
    return apiKey && apiKey !== "dummy" ? apiKey : "";
  } catch {
    return "";
  }
}

export function applyClaudeDesktopConfig({
  port = 2026,
  host = "127.0.0.1",
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  baseUrl = localGatewayBaseUrl(host, port),
  gatewayApiKey = env.CCDX_CLAUDE_DESKTOP_API_KEY || env.CCDX_PROXY_API_KEY || "dummy",
  modelIds = claudeDesktopModelIds(env),
  profileId = DEFAULT_CLAUDE_DESKTOP_PROFILE_ID,
  profileName = DEFAULT_CLAUDE_DESKTOP_PROFILE_NAME,
} = {}) {
  const paths = claudeDesktopPaths(home, platform, env);
  const profilePath = path.join(paths.configLibraryPath, `${profileId}.json`);
  const snapshots = snapshotFiles([
    paths.normalConfigPath,
    paths.threepConfigPath,
    paths.metaPath,
    profilePath,
  ]);

  try {
    const sourceProfile = readActiveProfile(paths);
    const normalConfig = readJsonFile(paths.normalConfigPath, {});
    const threepConfig = readJsonFile(paths.threepConfigPath, {});
    const meta = readJsonFile(paths.metaPath, {});

    writeJsonFile(paths.normalConfigPath, computeDeploymentConfig(normalConfig));
    writeJsonFile(paths.threepConfigPath, computeDeploymentConfig(threepConfig));
    writeJsonFile(profilePath, computeClaudeDesktopProfile(sourceProfile, { baseUrl, gatewayApiKey, modelIds }));
    writeJsonFile(paths.metaPath, computeClaudeDesktopMeta(meta, profileId, profileName));
  } catch (e) {
    restoreSnapshots(snapshots);
    throw e;
  }

  return {
    paths,
    profileId,
    profilePath,
    baseUrl,
    modelIds,
  };
}

export function formatClaudeDesktopApplyResult(result) {
  return [
    "Claude App local gateway profile",
    `profile id: ${result.profileId}`,
    `profile path: ${result.profilePath}`,
    `base url: ${result.baseUrl}`,
    `models: ${result.modelIds.join(", ")}`,
    "gateway api key: <redacted>",
  ].join("\n");
}

export function ensureClaudeDesktopConfig(port = 2026, host = "127.0.0.1") {
  const result = applyClaudeDesktopConfig({
    port,
    host,
    gatewayApiKey: process.env.CCDX_CLAUDE_DESKTOP_API_KEY || process.env.CCDX_PROXY_API_KEY || generatedClaudeDesktopApiKey(),
  });
  console.log(status("ok", `Configured Claude App gateway profile at ${result.baseUrl}`));
  console.log(formatClaudeDesktopApplyResult(result));
  return result;
}

export function generatedClaudeDesktopApiKey() {
  return `ccdx_${randomUUID().replaceAll("-", "")}`;
}
