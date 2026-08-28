import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { atomicWriteFilePairSync, atomicWriteFileSync } from "./atomic-file.mjs";
import {
  githubIdentityMatchesExpected,
  githubTokenFingerprint,
  normalizeGithubIdentity,
} from "./github-identity.mjs";
import { parsePositiveInteger, RUNTIME_DEFAULTS } from "./runtime-config.mjs";
import { status } from "./status.mjs";
import { withFileLock } from "./lock.mjs";

const CLIENT_ID = "Iv1.b507a08c87ecfe98"; // Public GitHub Copilot client ID.
const SCOPE = "read:user";
const GITHUB_API = "https://api.github.com";
const COPILOT_TOKEN_URL = `${GITHUB_API}/copilot_internal/v2/token`;
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEFAULT_DEVICE_INTERVAL_SECONDS = 5;
const DEFAULT_DEVICE_EXPIRES_SECONDS = 900;
const DISABLE_TOKEN_DISCOVERY_VALUES = new Set(["1", "true", "yes"]);
const MAX_AUTH_JSON_BYTES = 1024 * 1024;

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
Delete the saved GitHub token, then run ccdx again to log in:
  rm '${tokenPath}'
  ccdx`;
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

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function sleep(ms, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function consumeResponseBody(response) {
  try {
    await response.text();
  } catch {}
}

export async function pollGithubDeviceFlow({
  deviceCode,
  interval,
  expiresIn,
  fetchImpl = fetch,
  signal,
  sleepImpl = sleep,
  now = Date.now,
} = {}) {
  const parsedInterval = Number(interval);
  const parsedExpires = Number(expiresIn);
  let waitMs = (Number.isFinite(parsedInterval) && parsedInterval > 0
    ? parsedInterval
    : DEFAULT_DEVICE_INTERVAL_SECONDS) * 1000;
  const expiresMs = (Number.isFinite(parsedExpires) && parsedExpires > 0
    ? parsedExpires
    : DEFAULT_DEVICE_EXPIRES_SECONDS) * 1000;
  const deadline = now() + expiresMs;

  while (true) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return { state: "expired" };
    await sleepImpl(Math.min(waitMs, remainingMs), { signal });
    if (signal?.aborted) throw abortError(signal);
    if (now() >= deadline) return { state: "expired" };

    const pollController = new AbortController();
    let deadlineExpired = false;
    const onCallerAbort = () => pollController.abort(signal.reason);
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (signal?.aborted) onCallerAbort();
    const deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      pollController.abort();
    }, Math.max(1, deadline - now()));
    let result;
    try {
      const pollResponse = await fetchImpl(ACCESS_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal: pollController.signal,
      });
      if (now() >= deadline) {
        await consumeResponseBody(pollResponse);
        return { state: "expired" };
      }
      if (!pollResponse.ok) {
        await consumeResponseBody(pollResponse);
        if (now() >= deadline) return { state: "expired" };
        continue;
      }
      result = interpretPoll(await pollResponse.json());
      if (now() >= deadline) return { state: "expired" };
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (deadlineExpired || now() >= deadline) return { state: "expired" };
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
    if (result.state === "slow") {
      waitMs += 5000;
      continue;
    }
    if (result.state !== "wait") return result;
  }
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

function tokenLockOptions(env = process.env) {
  return {
    timeoutMs: parsePositiveInteger(env.CCDX_TOKEN_LOCK_TIMEOUT_MS, RUNTIME_DEFAULTS.tokenLockTimeoutMs),
    staleMs: parsePositiveInteger(env.CCDX_TOKEN_LOCK_STALE_MS, RUNTIME_DEFAULTS.tokenLockStaleMs),
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

export function readGithubTokenMetadata(home = os.homedir(), token = null) {
  try {
    const parsed = JSON.parse(fs.readFileSync(githubTokenMetadataPath(home), "utf8"));
    if (token && parsed.token_fingerprint !== githubTokenFingerprint(token)) return null;
    const identity = normalizeGithubIdentity(parsed);
    return identity ? { ...identity, token_fingerprint: parsed.token_fingerprint || "" } : null;
  } catch {
    return null;
  }
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
  excludeIdentities = [],
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
      if (excludeIdentities.some((identity) => githubIdentityMatchesExpected(validation, identity))) {
        failures.push({ source, validation, reason: "github_account_excluded" });
        continue;
      }
      const candidate = { ok: true, token, source, validation };
      const explicitSource = source.type === "env" || source.type === "token-file";
      if (expectedIdentity && (strictExpectedIdentity || !explicitSource)) {
        if (githubIdentityMatchesExpected(validation, expectedIdentity)) return candidate;
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
      if (validation.ok && githubIdentityMatchesExpected(validation, expectedIdentity)) {
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
  sleepImpl = sleep,
  now = Date.now,
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
    if (!codeResp.ok) {
      await consumeResponseBody(codeResp);
      throw new Error(`device code request failed: ${codeResp.status}`);
    }
    const {
      device_code,
      user_code,
      verification_uri,
      interval,
      expires_in,
    } = await codeResp.json();

    // Prompt the user.
    log(`\n${status("info", `Open ${verification_uri}`)}\n${status("info", `Enter code: ${user_code}`)}\n`);
    openAndCopyFn(user_code, verification_uri);

    const result = await pollGithubDeviceFlow({
      deviceCode: device_code,
      interval,
      expiresIn: expires_in,
      fetchImpl,
      signal,
      sleepImpl,
      now,
    });
    if (result.state === "done") {
      const identity = await fetchGithubIdentity(result.token, { fetchImpl, signal });
      writeToken(result.token, home, identity.ok ? identity : null);
      log(status("ok", "Login successful"));
      return;
    }
    if (result.state === "expired") throw new Error("Login failed: device code expired");
    throw new Error(`Login failed: ${result.error}`);
  }, tokenLockOptions(env));
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
} = {}) {
  const GITHUB_TOKEN_PATH = githubTokenPath(home);
  const directory = path.dirname(GITHUB_TOKEN_PATH);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  atomicWriteFilePairSync(
    GITHUB_TOKEN_PATH,
    token,
    githubTokenMetadataPath(home),
    githubTokenMetadataData(identity, token, now),
    { mode: 0o600, writeFile, unlinkFile },
  );
}
