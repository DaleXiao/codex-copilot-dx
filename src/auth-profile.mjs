import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-file.mjs";
import {
  githubTokenLockPath,
  githubTokenMetadataPath,
  githubTokenPath,
} from "./auth.mjs";
import {
  githubTokenFingerprint,
  normalizeGithubIdentity,
} from "./github-identity.mjs";
import { withFileLock } from "./lock.mjs";
import { parsePositiveInteger, RUNTIME_DEFAULTS } from "./runtime-config.mjs";

export const AUTH_PROFILE_CODEX = "codex";
export const AUTH_PROFILE_CLAUDE = "claude";

const AUTH_PROFILES = new Set([AUTH_PROFILE_CODEX, AUTH_PROFILE_CLAUDE]);

function checkedProfile(profile) {
  const value = String(profile || "").trim().toLowerCase();
  if (!AUTH_PROFILES.has(value)) throw new Error(`Unsupported authentication profile: ${profile}`);
  return value;
}

export function authProfilePaths(profile, { home = os.homedir() } = {}) {
  const name = checkedProfile(profile);
  if (name === AUTH_PROFILE_CODEX) {
    return {
      profile: name,
      tokenPath: githubTokenPath(home),
      metadataPath: githubTokenMetadataPath(home),
      lockPath: githubTokenLockPath(home),
    };
  }

  const directory = path.join(home, ".local", "share", "copilot-api", "profiles", AUTH_PROFILE_CLAUDE);
  const tokenPath = path.join(directory, "github_token");
  return {
    profile: name,
    tokenPath,
    metadataPath: `${tokenPath}.account.json`,
    lockPath: `${tokenPath}.lock`,
  };
}

function readOptionalFile(filePath) {
  try {
    return { exists: true, data: fs.readFileSync(filePath), mode: fs.statSync(filePath).mode & 0o777 };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, data: null, mode: 0o600 };
    throw error;
  }
}

function parsedMetadata(snapshot) {
  if (!snapshot.exists) return { value: null, malformed: false };
  try {
    return { value: JSON.parse(snapshot.data.toString("utf8")), malformed: false };
  } catch {
    return { value: null, malformed: true };
  }
}

export function readAuthProfileCredentials(profile, { home = os.homedir() } = {}) {
  const paths = authProfilePaths(profile, { home });
  const tokenSnapshot = readOptionalFile(paths.tokenPath);
  const metadataSnapshot = readOptionalFile(paths.metadataPath);
  const token = tokenSnapshot.exists ? tokenSnapshot.data.toString("utf8").trim() : "";
  const metadataResult = parsedMetadata(metadataSnapshot);
  const metadataFingerprint = metadataResult.value?.token_fingerprint;
  const metadataMatchesToken = Boolean(token)
    && Boolean(metadataFingerprint)
    && metadataFingerprint === githubTokenFingerprint(token);
  const metadataIdentity = normalizeGithubIdentity(metadataResult.value);
  const identity = metadataMatchesToken ? metadataIdentity : null;

  if (paths.profile === AUTH_PROFILE_CODEX) {
    const configured = tokenSnapshot.exists;
    return {
      profile: paths.profile,
      configured,
      valid: configured && Boolean(token),
      reason: !configured ? "unconfigured" : token ? "" : "empty_token",
      token,
      identity,
      metadata: metadataResult.value,
      paths,
    };
  }

  // Metadata is written last, but any credential artifact reserves the Claude
  // profile. A partial write must fail closed instead of borrowing Codex.
  const configured = metadataSnapshot.exists || tokenSnapshot.exists;
  let reason = "";
  if (!configured) reason = "unconfigured";
  else if (!metadataSnapshot.exists) reason = "missing_metadata";
  else if (metadataResult.malformed) reason = "metadata_malformed";
  else if (!tokenSnapshot.exists) reason = "missing_token";
  else if (!token) reason = "empty_token";
  else if (!metadataIdentity) reason = "metadata_identity_missing";
  else if (!metadataFingerprint || metadataFingerprint !== githubTokenFingerprint(token)) reason = "token_metadata_mismatch";

  return {
    profile: paths.profile,
    configured,
    valid: configured && !reason,
    reason,
    token,
    identity,
    metadata: metadataResult.value,
    paths,
  };
}

function lockOptions(env = process.env) {
  return {
    timeoutMs: parsePositiveInteger(env.CCDX_TOKEN_LOCK_TIMEOUT_MS, RUNTIME_DEFAULTS.tokenLockTimeoutMs),
    staleMs: parsePositiveInteger(env.CCDX_TOKEN_LOCK_STALE_MS, RUNTIME_DEFAULTS.tokenLockStaleMs),
  };
}

export function withAuthProfileLock(profile, fn, {
  home = os.homedir(),
  env = process.env,
  ...options
} = {}) {
  const { lockPath } = authProfilePaths(profile, { home });
  return withFileLock(lockPath, fn, { ...lockOptions(env), ...options });
}

function writeSecret(filePath, data, writeFile) {
  writeFile(filePath, data, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function restoreSnapshot(filePath, snapshot, writeFile) {
  if (snapshot.exists) {
    writeSecret(filePath, snapshot.data, writeFile);
    return;
  }
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function writeClaudeAuthProfile(token, identity, {
  home = os.homedir(),
  now = () => new Date(),
  writeFile = atomicWriteFileSync,
} = {}) {
  const cleanToken = String(token || "").trim();
  const normalizedIdentity = normalizeGithubIdentity(identity);
  if (!cleanToken) throw new Error("Claude GitHub token is empty");
  if (!normalizedIdentity) throw new Error("Claude GitHub account identity is missing");

  const paths = authProfilePaths(AUTH_PROFILE_CLAUDE, { home });
  const directory = path.dirname(paths.tokenPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);

  const previousToken = readOptionalFile(paths.tokenPath);
  const previousMetadata = readOptionalFile(paths.metadataPath);
  const timestamp = now();
  const updatedAt = timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString();
  const metadata = `${JSON.stringify({
    profile: AUTH_PROFILE_CLAUDE,
    ...normalizedIdentity,
    token_fingerprint: githubTokenFingerprint(cleanToken),
    updated_at: updatedAt,
  }, null, 2)}\n`;

  try {
    writeSecret(paths.tokenPath, cleanToken, writeFile);
    // Commit the activation marker last. Readers never observe a configured
    // Claude profile unless the token and its fingerprint agree.
    writeSecret(paths.metadataPath, metadata, writeFile);
  } catch (error) {
    try {
      restoreSnapshot(paths.tokenPath, previousToken, writeFile);
      restoreSnapshot(paths.metadataPath, previousMetadata, writeFile);
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  }

  return {
    profile: AUTH_PROFILE_CLAUDE,
    identity: normalizedIdentity,
    paths,
  };
}

export function profileReauthMessage(profile, { home = os.homedir() } = {}) {
  const name = checkedProfile(profile);
  if (name === AUTH_PROFILE_CLAUDE) {
    return "Claude authentication is unavailable. Run `ccdx auth login claude --reauth`, then restart ccdx.";
  }
  return `Codex authentication is unavailable at ${authProfilePaths(name, { home }).tokenPath}. Run ccdx again to log in.`;
}
