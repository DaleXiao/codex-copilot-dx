import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { githubIdentityMatchesExpected, normalizeGithubIdentity } from "./github-identity.mjs";
import { parseSafePositiveInteger, parseTimerMs, RUNTIME_DEFAULTS } from "./runtime-config.mjs";
import { status } from "./status.mjs";
import { withFileLock } from "./lock.mjs";
import { githubTokenPath, githubTokenLockPath, readGithubTokenMetadata, readSavedGithubToken,
  githubTokenSources, readGithubTokenSource, sourceDescription, writeGithubTokenMetadata, writeToken } from "./auth-credentials.mjs";
import { requestGithubDeviceCode, pollGithubDeviceFlow, awaitWithSignal, abortError, cancelResponseBody,
  sleep, DEFAULT_DEVICE_CODE_TIMEOUT_MS } from "./auth-device-flow.mjs";
export { githubTokenPath, githubTokenLockPath, githubTokenMetadataPath, githubReauthMessage,
  managedGithubTokenPath, legacyGithubTokenPath,
  githubTokenSources, sourceDescription, extractGithubTokenFromAuthJson, readGithubTokenSource,
  readGithubTokenMetadata, writeGithubTokenMetadata, writeToken } from "./auth-credentials.mjs";
export { interpretPoll, requestGithubDeviceCode, pollGithubDeviceFlow } from "./auth-device-flow.mjs";

const GITHUB_API = "https://api.github.com";
const COPILOT_TOKEN_URL = `${GITHUB_API}/copilot_internal/v2/token`;
const DEFAULT_GITHUB_IDENTITY_TIMEOUT_MS = 30 * 1000;

function tokenLockOptions(env = process.env) {
  return {
    timeoutMs: parseSafePositiveInteger(env.CCDX_TOKEN_LOCK_TIMEOUT_MS, RUNTIME_DEFAULTS.tokenLockTimeoutMs),
    staleMs: parseSafePositiveInteger(env.CCDX_TOKEN_LOCK_STALE_MS, RUNTIME_DEFAULTS.tokenLockStaleMs),
  };
}

function expectedGithubIdentity(home, env, token) {
  const configuredLogin = String(env.CCDX_GITHUB_LOGIN || "").trim();
  if (configuredLogin) return { login: configuredLogin };
  return token ? readGithubTokenMetadata(home, token) : null;
}

function githubIdentityTimeoutError(timeoutMs) {
  const error = new Error(`GitHub identity request timed out after ${timeoutMs}ms`);
  error.code = "CCDX_GITHUB_IDENTITY_TIMEOUT";
  return error;
}

export async function fetchGithubIdentity(token, {
  fetchImpl = fetch,
  signal,
  timeoutMs = DEFAULT_GITHUB_IDENTITY_TIMEOUT_MS,
} = {}) {
  if (typeof token !== "string" || !token.trim()) return { ok: false, reason: "empty_token" };
  const deadlineMs = parseTimerMs(timeoutMs, DEFAULT_GITHUB_IDENTITY_TIMEOUT_MS);
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (signal?.aborted) onCallerAbort();
  const timer = setTimeout(() => controller.abort(githubIdentityTimeoutError(deadlineMs)), deadlineMs);
  let resp;
  try {
    resp = await awaitWithSignal(() => fetchImpl(`${GITHUB_API}/user`, {
      headers: { Authorization: `token ${token.trim()}`, Accept: "application/json" },
      signal: controller.signal,
    }), controller.signal);
    if (!resp.ok) {
      cancelResponseBody(resp);
      return { ok: false, status: resp.status, reason: "github_user_failed" };
    }
    const data = await awaitWithSignal(() => resp.json(), controller.signal);
    const identity = normalizeGithubIdentity(data);
    return identity ? { ok: true, ...identity } : { ok: false, reason: "github_identity_missing" };
  } catch (error) {
    cancelResponseBody(resp);
    const timedOut = controller.signal.aborted && !signal?.aborted
      && controller.signal.reason?.code === "CCDX_GITHUB_IDENTITY_TIMEOUT";
    return {
      ok: false,
      transient: true,
      reason: timedOut ? "github_user_timeout" : "github_user_request_failed",
      error,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
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
  timeoutMs = 10000,
} = {}) {
  const deadline = AbortSignal.timeout(parseTimerMs(timeoutMs, 10000));
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    return await awaitWithSignal(() => validateGithubTokenRequest(token, { fetchImpl, signal: combined }), combined);
  } catch {
    return { ok: false, transient: true, reason: signal?.aborted ? "validation_cancelled" : "validation_timeout" };
  }
}

