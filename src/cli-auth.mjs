import os from "node:os";
import { validateGithubToken } from "./auth.mjs";
import {
  AUTH_PROFILE_CODEX,
  readAuthProfileCredentials,
} from "./auth-profile.mjs";
import { buildHeaders, FALLBACK_VSCODE_VERSION, parseApiBase } from "./copilot.mjs";
import {
  MAX_UPSTREAM_MODEL_CATALOG_BYTES,
  readBoundedResponseText,
} from "./http-transport.mjs";
import { profileRouting } from "./profile-routing.mjs";
import { status } from "./status.mjs";
import {
  cliOutputFormat,
  cliOutputWidth,
  formatResponsiveCliTable,
  terminalCell,
} from "./cli-table.mjs";

const DEFAULT_COPILOT_CATALOG_TIMEOUT_MS = 30 * 1000;

function responseDetail(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
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
    const response = await fetchImpl(`${apiBase}/models`, {
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    const modelText = await readBoundedResponseText(response, {
      maxBytes: MAX_UPSTREAM_MODEL_CATALOG_BYTES,
      label: "Copilot model catalog",
      signal: controller.signal,
    });
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
    source: "legacy",
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

async function inspectProfileOnline(credentials, { fetchImpl, timeoutMs } = {}) {
  if (!credentials.valid) {
    return { checked: false, ok: false, reason: credentials.reason || "unconfigured" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const validation = await validateGithubToken(credentials.token, {
      fetchImpl,
      signal: controller.signal,
    });
    if (controller.signal.aborted) throw abortError(controller.signal);
    if (!validation.ok) {
      return {
        checked: true,
        ok: false,
        reason: validation.reason,
        httpStatus: validation.status || null,
      };
    }
    const { catalog, apiBase } = await fetchCopilotCatalog(validation.copilotTokenData, {
      fetchImpl,
      signal: controller.signal,
    });
    let upstreamHost = "GitHub Copilot";
    try { upstreamHost = new URL(apiBase).hostname; } catch {}
    return {
      checked: true,
      ok: true,
      login: validation.login || credentials.identity?.login || "",
      models: catalogModels(catalog).length,
      upstreamHost,
    };
  } catch (error) {
    return {
      checked: true,
      ok: false,
      reason: controller.signal.aborted ? `timed out after ${timeoutMs}ms` : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function authStatusOnline({
  home = os.homedir(),
  fetchImpl = fetch,
  timeoutMs = 10000,
} = {}) {
  const local = authStatus({ home });
  const online = await inspectProfileOnline(readStatusCredentials(home), { fetchImpl, timeoutMs });
  return {
    ...local,
    profiles: {
      codex: { ...local.profiles.codex, online },
    },
  };
}

function accountLabel(profile) {
  if (!profile.configured) return "not configured";
  if (!profile.valid) return `invalid (${profile.reason})`;
  return profile.login || profile.id || "configured";
}

function onlineStatusLine(profile) {
  const online = profile.online;
  if (!online) return null;
  if (!online.ok) {
    const httpStatus = online.httpStatus ? ` (HTTP ${online.httpStatus})` : "";
    return status("warn", `Codex online: ${online.reason || "unavailable"}${httpStatus}`);
  }
  const account = online.login ? `${online.login}; ` : "";
  return status("ok", `Codex online: ${account}${online.models} models`);
}

function authStatusPlainLines(snapshot, { commandName }) {
  return [
    `${commandName} auth status`,
    status(snapshot.profiles.codex.valid ? "ok" : "warn", `Codex: ${accountLabel(snapshot.profiles.codex)} [legacy path]`),
    onlineStatusLine(snapshot.profiles.codex),
    status("info", `Routing: responses -> ${snapshot.routing.responses}`),
  ].filter(Boolean);
}

function authTableOnline(profile) {
  const online = profile.online;
  if (!online) return { state: "[INFO] not checked", models: "—" };
  if (!online.ok) {
    const httpStatus = online.httpStatus ? ` (HTTP ${online.httpStatus})` : "";
    return { state: `[WARN] ${online.reason || "unavailable"}${httpStatus}`, models: "—" };
  }
  return {
    state: `[OK] verified${online.login ? ` as ${online.login}` : ""}`,
    models: Number.isFinite(online.models) ? String(online.models) : "—",
  };
}

export function formatAuthStatus(snapshot = authStatus(), {
  commandName = "ccdx",
  format = "plain",
  output = process.stdout,
  width = cliOutputWidth(output),
} = {}) {
  const plainLines = authStatusPlainLines(snapshot, { commandName });
  if (cliOutputFormat(format, output) === "plain") {
    return plainLines.join("\n");
  }

  const profile = snapshot.profiles.codex;
  const online = authTableOnline(profile);
  const rows = [{
    profile: "Codex",
    account: accountLabel(profile),
    local: profile.valid ? "[OK] ready" : `[WARN] ${accountLabel(profile)}`,
    online: online.state,
    models: online.models,
  }];
  const table = formatResponsiveCliTable({
    columns: [
      { key: "profile", label: "PROFILE" },
      { key: "account", label: "ACCOUNT" },
      { key: "local", label: "LOCAL" },
      { key: "online", label: "ONLINE" },
      { key: "models", label: "MODELS", align: "right" },
    ],
    compactColumns: [
      { key: "profile", label: "PROFILE" },
      { key: "local", label: "LOCAL" },
      { key: "online", label: "ONLINE" },
    ],
    rows,
    width,
  });
  if (format === "auto" && table.overflow) {
    return plainLines.map((line) => terminalCell(line, { fallback: "" })).join("\n");
  }
  const lines = [`${commandName} auth status`, "", table.output];
  if (table.compact) {
    lines.push("", "Details:", ...plainLines.slice(1, -1).map((line) => terminalCell(line, { fallback: "" })));
  }
  lines.push(terminalCell(plainLines.at(-1), { fallback: "" }));
  return lines.join("\n");
}

export async function runAuthCommand({
  action = "status",
  online = false,
  commandName = "ccdx",
  format = "plain",
  output = process.stdout,
  ...options
} = {}) {
  if (action !== "status") throw new Error(`Unsupported auth action: ${action}`);
  const snapshot = online ? await authStatusOnline(options) : authStatus(options);
  return { action, output: formatAuthStatus(snapshot, { commandName, format, output }), snapshot };
}
