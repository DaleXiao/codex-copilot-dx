import fs from "node:fs";
import os from "node:os";
import {
  githubTokenLockPath,
  githubTokenMetadataPath,
  githubTokenPath,
} from "./auth.mjs";
import {
  githubTokenFingerprint,
  normalizeGithubIdentity,
} from "./github-identity.mjs";

export const AUTH_PROFILE_CODEX = "codex";

function checkedProfile(profile) {
  const value = String(profile || "").trim().toLowerCase();
  if (value !== AUTH_PROFILE_CODEX) {
    throw new Error(`Unsupported authentication profile: ${profile}`);
  }
  return value;
}

export function authProfilePaths(profile, { home = os.homedir() } = {}) {
  const name = checkedProfile(profile);
  return {
    profile: name,
    tokenPath: githubTokenPath(home),
    metadataPath: githubTokenMetadataPath(home),
    lockPath: githubTokenLockPath(home),
  };
}

function readOptionalFile(filePath) {
  try {
    return { exists: true, data: fs.readFileSync(filePath) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, data: null };
    throw error;
  }
}

function parsedMetadata(snapshot) {
  if (!snapshot.exists) return null;
  try {
    return JSON.parse(snapshot.data.toString("utf8"));
  } catch {
    return null;
  }
}

export function readAuthProfileCredentials(profile, { home = os.homedir() } = {}) {
  const paths = authProfilePaths(profile, { home });
  const tokenSnapshot = readOptionalFile(paths.tokenPath);
  const token = tokenSnapshot.exists ? tokenSnapshot.data.toString("utf8").trim() : "";
  const metadata = parsedMetadata(readOptionalFile(paths.metadataPath));
  const metadataMatchesToken = Boolean(token)
    && Boolean(metadata?.token_fingerprint)
    && metadata.token_fingerprint === githubTokenFingerprint(token);

  return {
    profile: paths.profile,
    configured: tokenSnapshot.exists,
    valid: tokenSnapshot.exists && Boolean(token),
    reason: !tokenSnapshot.exists ? "unconfigured" : token ? "" : "empty_token",
    token,
    identity: metadataMatchesToken ? normalizeGithubIdentity(metadata) : null,
    metadata,
    paths,
  };
}
