import os from "node:os";
import { isProviderId } from "./provider-metadata.mjs";
import { fetchLiveCopilotModels } from "./live-models.mjs";
import { authStatus } from "./auth-status.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";
import { createRequestAbort, readJsonBody } from "./http-transport.mjs";
import { isLoopbackAddress, isLoopbackHostHeader } from "./security.mjs";
import {
  DEFAULT_TERMINAL_ANIMATION_THEME,
  getTerminalAnimationFrameDelay,
  isTerminalAnimationTheme,
  renderTerminalAnimationFrame,
  TERMINAL_ANIMATION_THEMES,
} from "./terminal-animation.mjs";
import { cacheReadTokens, summarizeUsageLogs, usageCacheHitRate, usageModelGroups } from "./usage-store.mjs";
import { createUsageAnalytics } from "./usage-analytics.mjs";
import { analyzeUsageLogs } from "./usage-analysis.mjs";
import { readUserSettings, terminalAnimationPreference, writeTerminalAnimationTheme } from "./user-settings.mjs";

const ANIMATION_PATH = "/_ccdx/ui/animation";
const MODELS_PATH = "/_ccdx/ui/models/live";
const USAGE_PATH = "/_ccdx/ui/usage";
const PROVIDERS_PATH = "/_ccdx/ui/providers";
const AUTH_PATH = "/_ccdx/ui/auth";
const DISABLED_ANIMATION = /^(0|false|no|off)$/i;

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

function safeText(value, length = 160) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, length);
}

function liveModelError(error) {
  const message = String(error?.message || error || "");
  const status = /\bHTTP (\d{3})\b/.exec(message)?.[1];
  if (status) return `Live model lookup failed (HTTP ${status}). Run ccdx models for details.`;
  if (/timed out/i.test(message)) return "Live model lookup timed out. Retry or run ccdx models.";
  if (/GitHub token not found/i.test(message)) return "GitHub token not found. Start ccdx to sign in.";
  return "Live model lookup failed. Run ccdx models for details.";
}

function animationState(env, home, { includeFrames = false } = {}) {
  readUserSettings({ env, home, strict: true });
  const preference = terminalAnimationPreference({ env, home });
  return {
    theme: preference.theme,
    source: preference.source,
    disabled_by_environment: DISABLED_ANIMATION.test(String(env.CCDX_TERMINAL_ANIMATION || "").trim()),
    themes: TERMINAL_ANIMATION_THEMES.map((theme) => ({
      id: theme.id,
      label: theme.label,
      default: theme.id === DEFAULT_TERMINAL_ANIMATION_THEME,
      ...(includeFrames ? {
        loop_pause_ms: theme.loopPauseMs,
        frames: Array.from({ length: theme.frameCount }, (_, offset) => {
          const index = theme.startFrame + offset;
          return {
            ansi: renderTerminalAnimationFrame(theme.id, index),
            delay_ms: getTerminalAnimationFrameDelay(theme.id, index),
          };
        }),
      } : {}),
    })),
  };
}

function sameOrigin(req) {
  const origin = req.headers?.origin;
  const host = req.headers?.host;
  if (typeof origin !== "string" || typeof host !== "string") return false;
  try {
    return new URL(origin).origin === new URL(`http://${host}`).origin;
  } catch {
    return false;
  }
}

