import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { m365AccountKey, readM365Account } from "../m365-settings.mjs";

const helperPath = fileURLToPath(new URL("./m365-auth-helper.mjs", import.meta.url));
const abortError = signal => signal?.reason || Object.assign(new Error("M365 authorization cancelled"), { name: "AbortError" });
export const m365Error = (code, message = code) => Object.assign(new Error(message), { code, statusCode: 503 });

export function m365HelperEnvironment(env = process.env) {
  const keys = new Set(["PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "WINDIR", "APPDATA", "LOCALAPPDATA",
    "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"]);
  return Object.fromEntries(Object.entries(env).filter(([key]) => keys.has(key.toUpperCase())));
}

export function requestM365Token({ account, signal, env = process.env, spawnImpl = spawn, timeoutMs = 28000 } = {}) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let child, timer, finished = false, bytes = 0;
    const chunks = [];
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
      if (error) { child?.kill("SIGKILL");reject(error); } else resolve(result);
    };
    const cancelled = () => finish(abortError(signal));
    try { child = spawnImpl(process.execPath, [helperPath], { env: m365HelperEnvironment(env), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
    catch { finish(m365Error("m365_helper_start_failed"));return; }
    timer = setTimeout(() => finish(m365Error("m365_auth_timeout")), timeoutMs);
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) { cancelled();return; }
    child.once("error", () => finish(m365Error("m365_helper_start_failed")));
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {});
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 128 * 1024) { finish(m365Error("m365_auth_response_invalid"));return; }
      chunks.push(chunk);
    });
    child.once("close", code => {
      if (finished) return;
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { finish(m365Error("m365_auth_response_invalid"));return; }
      if (code !== 0 || result.error) {
        finish(m365Error(/^m365_[a-z_]+$/.test(result.error?.code || "") ? result.error.code : "m365_auth_failed"));return;
      }
      try {
        m365AccountKey(result.account);
        if (typeof result.token !== "string" || !result.token || /\s/.test(result.token)
          || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) throw Error();
        if (account && m365AccountKey(account) !== m365AccountKey(result.account)) throw Error();
      } catch { finish(m365Error("m365_auth_response_invalid"));return; }
      finish(null, result);
    });
    child.stdin.end(JSON.stringify({ action: "token", account: account || null }));
  });
}

export function createM365Auth({ home, env = process.env, acquire = requestM365Token, now = Date.now } = {}) {
  let cached = null, flight = null, generation = 0, lastError = null, retryAt = 0;
  const snapshot = () => ({ token_cached: Boolean(cached && cached.expiresAt > now()),
    token_expires_in_ms: cached ? Math.max(0, cached.expiresAt - now()) : null,
    token_refresh_in_flight: Boolean(flight), reason: lastError,
    account: cached ? { login: cached.account.login } : null });
  function getToken({ signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (cached && cached.expiresAt - now() > 120000) return Promise.resolve(cached);
    if (flight?.controller.signal.aborted) flight = null;
    if (!flight && retryAt > now()) return Promise.reject(m365Error(lastError || "m365_auth_backoff"));
    if (!flight) {
      const controller = new AbortController(), current = generation;
      const entry = { controller, waiters: 0, settled: false, promise: null };
      entry.promise = Promise.resolve().then(() => acquire({ account: cached?.account || readM365Account({ home }), env, signal: controller.signal }))
        .then(result => {
          if (current !== generation || controller.signal.aborted) throw abortError(controller.signal);
          m365AccountKey(result.account);
          cached = result;lastError = null;retryAt = 0;return result;
        }).catch(error => {
          if (current === generation && !controller.signal.aborted) {
            lastError = /^m365_[a-z_]+$/.test(error?.code || "") ? error.code : "m365_auth_failed";
            retryAt = now() + 60000;
          }
          throw error;
        }).finally(() => { entry.settled = true;if (flight === entry) flight = null; });
      flight = entry;
    }
    const entry = flight;
    entry.waiters += 1;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, value) => {
        if (done) return;
        done = true;signal?.removeEventListener("abort", cancelled);entry.waiters -= 1;
        if (!entry.waiters && !entry.settled) entry.controller.abort();
        fn(value);
      };
      const cancelled = () => finish(reject, abortError(signal));
      signal?.addEventListener("abort", cancelled, { once: true });
      if (signal?.aborted) cancelled();
      entry.promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  return { getToken, snapshot, reset() { generation += 1;flight?.controller.abort();flight = null;cached = null;lastError = null;retryAt = 0; } };
}
