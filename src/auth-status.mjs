import os from "node:os";
import { validateGithubToken } from "./auth.mjs";
import { AUTH_PROFILE_CODEX, readAuthProfileCredentials } from "./auth-profile.mjs";
import { buildHeaders, FALLBACK_VSCODE_VERSION, parseApiBase } from "./copilot.mjs";
import { MAX_UPSTREAM_MODEL_CATALOG_BYTES, readBoundedResponseText } from "./http-transport.mjs";
import { profileRouting } from "./profile-routing.mjs";
import { awaitWithSignal } from "./auth-device-flow.mjs";

const DEFAULT_COPILOT_CATALOG_TIMEOUT_MS = 30 * 1000;

function responseDetail(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("Cancelled");
  error.name = "AbortError";
  return error;
}

function catalogModels(payload) {
  const models = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(models)) throw new Error("Copilot model catalog contained no model list");
  return models;
}

async function fetchCopilotCatalog(tokenData, {
  fetchImpl,
  signal,
  vscodeVersion = FALLBACK_VSCODE_VERSION,
  timeoutMs = DEFAULT_COPILOT_CATALOG_TIMEOUT_MS,
} = {}) {
  const parsedTimeout = Number(timeoutMs);
  const deadlineMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0
    ? parsedTimeout
    : DEFAULT_COPILOT_CATALOG_TIMEOUT_MS;
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (signal?.aborted) onCallerAbort();
  const timer = setTimeout(() => controller.abort(new Error(`Copilot model catalog timed out after ${deadlineMs}ms`)), deadlineMs);
  try {
    const apiBase = parseApiBase(tokenData);
    const headers = buildHeaders({
      token: tokenData.token,
      version: vscodeVersion,
      initiator: "user",
      vision: false,
    });
    const response = await awaitWithSignal(() => fetchImpl(`${apiBase}/models`, {
      headers,
      redirect: "error",
      signal: controller.signal,
    }), controller.signal);
    const modelText = await awaitWithSignal(() => readBoundedResponseText(response, {
      maxBytes: MAX_UPSTREAM_MODEL_CATALOG_BYTES,
      label: "Copilot model catalog",
      signal: controller.signal,
    }), controller.signal);
    if (!response.ok) {
      const detail = responseDetail(modelText);
      throw new Error(`Copilot model catalog failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    let catalog;
    try {
      catalog = JSON.parse(modelText);
    } catch {
      throw new Error("Copilot model catalog returned invalid JSON");
    }
    catalogModels(catalog);
    return { catalog, apiBase };
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    if (controller.signal.aborted) throw abortError(controller.signal);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

function publicProfile(credentials) {
  return {
    configured: credentials.configured,
    valid: credentials.valid,
    reason: credentials.reason,
    login: credentials.identity?.login || "",
    id: credentials.identity?.id || "",
    source: credentials.paths?.tokenPath.replace(/\\/g, "/").split("/").at(-2) === "ccdx" ? "ccdx" : "legacy",
  };
}

function readStatusCredentials(home) {
  try {
    return readAuthProfileCredentials(AUTH_PROFILE_CODEX, { home });
  } catch {
    return {
      profile: AUTH_PROFILE_CODEX,
      configured: true,
      valid: false,
      reason: "credential_read_failed",
      token: "",
      identity: null,
    };
  }
}

export function authStatus({ home = os.homedir() } = {}) {
  const codex = readStatusCredentials(home);
  return {
    profiles: { codex: publicProfile(codex) },
    routing: profileRouting(),
  };
}

export async function inspectGithubAccess(credentials, { fetchImpl = fetch, timeoutMs = 10000, signal } = {}) {
  if (!credentials.valid) {
    return { checked: false, ok: false, reason: credentials.reason || "unconfigured" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const stages = { identity: "not_checked", access: "not_checked", models: "not_checked" };
  try {
    const validation = await validateGithubToken(credentials.token, {
      fetchImpl,
      signal: controller.signal,
    });
    if (controller.signal.aborted) throw abortError(controller.signal);
    if (!validation.ok) {
      stages.identity = validation.login ? "passed" : validation.reason === "github_token_invalid" ? "invalid" : "unavailable";
      if (validation.login) stages.access = "unavailable";
      return {
        checked: true,
        ok: false,
        reason: validation.reason,
        httpStatus: validation.status || null,
        stages,
      };
    }
    stages.identity = "passed";stages.access = "passed";
    stages.models = "unavailable";
    const { catalog, apiBase } = await fetchCopilotCatalog(validation.copilotTokenData, {
      fetchImpl,
      signal: controller.signal,
    });
    let upstreamHost = "GitHub Copilot";
    try { upstreamHost = new URL(apiBase).hostname; } catch {}
    return {
      checked: true,
      ok: true,
      stages: { ...stages, models: "passed" },
      login: validation.login || credentials.identity?.login || "",
      id: validation.id || "",
      models: catalogModels(catalog).length,
      upstreamHost,
    };
  } catch (error) {
    return {
      checked: true,
      ok: false,
      reason: controller.signal.aborted ? `timed out after ${timeoutMs}ms` : error.message,
      stages,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function authStatusOnline({
  home = os.homedir(),
  fetchImpl = fetch,
  timeoutMs = 10000,
} = {}) {
  const local = authStatus({ home });
  const online = await inspectGithubAccess(readStatusCredentials(home), { fetchImpl, timeoutMs });
  return {
    ...local,
    profiles: {
      codex: { ...local.profiles.codex, online },
    },
  };
}