function finite(value) {
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

function usageRow(model, values) {
  return {
    model: safeText(model, 100),
    requests: finite(values.requests),
    input_tokens: finite(values.input_tokens),
    cache_read_tokens: cacheReadTokens(values) ?? null,
    cache_hit_rate: usageCacheHitRate(values),
    cache_hit_rate_partial: values.cache_hit_unknown_requests > 0,
    output_tokens: finite(values.output_tokens),
    total_tokens: finite(values.total_tokens),
  };
}

function usageTable(summary) {
  const models = Object.entries(usageModelGroups(summary))
    .sort(([leftName, left], [rightName, right]) => (right.total_tokens || 0) - (left.total_tokens || 0)
      || leftName.localeCompare(rightName, "en"));
  return {
    total: usageRow("TOTAL", { requests: summary.requests, ...summary.totals }),
    model_count: models.length,
    rows: models.slice(0, 100).map(([name, values]) => usageRow(name, values)),
  };
}

function dashboardProviders(providerStateFn, authStatusFn) {
  const local = authStatusFn()?.profiles?.codex || {};
  const entries = providerStateFn?.() || [{ id: "github", name: "GitHub Copilot", enabled: true, state: "unknown",
    clients: [{ id: "codex", name: "Codex App", selected: true, state: "configured" }] }];
  return entries.slice(0, 16).filter(entry => isProviderId(entry.id)).map(entry => {
    const auth = entry.id === "github" ? { ...entry.auth,
      state: local.valid ? "saved" : local.configured ? "unavailable" : "unconfigured",
      account: local.valid ? local.login || "" : "" } : entry.auth || {};
    const label = value => safeText(redactDiagnosticText(value || ""), 160);
    const code = value => typeof value === "string" && /^[a-z0-9_:-]{1,80}$/.test(value) ? value : null;
    return { id: entry.id, name: label(entry.name) || entry.id, enabled: entry.enabled === true,
      state: code(entry.state) || "unknown", reason: code(entry.reason), generation: finite(entry.generation),
      auth: { state: code(auth.state) || "unknown", account: label(auth.account), token_cached: auth.token_cached === true,
        expires_in_ms: finite(auth.expires_in_ms), checked_at: label(auth.checked_at) || null },
      models: { count: finite(entry.models?.count), source: code(entry.models?.source) || "unknown", checked_at: label(entry.models?.checked_at) || null },
      clients: (entry.clients || []).slice(0, 8).map(client => ({ id: code(client.id), name: label(client.name),
        selected: client.selected === true, state: code(client.state) || "unknown", gateway: code(client.gateway),
        reason: code(client.reason), last_request_at: label(client.last_request_at) || null })),
      request_scope: label(entry.request_scope) || null,
      requests: entry.requests ? Object.fromEntries(["total", "active", "completed", "incomplete", "failed", "cancelled"].map(key => [key, finite(entry.requests[key])])) : null };
  });
}

export async function handleDashboardApi(req, res, pathname, {
  env = process.env,
  home = os.homedir(),
  liveModelsFn = options => fetchLiveCopilotModels({ home, ...options }),
  usageSummaryFn,
  authStatusFn = () => authStatus({ home }),
  providerCatalogFn,
  providerStateFn,
  serviceControl,
  applyAnimation,
} = {}) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)
    || req.headers?.host === undefined
    || !isLoopbackHostHeader(req.headers.host)) {
    sendJson(res, 403, { error: "Dashboard API is available only at a loopback address" });
    return;
  }
  if (req.headers?.["x-ccdx-dashboard"] !== "1") {
    sendJson(res, 403, { error: "Dashboard API requires a same-origin page request" });
    return;
  }

  if (pathname === PROVIDERS_PATH && req.method === "GET") {
    try { sendJson(res, 200, { source: "provider_status", providers: dashboardProviders(providerStateFn, authStatusFn) }); }
    catch { sendJson(res, 500, { error: "Could not read provider status" }); }
    return;
  }

  if (pathname === "/_ccdx/ui/settings") {
    if (!serviceControl) { sendJson(res, 503, { error: "Settings require the running service; restart the updated CCDX" });return; }
    if (req.method === "GET") {
      try { sendJson(res, 200, serviceControl.snapshot()); } catch { sendJson(res, 409, { error: "Service settings are unreadable; existing settings were preserved" }); }
      return;
    }
    if (req.method !== "POST") { sendJson(res, 405, { error: "Use GET or POST" });return; }
    if (!sameOrigin(req)) { sendJson(res, 403, { error: "Settings require the same-origin dashboard" });return; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) { sendJson(res, 415, { error: "Expected application/json" });return; }
    const abort = createRequestAbort(req, res);abort.setTimeout(5000, "request_body_timeout");
    try {
      const input = await readJsonBody(req, { maxBodyBytes: 4096, maxDecodedBodyBytes: 4096, signal: abort.signal });
      abort.clearTimeout();const data = await serviceControl.action(input);
      if (!res.destroyed && !res.writableEnded) sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || (error.code?.startsWith("ccdx_cache_") ? 409 : 400), { error: safeText(error.message, 300) });
    } finally { abort.cleanup(); }
    return;
  }

  if (pathname === AUTH_PATH && req.method === "GET") {
    try {
      const profile = authStatusFn()?.profiles?.codex;
      if (!profile || typeof profile.configured !== "boolean" || typeof profile.valid !== "boolean") throw new Error("Invalid auth status");
      const login = typeof profile.login === "string" && /^[a-z\d_-]{1,39}$/i.test(profile.login)
        && redactDiagnosticText(profile.login) === profile.login ? profile.login : "";
      const id = /^\d{1,20}$/.test(String(profile.id || "")) ? String(profile.id) : "";
      sendJson(res, 200, {
        source: "local_auth_status",
        configured: profile.configured,
        valid: profile.valid,
        login: profile.valid ? login : "",
        id: profile.valid ? id : "",
        reason: ["unconfigured", "empty_token", "credential_read_failed"].includes(profile.reason) ? profile.reason : "",
      });
    } catch {
      sendJson(res, 500, { error: "Could not read local auth status" });
    }
    return;
  }

  if (pathname === ANIMATION_PATH && req.method === "GET") {
    try {
      const query = new URL(req.url, "http://localhost").searchParams;
      sendJson(res, 200, animationState(env, home, { includeFrames: query.get("frames") !== "0" }));
    } catch {
      sendJson(res, 409, { error: "Animation settings are invalid; inspect them with ccdx animation" });
    }
    return;
  }

  if (pathname === ANIMATION_PATH && req.method === "POST") {
    if (!sameOrigin(req)) {
      sendJson(res, 403, { error: "Animation changes require the same-origin dashboard" });
      return;
    }
    if (String(req.headers?.["content-type"] || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      sendJson(res, 415, { error: "Animation changes require application/json" });
      return;
    }
    const abort = createRequestAbort(req, res);
    abort.setTimeout(5000, "request_body_timeout");
    let body;
    try {
      body = await readJsonBody(req, { maxBodyBytes: 2048, maxDecodedBodyBytes: 2048, signal: abort.signal });
    } catch (error) {
      sendJson(res, error?.statusCode === 413 ? 413 : 400, { error: "Invalid animation request body" });
      return;
    } finally {
      abort.cleanup();
    }
    if (!isTerminalAnimationTheme(body?.theme)) {
      sendJson(res, 400, { error: "Select a listed animation theme" });
      return;
    }
    try {
      const result = writeTerminalAnimationTheme(body.theme, { env, home });
      applyAnimation?.(body.theme);
      sendJson(res, 200, { changed: result.changed, ...animationState(env, home) });
    } catch {
      sendJson(res, 409, { error: "Animation setting was not saved; check ccdx animation" });
    }
    return;
  }

  if (pathname === MODELS_PATH && req.method === "GET") {
    const abort = createRequestAbort(req, res);
    try {
      const provider = new URL(req.url, "http://localhost").searchParams.get("provider") || "";
      if (provider && (!isProviderId(provider) || !dashboardProviders(providerStateFn, authStatusFn).some(entry => entry.id === provider))) {
        sendJson(res, 400, { error: "Select a registered provider" });return;
      }
      const catalog = await providerCatalogFn?.({ ...(provider ? { provider } : {}), signal: abort.signal })
        || await liveModelsFn({ signal: abort.signal, includeAll: true });
      if (!Array.isArray(catalog?.models) || !Number.isFinite(catalog?.advertised)) {
        throw new Error("Invalid live model catalog");
      }
      const models = catalog.models;
      sendJson(res, 200, {
        source: catalog.source === "catalog" ? "catalog" : "live",
        checked_at: catalog.source === "catalog" ? catalog.checkedAt : new Date().toISOString(),
        upstream_host: safeText(catalog?.upstreamHost || "GitHub Copilot", 120),
        advertised: finite(catalog?.advertised),
        selectable: models.filter(model => model.selectable !== false).length,
        models: models.slice(0, 500).map((model) => ({
          id: safeText(model.id, 100),
          vendor: safeText(model.vendor, 80),
          endpoints: Array.isArray(model.endpoints) ? model.endpoints.filter((value) => ["responses", "chat", "messages"].includes(value)) : [],
          preview: model.preview === true,
          selectable: model.selectable !== false,
          clients: Array.isArray(model.clients) ? model.clients.filter(value => typeof value === "string").slice(0, 8).map(value => safeText(value, 40)) : [],
          reasoning_efforts: Array.isArray(model.reasoning_efforts) ? model.reasoning_efforts.slice(0, 16).map(value => safeText(value, 16)) : null,
          state: ["listed", "restricted", "hidden"].includes(model.state) ? model.state : "listed",
          context_window: finite(model.context_window),
        })),
      });
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) sendJson(res, error.statusCode || 502, { error: /^m365_[a-z0-9_]+$/.test(error.code || "") ? `Model catalog unavailable / ${error.code}` : liveModelError(error) });
    } finally { abort.cleanup(); }
    return;
  }

  if (pathname === USAGE_PATH && req.method === "GET") {
    const query = new URL(req.url, "http://localhost").searchParams;
    const provider = query.get("provider") || "";
    if (provider && !isProviderId(provider)) { sendJson(res, 400, { error: "Select a valid provider" });return; }
    let analytics = null;
    if (query.get("analytics") === "1") {
      try {
        const timeZone = query.get("time_zone") || "UTC";
        if (timeZone.length > 100) throw new Error("Invalid time zone");
        analytics = createUsageAnalytics({ timeZone, qualifyProviders: !provider });
      } catch {
        sendJson(res, 400, { error: "Select a valid usage time zone" });
        return;
      }
    }
    try {
      const analysis = analytics && !usageSummaryFn
        ? await analyzeUsageLogs(undefined, { timeZone: query.get("time_zone") || "UTC", provider }) : null;
      const summary = analysis?.summary || await (usageSummaryFn || (options => summarizeUsageLogs(undefined, options)))({ provider, ...(analytics ? { onRecord: analytics.record } : {}) });
      sendJson(res, 200, { source: "local_usage_log", provider: provider || "all", providers: summary.providers, ...usageTable(summary), ...(analytics ? { analytics: analysis?.analytics || analytics.snapshot() } : {}) });
    } catch {
      sendJson(res, 500, { error: "Could not read local usage summary" });
    }
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}
