import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { status } from "./status.mjs";
import { withFileLock } from "./lock.mjs";

const CLIENT_ID = "Iv1.b507a08c87ecfe98"; // Public GitHub Copilot client ID.
const SCOPE = "read:user";
const GITHUB_API = "https://api.github.com";
const COPILOT_TOKEN_URL = `${GITHUB_API}/copilot_internal/v2/token`;
const DISABLE_TOKEN_DISCOVERY_VALUES = new Set(["1", "true", "yes"]);
const MAX_AUTH_JSON_BYTES = 1024 * 1024;
const DEFAULT_TOKEN_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TOKEN_LOCK_STALE_MS = 15 * 60 * 1000;

export function githubTokenPath(home = os.homedir()) {
  return path.join(home, ".local", "share", "copilot-api", "github_token");
}

export function githubTokenLockPath(home = os.homedir()) {
  return `${githubTokenPath(home)}.lock`;
}

export function githubTokenMetadataPath(home = os.homedir()) {
  return `${githubTokenPath(home)}.account.json`;
}

export function githubReauthMessage(reason, home = os.homedir()) {
  const tokenPath = githubTokenPath(home);
  return `${reason}
Delete the saved GitHub token, then run codex-copilot-dx again to log in:
  rm '${tokenPath}'
  codex-copilot-dx`;
}

