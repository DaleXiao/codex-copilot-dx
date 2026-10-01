import os from "node:os";
import { fetchLiveCopilotModels } from "./cli-models.mjs";
import { createRequestAbort, readJsonBody } from "./http-transport.mjs";
import { isLoopbackAddress, isLoopbackHostHeader } from "./observability.mjs";
import {
  DEFAULT_TERMINAL_ANIMATION_THEME,
  getTerminalAnimationFrameDelay,
  isTerminalAnimationTheme,
  renderTerminalAnimationFrame,
  TERMINAL_ANIMATION_THEMES,
} from "./terminal-animation.mjs";
import { cacheReadTokens, summarizeUsageLogs, usageCacheHitRate } from "./usage.mjs";
import { createUsageAnalytics } from "./usage-analytics.mjs";
import { readUserSettings, terminalAnimationPreference, writeTerminalAnimationTheme } from "./user-settings.mjs";

const ANIMATION_PATH = "/_ccdx/ui/animation";
const MODELS_PATH = "/_ccdx/ui/models/live";
const USAGE_PATH = "/_ccdx/ui/usage";
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
  const models = Object.entries(summary.byModel || {})
    .sort(([leftName, left], [rightName, right]) => (right.total_tokens || 0) - (left.total_tokens || 0)
      || leftName.localeCompare(rightName, "en"));
  return {
    total: usageRow("TOTAL", { requests: summary.requests, ...summary.totals }),
    model_count: models.length,
    rows: models.slice(0, 100).map(([name, values]) => usageRow(name, values)),
  };
}

export async function handleDashboardApi(req, res, pathname, {
  env = process.env,
  home = os.homedir(),
  liveModelsFn = () => fetchLiveCopilotModels({ home }),
  usageSummaryFn = (options) => summarizeUsageLogs(undefined, options),
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
      sendJson(res, 200, { changed: result.changed, ...animationState(env, home) });
    } catch {
      sendJson(res, 409, { error: "Animation setting was not saved; check ccdx animation" });
    }
    return;
  }

  if (pathname === MODELS_PATH && req.method === "GET") {
    try {
      const catalog = await liveModelsFn();
      if (!Array.isArray(catalog?.models) || !Number.isFinite(catalog?.advertised)) {
        throw new Error("Invalid live model catalog");
      }
      const models = catalog.models;
      sendJson(res, 200, {
        source: "live",
        checked_at: new Date().toISOString(),
        upstream_host: safeText(catalog?.upstreamHost || "GitHub Copilot", 120),
        advertised: finite(catalog?.advertised),
        selectable: models.length,
        models: models.slice(0, 500).map((model) => ({
          id: safeText(model.id, 100),
          vendor: safeText(model.vendor, 80),
          endpoints: Array.isArray(model.endpoints) ? model.endpoints.filter((value) => value === "responses" || value === "chat") : [],
          preview: model.preview === true,
        })),
      });
    } catch (error) {
      sendJson(res, 502, { error: liveModelError(error) });
    }
    return;
  }

  if (pathname === USAGE_PATH && req.method === "GET") {
    const query = new URL(req.url, "http://localhost").searchParams;
    let analytics = null;
    if (query.get("analytics") === "1") {
      try {
        const timeZone = query.get("time_zone") || "UTC";
        if (timeZone.length > 100) throw new Error("Invalid time zone");
        analytics = createUsageAnalytics({ timeZone });
      } catch {
        sendJson(res, 400, { error: "Select a valid usage time zone" });
        return;
      }
    }
    try {
      const summary = await usageSummaryFn(analytics ? { onRecord: analytics.record } : undefined);
      sendJson(res, 200, { source: "local_usage_log", ...usageTable(summary), ...(analytics ? { analytics: analytics.snapshot() } : {}) });
    } catch {
      sendJson(res, 500, { error: "Could not read local usage summary" });
    }
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}