async function validateGithubTokenRequest(token, { fetchImpl, signal }) {
  if (typeof token !== "string" || !token.trim()) {
    return { ok: false, reason: "empty_token" };
  }

  const headers = { Authorization: `token ${token.trim()}`, Accept: "application/json" };
  let userResp;
  try {
    userResp = await awaitWithSignal(() => fetchImpl(`${GITHUB_API}/user`, { headers, signal, redirect: "error" }), signal);
  } catch (e) {
    return { ok: false, transient: true, reason: "github_user_request_failed", error: e };
  }

  if (!userResp.ok) {
    cancelResponseBody(userResp);
    return {
      ok: false,
      status: userResp.status,
      accessDenied: userResp.status === 403,
      transient: userResp.status === 429 || userResp.status >= 500 || userResp.headers?.get?.("x-ratelimit-remaining") === "0",
      reason: userResp.status === 401 ? "github_token_invalid" : userResp.status === 403 ? "github_access_denied" : "github_user_failed",
    };
  }

  let userData = {};
  try {
    userData = await awaitWithSignal(() => userResp.json(), signal);
  } catch {}
  const login = typeof userData.login === "string" ? userData.login : "";
  const id = userData.id === undefined || userData.id === null ? "" : String(userData.id);
  if (!login && !id) return { ok: false, transient: true, reason: "github_identity_missing" };

  let copilotResp;
  try {
    copilotResp = await awaitWithSignal(() => fetchImpl(COPILOT_TOKEN_URL, { headers, signal, redirect: "error" }), signal);
  } catch (e) {
    return { ok: false, transient: true, reason: "copilot_token_request_failed", login, error: e };
  }

  if (!copilotResp.ok) {
    cancelResponseBody(copilotResp);
    return {
      ok: false,
      status: copilotResp.status,
      accessDenied: copilotResp.status === 403,
      transient: copilotResp.status === 429 || copilotResp.status >= 500,
      reason: copilotResp.status === 401 || copilotResp.status === 403 ? "copilot_access_denied" : "copilot_token_failed",
      login,
    };
  }

  let copilotTokenData = {};
  try {
    copilotTokenData = await awaitWithSignal(() => copilotResp.json(), signal);
  } catch (e) {
    return { ok: false, transient: true, reason: "copilot_token_parse_failed", login, error: e };
  }

  if (typeof copilotTokenData.token !== "string" || !copilotTokenData.token.trim()) {
    return { ok: false, transient: true, reason: "copilot_token_missing", login };
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
  timeoutMs = 12000,
  maxCandidates = 24,
  sources = githubTokenSources({ home, env }),
  readSource = readGithubTokenSource,
} = {}) {
  const deadline = AbortSignal.timeout(parseTimerMs(timeoutMs, 12000));
  const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const excluded = new Set(excludeTokens);
  const seen = new Set(excluded);
  const failures = [];
  const candidates = [];

  for (const source of sources) {
    if (boundedSignal.aborted || seen.size - excluded.size >= maxCandidates) {
      return { ok: false, incomplete: true, transient: true, failures };
    }
    let token = "";
    try {
      token = readSource(source, { env }).trim();
    } catch (e) {
      // Child-process errors may carry stdout containing a credential.
      failures.push({ source: { type: source.type, path: source.path }, reason: "read_failed" });
      continue;
    }

    if (!token || seen.has(token)) continue;
    seen.add(token);

    const validation = await validateGithubToken(token, { fetchImpl, signal: boundedSignal, timeoutMs: 4000 });
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

  if (sources.incomplete || boundedSignal.aborted || failures.some(item => item.validation?.transient)) {
    return { ok: false, incomplete: true, transient: true, failures };
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

  if (failures.some(item => item.validation?.accessDenied)) {
    return { ok: false, accessDenied: true, failures };
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
      if (validation.transient) throw new Error("GitHub access could not be checked. The saved credential was preserved; check your network and retry.");
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
    if (discovered.accessDenied) throw new Error("GitHub or Copilot denied access to an existing credential. Check account access and network policy; credentials were preserved and no new login was started.");
    if (discovered.transient) throw new Error("Local GitHub credentials could not be fully checked. Check network access and retry; no new login was started.");
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
  deviceCodeTimeoutMs = DEFAULT_DEVICE_CODE_TIMEOUT_MS,
  githubIdentityTimeoutMs = DEFAULT_GITHUB_IDENTITY_TIMEOUT_MS,
  sleepImpl = sleep,
  now = Date.now,
} = {}) {
  const GITHUB_TOKEN_PATH = githubTokenPath(home);
  if (fs.existsSync(GITHUB_TOKEN_PATH)) {
    const existing = readSavedGithubToken(home);
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
    const codeResult = await requestGithubDeviceCode({
      fetchImpl,
      signal,
      timeoutMs: deviceCodeTimeoutMs,
    });
    const codeResp = codeResult.response;
    if (!codeResp.ok) {
      throw new Error(`device code request failed: ${codeResp.status}`);
    }
    if (codeResult.jsonError) throw codeResult.jsonError;
    const {
      device_code,
      user_code,
      verification_uri,
      interval,
      expires_in,
    } = codeResult.data;

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
      const identity = await fetchGithubIdentity(result.token, {
        fetchImpl,
        signal,
        timeoutMs: githubIdentityTimeoutMs,
      });
      writeToken(result.token, home, identity.ok ? identity : null);
      log(status("ok", "Login successful"));
      return;
    }
    if (result.state === "expired") throw new Error("Login failed: device code expired");
    throw new Error(`Login failed: ${result.error}`);
  }, tokenLockOptions(env));
}
