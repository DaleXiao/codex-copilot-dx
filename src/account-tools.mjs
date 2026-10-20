import os from "node:os";
import { randomUUID } from "node:crypto";
import { readAuthProfileCredentials } from "./auth-profile.mjs";
import { fetchGithubIdentity, requestGithubDeviceCode, pollGithubDeviceFlow } from "./auth.mjs";
import { githubTokenLockPath, managedGithubTokenPath, writeToken } from "./auth-credentials.mjs";
import { githubIdentityMatchesExpected, githubTokenFingerprint } from "./github-identity.mjs";
import { inspectGithubAccess } from "./auth-status.mjs";
import { withFileLock } from "./lock.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";

const knownReasons = new Set(["unconfigured", "empty_token", "github_token_invalid", "github_access_denied", "github_user_failed",
  "github_user_request_failed", "github_identity_missing", "copilot_access_denied", "copilot_token_failed", "copilot_token_missing",
  "copilot_token_parse_failed", "copilot_token_request_failed", "validation_timeout", "validation_cancelled"]);
const safeLogin = value => /^[a-z\d_-]{1,39}$/i.test(value || "") && redactDiagnosticText(value) === value ? value : "";
const failure = (code, statusCode = 409) => Object.assign(new Error(code), { code, statusCode });
function publicAccess(value) {
  if (!value) return null;
  const httpStatus = value.httpStatus || Number(/HTTP (\d{3})/.exec(value.reason || "")?.[1]) || null;
  return { checked: value.checked === true, ok: value.ok === true,
    reason: value.ok ? "" : knownReasons.has(value.reason) ? value.reason : "connection_unavailable",
    http_status: httpStatus, login: safeLogin(value.login), models: Number.isSafeInteger(value.models) ? value.models : null,
    stages: Object.fromEntries(["identity", "access", "models"].map(key => [key,
      ["passed", "invalid", "unavailable"].includes(value.stages?.[key]) ? value.stages[key] : "not_checked"])) };
}