// Map GitHub polling responses to a small local state machine.
export function interpretPoll(data) {
  if (typeof data.access_token === "string" && data.access_token) return { state: "done", token: data.access_token };
  switch (data.error) {
    case "authorization_pending": return { state: "wait" };
    case "slow_down": return { state: "slow" };
    default: return { state: "fail", error: data.error || "unknown" };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function expandHome(filePath, home = os.homedir()) {
  if (!filePath) return "";
  if (filePath === "~") return home;
  if (filePath.startsWith("~/")) return path.join(home, filePath.slice(2));
  return filePath;
}

function isTokenDiscoveryDisabled(env = process.env) {
  return DISABLE_TOKEN_DISCOVERY_VALUES.has(String(env.CCDX_DISABLE_TOKEN_DISCOVERY || "").toLowerCase());
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function tokenLockOptions(env = process.env) {
  return {
    timeoutMs: positiveInt(env.CCDX_TOKEN_LOCK_TIMEOUT_MS, DEFAULT_TOKEN_LOCK_TIMEOUT_MS),
    staleMs: positiveInt(env.CCDX_TOKEN_LOCK_STALE_MS, DEFAULT_TOKEN_LOCK_STALE_MS),
  };
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
    env.XDG_CONFIG_HOME ? expandHome(env.XDG_CONFIG_HOME, home) : path.join(home, ".config"),
  ].filter(Boolean);
  return [...new Set(roots)];
}

function addAuthJsonSource(sources, seen, filePath) {
  if (seen.has(filePath)) return;
  if (!fs.existsSync(filePath)) return;
  seen.add(filePath);
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

    for (const appDirent of appDirs) {
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

      for (const profileDirent of profileDirs) {
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
      if (seen.has(filePath)) return false;
      seen.add(filePath);
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
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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
  sources.push(...localAuthJsonSources(home, env));
  return sources;
}

export function sourceDescription(source) {
  if (!source) return "unknown source";
  if (source.type === "env") return source.name;
  if (source.type === "token-file") return `${source.name} (${source.path})`;
  if (source.type === "auth-json") return `local auth file (${source.path})`;
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

export function readGithubTokenSource(source) {
  if (source?.type === "env") return source.token || "";
  if (source?.type === "token-file") return fs.readFileSync(source.path, "utf8").trim();
  if (source?.type === "auth-json") {
    const json = readSmallJson(source.path);
    if (!looksLikeCopilotAuthJson(json)) return "";
    return extractGithubTokenFromAuthJson(json);
  }
  return "";
}

function readSavedGithubToken(home = os.homedir()) {
  const filePath = githubTokenPath(home);
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8").trim();
}

function normalizeGithubIdentity(identity) {
  if (!identity || typeof identity !== "object") return null;
  const login = typeof identity.login === "string" ? identity.login.trim() : "";
  const id = identity.id === undefined || identity.id === null ? "" : String(identity.id).trim();
  if (!login && !id) return null;
  return { login, id };
}

function tokenFingerprint(token) {
  return createHash("sha256").update(String(token || "")).digest("hex").slice(0, 24);
}

export function readGithubTokenMetadata(home = os.homedir(), token = null) {
  try {
    const parsed = JSON.parse(fs.readFileSync(githubTokenMetadataPath(home), "utf8"));
    if (token && parsed.token_fingerprint !== tokenFingerprint(token)) return null;
    const identity = normalizeGithubIdentity(parsed);
    return identity ? { ...identity, token_fingerprint: parsed.token_fingerprint || "" } : null;
  } catch {
    return null;
  }
}

function githubIdentityMatches(identity, expected) {
  const actual = normalizeGithubIdentity(identity);
  const wanted = normalizeGithubIdentity(expected);
  if (!wanted) return true;
  if (!actual) return false;
  if (wanted.id && actual.id) return wanted.id === actual.id;
  return Boolean(wanted.login && actual.login && wanted.login.toLowerCase() === actual.login.toLowerCase());
}

function expectedGithubIdentity(home, env, token) {
  const configuredLogin = String(env.CCDX_GITHUB_LOGIN || "").trim();
  if (configuredLogin) return { login: configuredLogin };
  return token ? readGithubTokenMetadata(home, token) : null;
}

export async function fetchGithubIdentity(token, { fetchImpl = fetch, signal } = {}) {
  if (typeof token !== "string" || !token.trim()) return { ok: false, reason: "empty_token" };
  try {
    const resp = await fetchImpl(`${GITHUB_API}/user`, {
      headers: { Authorization: `token ${token.trim()}`, Accept: "application/json" },
      signal,
    });
    if (!resp.ok) return { ok: false, status: resp.status, reason: "github_user_failed" };
    const data = await resp.json();
    const identity = normalizeGithubIdentity(data);
    return identity ? { ok: true, ...identity } : { ok: false, reason: "github_identity_missing" };
  } catch (error) {
    return { ok: false, transient: true, reason: "github_user_request_failed", error };
  }
}

export async function ensureGithubTokenMetadata(token, {
  home = os.homedir(),
  fetchImpl = fetch,
  signal,
} = {}) {
  const existing = readGithubTokenMetadata(home, token);
  if (existing) return existing;
  const identity = await fetchGithubIdentity(token, { fetchImpl, signal });
  if (!identity.ok) return null;
  writeGithubTokenMetadata(identity, home, token);
  return normalizeGithubIdentity(identity);
}

export async function validateGithubToken(token, {
  fetchImpl = fetch,
  signal,
} = {}) {
  if (typeof token !== "string" || !token.trim()) {
    return { ok: false, reason: "empty_token" };
  }

  const headers = { Authorization: `token ${token.trim()}`, Accept: "application/json" };
  let userResp;
  try {
    userResp = await fetchImpl(`${GITHUB_API}/user`, { headers, signal });
  } catch (e) {
    return { ok: false, transient: true, reason: "github_user_request_failed", error: e };
  }

  if (!userResp.ok) {
    return {
      ok: false,
      status: userResp.status,
      reason: userResp.status === 401 || userResp.status === 403 ? "github_token_invalid" : "github_user_failed",
    };
  }

  let userData = {};
  try {
    userData = await userResp.json();
  } catch {}
  const login = typeof userData.login === "string" ? userData.login : "";
  const id = userData.id === undefined || userData.id === null ? "" : String(userData.id);

  let copilotResp;
  try {
    copilotResp = await fetchImpl(COPILOT_TOKEN_URL, { headers, signal });
  } catch (e) {
    return { ok: false, transient: true, reason: "copilot_token_request_failed", login, error: e };
  }

  if (!copilotResp.ok) {
    return {
      ok: false,
      status: copilotResp.status,
      reason: copilotResp.status === 401 || copilotResp.status === 403 ? "copilot_access_denied" : "copilot_token_failed",
      login,
    };
  }

  let copilotTokenData = {};
  try {
    copilotTokenData = await copilotResp.json();
  } catch (e) {
    return { ok: false, reason: "copilot_token_parse_failed", login, error: e };
  }

  if (!copilotTokenData.token) {
    return { ok: false, reason: "copilot_token_missing", login };
  }

  return { ok: true, login, id, copilotTokenData };
}

export async function discoverGithubToken({
  home = os.homedir(),
  env = process.env,
  fetchImpl = fetch,
  signal,
  excludeTokens = [],
  expectedIdentity,
  strictExpectedIdentity = false,
} = {}) {
  const excluded = new Set(excludeTokens);
  const seen = new Set(excluded);
  const failures = [];
  const candidates = [];

  for (const source of githubTokenSources({ home, env })) {
    let token = "";
    try {
      token = readGithubTokenSource(source).trim();
    } catch (e) {
      failures.push({ source, reason: "read_failed", error: e });
      continue;
    }

    if (!token || seen.has(token)) continue;
    seen.add(token);

    const validation = await validateGithubToken(token, { fetchImpl, signal });
    if (validation.ok) {
      const candidate = { ok: true, token, source, validation };
      const explicitSource = source.type === "env" || source.type === "token-file";
      if (expectedIdentity && (strictExpectedIdentity || !explicitSource)) {
        if (githubIdentityMatches(validation, expectedIdentity)) return candidate;
        failures.push({ source, validation, reason: "github_account_mismatch" });
        continue;
      }
      if (explicitSource) return candidate;
      candidates.push(candidate);
      continue;
    }
    failures.push({ source, validation });
  }

  if (candidates.length) {
    const identities = new Set(candidates.map(({ validation, token }) => {
      if (validation.id) return `id:${validation.id}`;
      if (validation.login) return `login:${validation.login.toLowerCase()}`;
      return `token:${token}`;
    }));
    if (identities.size === 1) return candidates[0];
    return {
      ok: false,
      ambiguous: true,
      candidates: candidates.map(({ source, validation }) => ({
        source,
        login: validation.login,
        id: validation.id,
      })),
      failures,
    };
  }

  return { ok: false, failures };
}

export async function importDiscoveredGithubToken({
  home = os.homedir(),
  env = process.env,
  fetchImpl = fetch,
  signal,
  excludeTokens = [],
  log = console.log,
  lock = true,
  validateSavedToken = false,
} = {}) {
  const run = async () => {
    const excluded = new Set(excludeTokens);
    const savedToken = readSavedGithubToken(home);
    const expectedIdentity = expectedGithubIdentity(home, env, savedToken);
    const strictExpectedIdentity = Boolean(String(env.CCDX_GITHUB_LOGIN || "").trim());
    if (savedToken && !excluded.has(savedToken)) {
      if (!validateSavedToken) {
        return { ok: true, token: savedToken, source: { type: "saved-token" }, imported: false };
      }
      const validation = await validateGithubToken(savedToken, { fetchImpl, signal });
      if (validation.ok && githubIdentityMatches(validation, expectedIdentity)) {
        writeGithubTokenMetadata(validation, home, savedToken);
        return { ok: true, token: savedToken, source: { type: "saved-token" }, validation, imported: false };
      }
    }

    const discovered = await discoverGithubToken({
      home,
      env,
      fetchImpl,
      signal,
      excludeTokens,
      expectedIdentity,
      strictExpectedIdentity,
    });
    if (discovered.ambiguous) {
      const logins = [...new Set(discovered.candidates.map((candidate) => candidate.login || candidate.id || "unknown"))];
      throw new Error(`Multiple GitHub Copilot accounts were found (${logins.join(", ")}). Set CCDX_GITHUB_LOGIN or CCDX_GITHUB_TOKEN_PATH to select one explicitly.`);
    }
    if (!discovered.ok) return null;
    writeToken(discovered.token, home, discovered.validation);
    const login = discovered.validation.login ? ` for ${discovered.validation.login}` : "";
    log(status("ok", `Imported GitHub token from ${sourceDescription(discovered.source)}${login}`));
    return { ...discovered, imported: true };
  };

  if (!lock) return run();
  return withFileLock(githubTokenLockPath(home), run, tokenLockOptions(env));
}

// On macOS, copy the user code and open the verification page. Fail quietly.
function openAndCopy(userCode, verificationUri) {
  if (process.platform !== "darwin") return;
  try {
    const pb = spawn("pbcopy");
    pb.on("error", () => {});
    pb.stdin.on("error", () => {});
    pb.on("close", (code) => {
      if (code === 0) console.log(status("ok", "Device code copied to the clipboard"));
    });
    pb.stdin.write(userCode);
    pb.stdin.end();
  } catch {}
  try {
    const op = spawn("open", [verificationUri], { detached: true, stdio: "ignore" });
    op.on("error", () => {});
  } catch {}
}

export async function ensureAuth({
  home = os.homedir(),
  env = process.env,
  fetchImpl = fetch,
  signal,
  log = console.log,
  openAndCopyFn = openAndCopy,
} = {}) {
  const GITHUB_TOKEN_PATH = githubTokenPath(home);
  if (fs.existsSync(GITHUB_TOKEN_PATH)) {
    const existing = fs.readFileSync(GITHUB_TOKEN_PATH, "utf8").trim();
    if (existing) {
      log(status("ok", "GitHub token found"));
      return;
    }
    log(status("warn", "GitHub token file is empty"));
  }

  await withFileLock(githubTokenLockPath(home), async () => {
    const savedToken = readSavedGithubToken(home);
    if (savedToken) {
      log(status("ok", "GitHub token found"));
      return;
    }

    const imported = await importDiscoveredGithubToken({ home, env, fetchImpl, signal, log, lock: false });
    if (imported) return;

    log(status("wait", "No usable GitHub token found. Starting device login..."));

    // Request a device code while holding the auth lock so concurrent starts do not
    // trigger multiple browser/device-flow sessions for the same local token.
    const codeResp = await fetchImpl("https://github.com/login/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
      signal,
    });
    if (!codeResp.ok) throw new Error(`device code request failed: ${codeResp.status}`);
    const { device_code, user_code, verification_uri, interval } = await codeResp.json();

    // Prompt the user.
    log(`\n${status("info", `Open ${verification_uri}`)}\n${status("info", `Enter code: ${user_code}`)}\n`);
    openAndCopyFn(user_code, verification_uri);

    // Poll until GitHub completes the device flow.
    let waitMs = (interval || 5) * 1000;
    while (true) {
      await sleep(waitMs);
      const pollResp = await fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal,
      });
      if (!pollResp.ok) {
        // Treat transient network/server errors as pending and retry.
        continue;
      }
      const data = await pollResp.json();
      const r = interpretPoll(data);
      if (r.state === "done") {
        const identity = await fetchGithubIdentity(r.token, { fetchImpl, signal });
        writeToken(r.token, home, identity.ok ? identity : null);
        log(status("ok", "Login successful"));
        return;
      }
      if (r.state === "slow") { waitMs += 5000; continue; }
      if (r.state === "fail") throw new Error(`Login failed: ${r.error}`);
      // wait: continue polling.
    }
  }, tokenLockOptions(env));
}

export function writeGithubTokenMetadata(identity, home = os.homedir(), token = "") {
  const normalized = normalizeGithubIdentity(identity);
  if (!normalized) return false;
  const filePath = githubTokenMetadataPath(home);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify({
    ...normalized,
    token_fingerprint: tokenFingerprint(token),
    updated_at: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return true;
}

export function writeToken(token, home = os.homedir(), identity = null) {
  const GITHUB_TOKEN_PATH = githubTokenPath(home);
  fs.mkdirSync(path.dirname(GITHUB_TOKEN_PATH), { recursive: true });
  fs.writeFileSync(GITHUB_TOKEN_PATH, token, { mode: 0o600 });
  fs.chmodSync(GITHUB_TOKEN_PATH, 0o600);
  if (normalizeGithubIdentity(identity)) {
    writeGithubTokenMetadata(identity, home, token);
  } else {
    try { fs.unlinkSync(githubTokenMetadataPath(home)); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  }
}
