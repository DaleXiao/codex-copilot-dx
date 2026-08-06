import fs from "node:fs";
import os from "node:os";
import {
  fetchGithubIdentity,
  githubReauthMessage,
  githubTokenPath,
  importDiscoveredGithubToken,
  readGithubTokenMetadata,
  writeGithubTokenMetadata,
} from "./auth.mjs";
import {
  githubIdentitiesEqual,
  githubIdentityLabel,
  githubTokenFingerprint,
  normalizeGithubIdentity,
} from "./github-identity.mjs";
import { status } from "./status.mjs";

const GITHUB_API = "https://api.github.com";

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function isAbortError(error, signal) {
  return signal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function waitForSingleflight(flight, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  flight.waiters += 1;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (handler, value) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      flight.waiters -= 1;
      if (!flight.settled && flight.waiters === 0) flight.controller.abort();
      handler(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    flight.promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function refreshError(message, { statusCode, transient = false } = {}) {
  const error = new Error(message);
  if (statusCode) error.statusCode = statusCode;
  if (transient) error.transient = true;
  return error;
}

function copilotProfileLabel(profile) {
  if (profile === "codex") return "Copilot";
  const name = String(profile || "profile");
  return `${name[0].toUpperCase()}${name.slice(1)} Copilot`;
}

export function createCopilotTokenSession({
  profile = "codex",
  home: fixedHome,
  tokenPath: configuredTokenPath,
  readGithubCredentials,
  allowTokenDiscovery = profile === "codex" && configuredTokenPath === undefined,
  readGithubIdentity: readProfileGithubIdentity,
  writeGithubIdentity: writeProfileGithubIdentity,
  reauthMessage,
  tokenFetchImpl = fetch,
  defaultApiBase,
  parseApiBase,
  fetchCopilotUpstream,
} = {}) {
  const hasIsolatedTokenPath = typeof configuredTokenPath === "function"
    || (typeof configuredTokenPath === "string" && configuredTokenPath.trim().length > 0);
  if (profile !== "codex" && !hasIsolatedTokenPath && typeof readGithubCredentials !== "function") {
    throw new Error(`Authentication profile ${profile} requires an isolated tokenPath or readGithubCredentials loader`);
  }
  if (profile !== "codex" && allowTokenDiscovery) {
    throw new Error(`Authentication profile ${profile} cannot enable legacy token discovery`);
  }

  let apiBase = defaultApiBase;
  let copilotToken = null;
  let copilotTokenExpiry = 0;
  let refreshFlight = null;
  let tokenSourceKey = null;
  let githubFingerprint = "";
  let githubIdentity = null;
  let refreshRetryAt = 0;

  const resolveHome = (home) => fixedHome || home || os.homedir();
  const usesDefaultTokenStore = configuredTokenPath === undefined && typeof readGithubCredentials !== "function";
  const resolveTokenPath = (home) => {
    if (typeof configuredTokenPath === "function") return configuredTokenPath(resolveHome(home));
    return configuredTokenPath || githubTokenPath(resolveHome(home));
  };
  const formatReauth = (reason, home) => {
    if (typeof reauthMessage === "function") {
      return reauthMessage(reason, {
        profile,
        home: resolveHome(home),
        tokenPath: resolveTokenPath(home),
      });
    }
    if (usesDefaultTokenStore) return githubReauthMessage(reason, resolveHome(home));
    return `${reason}\nRun \`ccdx auth login ${profile} --reauth\`, then restart ccdx.`;
  };

  async function loadCredentials(home) {
    const resolvedHome = resolveHome(home);
    const tokenFile = resolveTokenPath(resolvedHome);
    if (typeof readGithubCredentials === "function") {
      const credentials = await readGithubCredentials({
        profile,
        home: resolvedHome,
        tokenPath: tokenFile,
      });
      if (!credentials || credentials.valid === false || !String(credentials.token || "").trim()) {
        const reason = credentials?.reason ? ` (${credentials.reason})` : "";
        throw refreshError(formatReauth(`${profile} authentication profile is invalid${reason}.`, resolvedHome), {
          statusCode: 401,
        });
      }
      return {
        token: String(credentials.token).trim(),
        identity: normalizeGithubIdentity(credentials.identity),
        sourceKey: credentials.paths?.tokenPath || tokenFile,
      };
    }
    if (!fs.existsSync(tokenFile)) {
      const message = usesDefaultTokenStore
        ? "GitHub token not found. Run ccdx again to log in."
        : formatReauth(`GitHub token for ${profile} profile was not found.`, resolvedHome);
      throw refreshError(message, { statusCode: 401 });
    }
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    if (!token) {
      const reason = profile === "codex" ? "GitHub token file is empty." : `GitHub token for ${profile} profile is empty.`;
      throw refreshError(formatReauth(reason, resolvedHome), { statusCode: 401 });
    }
    return { token, identity: null, sourceKey: tokenFile };
  }

  async function identityForToken(token, credentialsIdentity, { home, fetchImpl, signal }) {
    if (credentialsIdentity) return credentialsIdentity;
    let cached = null;
    if (typeof readProfileGithubIdentity === "function") {
      cached = await readProfileGithubIdentity(token, {
        profile,
        home: resolveHome(home),
        tokenPath: resolveTokenPath(home),
      });
    } else if (usesDefaultTokenStore) {
      cached = readGithubTokenMetadata(resolveHome(home), token);
    }
    if (cached) return cached;
    const identity = await fetchGithubIdentity(token, { fetchImpl, signal });
    return identity.ok ? identity : null;
  }

  function persistIdentity(identity, home, token) {
    if (!identity) return;
    if (typeof writeProfileGithubIdentity === "function") {
      writeProfileGithubIdentity(identity, {
        profile,
        home: resolveHome(home),
        token,
        tokenPath: resolveTokenPath(home),
      });
    } else if (usesDefaultTokenStore) {
      writeGithubTokenMetadata(identity, resolveHome(home), token);
    }
  }

  function cacheTokenData(data, {
    sourceKey,
    githubToken,
    identity,
    allowAccountSwitch = false,
  }) {
    if (!data.token) throw new Error("Copilot token response missing token field");
    const fingerprint = githubTokenFingerprint(githubToken);
    const normalizedIdentity = normalizeGithubIdentity(identity);
    const tokenChanged = Boolean(githubFingerprint && fingerprint !== githubFingerprint);
    if (!allowAccountSwitch && githubIdentity && normalizedIdentity
      && !githubIdentitiesEqual(githubIdentity, normalizedIdentity)) {
      const profileLabel = profile === "codex" ? "" : `${profile} `;
      throw new Error(`Refusing to switch ${profileLabel}GitHub Copilot account from ${githubIdentityLabel(githubIdentity)} to ${githubIdentityLabel(normalizedIdentity)} while the adapter is running. Restart ccdx to switch accounts intentionally.`);
    }
    if (!allowAccountSwitch && githubIdentity && tokenChanged && !normalizedIdentity) {
      const profileLabel = profile === "codex" ? "" : `${profile} `;
      const error = new Error(`The saved ${profileLabel}GitHub token changed, but its account could not be verified. Keeping the running adapter bound to the existing GitHub account.`);
      error.transient = true;
      throw error;
    }
    copilotToken = data.token;
    apiBase = parseApiBase(data);
    copilotTokenExpiry = typeof data.expires_at === "number"
      ? data.expires_at * 1000
      : Date.now() + 25 * 60 * 1000;
    tokenSourceKey = sourceKey;
    githubFingerprint = fingerprint;
    if (normalizedIdentity) githubIdentity = normalizedIdentity;
    refreshRetryAt = 0;
    console.log(status("ok", `${copilotProfileLabel(profile)} token refreshed`));
    return copilotToken;
  }

  async function refresh({
    signal,
    home,
    env = process.env,
    fetchImpl = tokenFetchImpl,
    tokenRetryOptions,
  } = {}) {
    const resolvedHome = resolveHome(home);
    const credentials = await loadCredentials(resolvedHome);
    let response;
    try {
      response = await fetchCopilotUpstream(`${GITHUB_API}/copilot_internal/v2/token`, {
        headers: { Authorization: `token ${credentials.token}`, Accept: "application/json" },
        signal,
      }, { fetchImpl, ...tokenRetryOptions });
    } catch (error) {
      if (!isAbortError(error, signal)) error.transient = true;
      throw error;
    }
    if (!response.ok) {
      if ((response.status === 401 || response.status === 403) && allowTokenDiscovery) {
        const imported = await importDiscoveredGithubToken({
          home: resolvedHome,
          env,
          fetchImpl,
          signal,
          excludeTokens: [credentials.token],
          validateSavedToken: true,
        });
        if (imported?.validation?.copilotTokenData?.token) {
          const explicit = imported.source?.type === "env" || imported.source?.type === "token-file";
          return cacheTokenData(imported.validation.copilotTokenData, {
            sourceKey: credentials.sourceKey,
            githubToken: imported.token,
            identity: imported.validation,
            allowAccountSwitch: explicit,
          });
        }
      }
      if (response.status === 401 || response.status === 403) {
        const prefix = profile === "codex" ? "Failed to get Copilot token" : `Failed to get Copilot token for ${profile} profile`;
        throw refreshError(formatReauth(`${prefix}: ${response.status}. The saved GitHub token may be expired, revoked, or missing Copilot access.`, resolvedHome), {
          statusCode: response.status,
        });
      }
      const prefix = profile === "codex" ? "Failed to get Copilot token" : `Failed to get Copilot token for ${profile} profile`;
      throw refreshError(`${prefix}: ${response.status}`, {
        statusCode: response.status,
        transient: response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
      });
    }
    const data = await response.json();
    const identity = await identityForToken(credentials.token, credentials.identity, {
      home: resolvedHome,
      fetchImpl,
      signal,
    });
    const token = cacheTokenData(data, {
      sourceKey: credentials.sourceKey,
      githubToken: credentials.token,
      identity,
    });
    persistIdentity(identity, resolvedHome, credentials.token);
    return token;
  }

  function canUseCached(sourceKey, now = Date.now(), allowCurrent = false) {
    return Boolean(copilotToken
      && (tokenSourceKey === sourceKey || allowCurrent)
      && now < copilotTokenExpiry);
  }

  function getToken(options = {}) {
    const home = resolveHome(options.home);
    const sourceKey = resolveTokenPath(home);
    const now = Date.now();
    const allowCurrent = options.home === undefined || fixedHome !== undefined;
    if (canUseCached(sourceKey, now, allowCurrent) && now < copilotTokenExpiry - 60000) return Promise.resolve(copilotToken);
    if (canUseCached(sourceKey, now, allowCurrent) && now < refreshRetryAt) return Promise.resolve(copilotToken);
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal));

    let flight = refreshFlight?.key === sourceKey ? refreshFlight : null;
    if (flight?.controller.signal.aborted) {
      if (refreshFlight === flight) refreshFlight = null;
      flight = null;
    }
    if (!flight) {
      const controller = new AbortController();
      const tokenRetryOptions = options.tokenRetryOptions
        ?? (canUseCached(sourceKey, now, allowCurrent) ? { retries: 0 } : undefined);
      flight = { key: sourceKey, controller, waiters: 0, settled: false, promise: null };
      flight.promise = refresh({ ...options, home, signal: controller.signal, tokenRetryOptions })
        .catch((error) => {
          const fallbackNow = Date.now();
          if (error?.transient && canUseCached(sourceKey, fallbackNow)) {
            refreshRetryAt = Math.min(copilotTokenExpiry, fallbackNow + 5000);
            const profileLabel = copilotProfileLabel(profile);
            console.warn(status("warn", `${profileLabel} token refresh failed temporarily; using the existing token until ${new Date(copilotTokenExpiry).toISOString()} (${error.message})`));
            return copilotToken;
          }
          throw error;
        })
        .finally(() => {
          flight.settled = true;
          if (refreshFlight === flight) refreshFlight = null;
        });
      refreshFlight = flight;
    }
    return waitForSingleflight(flight, options.signal);
  }

  function runtimeStatus(now = Date.now()) {
    let upstreamHost = "unknown";
    try { upstreamHost = new URL(apiBase).hostname; } catch {}
    return {
      profile,
      token_cached: Boolean(copilotToken),
      token_expires_in_ms: copilotToken ? Math.max(0, copilotTokenExpiry - now) : null,
      token_refresh_in_flight: Boolean(refreshFlight),
      token_refresh_backoff_ms: Math.max(0, refreshRetryAt - now),
      account_bound: Boolean(githubIdentity),
      upstream_host: upstreamHost,
    };
  }

  function resetForTests() {
    refreshFlight?.controller.abort();
    copilotToken = null;
    copilotTokenExpiry = 0;
    refreshFlight = null;
    tokenSourceKey = null;
    githubFingerprint = "";
    githubIdentity = null;
    refreshRetryAt = 0;
    apiBase = defaultApiBase;
  }

  return Object.freeze({
    getToken,
    getApiBase: () => apiBase,
    runtimeStatus,
    resetForTests,
  });
}