// One bounded sign-in and one connection check per service. Snapshots contain no credentials.
export function createAccountTools({ home = os.homedir(), env = process.env, fetchImpl = fetch,
  onChanged = () => {}, now = Date.now, poll = pollGithubDeviceFlow, inspect = inspectGithubAccess } = {}) {
  let operation = null, online = null, checkedAt = null, checkedFingerprint = "", checkFlight = null;
  const credentials = () => readAuthProfileCredentials("codex", { home });
  function snapshot() {
    const local = credentials();
    return { source: "account_tools", configured: local.configured, saved: local.valid,
      login: safeLogin(local.identity?.login), store: local.paths.tokenPath === managedGithubTokenPath(home) ? "ccdx" : "legacy",
      online: checkedFingerprint === githubTokenFingerprint(local.token) ? online : null,
      checked_at: checkedFingerprint === githubTokenFingerprint(local.token) ? checkedAt : null,
      operation: operation ? { id: operation.id, state: operation.state, reason: operation.reason || null,
        ...(operation.state === "authorizing" ? { user_code: operation.userCode, verification_uri: operation.uri,
          expires_at: operation.expiresAt } : {}) } : null };
  }
  async function check() {
    if (checkFlight) return checkFlight;
    const local = credentials(), fingerprint = githubTokenFingerprint(local.token);
    if (checkedFingerprint === fingerprint && checkedAt && now() - Date.parse(checkedAt) < 10000) return snapshot();
    checkFlight = (async () => {
      const result = await inspect(local, { fetchImpl, timeoutMs: 15000 });
      if (githubTokenFingerprint(credentials().token) === fingerprint) {
        online = publicAccess(result);checkedAt = new Date(now()).toISOString();checkedFingerprint = fingerprint;
      }
      return snapshot();
    })().finally(() => { checkFlight = null; });
    return checkFlight;
  }
  async function start({ reauth = false, expectedLogin = "" } = {}) {
    if (operation && ["starting", "authorizing", "verifying"].includes(operation.state)) throw failure("auth_busy");
    if (operation && now() - operation.startedAt < 30000) throw failure("auth_retry_later", 429);
    if (expectedLogin && !safeLogin(expectedLogin)) throw failure("auth_invalid_account", 400);
    const before = credentials();
    if (before.valid && !reauth) return snapshot();
    const expected = expectedLogin ? { login: expectedLogin } : env.CCDX_GITHUB_LOGIN ? { login: env.CCDX_GITHUB_LOGIN } : before.identity;
    const current = { id: randomUUID(), state: "starting", startedAt: now(), controller: new AbortController(), task: null };
    operation = current;
    try {
      const result = await requestGithubDeviceCode({ fetchImpl, signal: current.controller.signal });
      const data = result.data;
      if (!result.response.ok || result.jsonError || !data || typeof data.device_code !== "string" || !data.device_code
        || !/^[a-z\d-]{4,32}$/i.test(data.user_code || "") || data.verification_uri !== "https://github.com/login/device"
        || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0 || Number(data.expires_in) > 900) throw failure("auth_start_failed");
      Object.assign(current, { state: "authorizing", userCode: data.user_code, uri: data.verification_uri,
        expiresAt: new Date(now() + Number(data.expires_in) * 1000).toISOString() });
      current.task = (async () => {
        try {
          const result = await poll({ deviceCode: data.device_code, interval: data.interval, expiresIn: data.expires_in,
            fetchImpl, signal: current.controller.signal });
          if (current.controller.signal.aborted) throw failure("auth_cancelled");
          if (result.state !== "done") throw failure(result.state === "expired" ? "auth_expired" : "auth_denied");
          current.state = "verifying";
          const access = await inspect({ valid: true, token: result.token }, { fetchImpl, signal: current.controller.signal, timeoutMs: 15000 });
          if (!access.ok) throw failure(access.reason === "copilot_access_denied" ? "copilot_access_denied" : "auth_verification_failed");
          // Older identity metadata may be absent. Do not guess a different account's identity.
          const identity = access.id ? access : await fetchGithubIdentity(result.token, { fetchImpl, signal: current.controller.signal });
          if (!identity.id || !identity.login || !githubIdentityMatchesExpected(identity, expected)) throw failure("auth_account_mismatch");
          await withFileLock(githubTokenLockPath(home), async () => {
            const latest = credentials();
            if (current.controller.signal.aborted) throw failure("auth_cancelled");
            if (latest.token !== before.token || latest.paths.tokenPath !== before.paths.tokenPath) throw failure("auth_signin_changed");
            writeToken(result.token, home, identity, { managed: true });
          }, { timeoutMs: 1000 });
          checkedFingerprint = githubTokenFingerprint(result.token);online = publicAccess(access);checkedAt = new Date(now()).toISOString();
          current.state = "complete";
          try { await onChanged(); } catch { current.reason = "auth_restart_required"; }
        } catch (error) {
          current.state = current.controller.signal.aborted ? "cancelled" : "failed";
          current.reason = current.controller.signal.aborted ? "auth_cancelled" : /^auth_[a-z_]+$/.test(error.code || "") || error.code === "copilot_access_denied" ? error.code : "auth_verification_failed";
        }
      })();
      return snapshot();
    } catch (error) {
      current.state = current.controller.signal.aborted ? "cancelled" : "failed";
      current.reason = current.controller.signal.aborted ? "auth_cancelled" : "auth_start_failed";
      throw failure(current.reason);
    }
  }
  async function cancel(id) {
    if (!operation || operation.id !== id) throw failure("auth_operation_changed");
    if (["starting", "authorizing", "verifying"].includes(operation.state)) {
      operation.controller.abort();await operation.task;
      operation.state = "cancelled";operation.reason = "auth_cancelled";
    }
    return snapshot();
  }
  async function logout({ confirmed = false } = {}) {
    if (confirmed !== true) throw failure("auth_confirmation_required", 400);
    if (operation && ["starting", "authorizing", "verifying"].includes(operation.state)) throw failure("auth_busy");
    await withFileLock(githubTokenLockPath(home), async () => { credentials();writeToken("", home, null, { managed: true }); }, { timeoutMs: 1000 });
    online = null;checkedAt = null;checkedFingerprint = "";operation = null;await onChanged();
    return snapshot();
  }
  return { snapshot, check, start, cancel, logout, wait: async () => { await operation?.task;return snapshot(); },
    async reload() { await onChanged();return snapshot(); }, dispose() { operation?.controller.abort(); } };
}
