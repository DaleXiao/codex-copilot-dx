import { ADAPTER_STATUS_PATH, adapterBaseUrl } from "./running-adapter.mjs";
import { status } from "./status.mjs";

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function count(value) {
  const number = finiteNumber(value);
  return number === null ? "n/a" : String(Math.max(0, Math.round(number)));
}

function duration(value) {
  const milliseconds = finiteNumber(value);
  if (milliseconds === null) return "n/a";
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

function latency(value) {
  const milliseconds = finiteNumber(value);
  if (milliseconds === null) return "n/a";
  if (milliseconds >= 1000) return `${(milliseconds / 1000).toFixed(2)}s`;
  return `${milliseconds.toFixed(1)}ms`;
}

function mebibytes(value) {
  const bytes = finiteNumber(value);
  return bytes === null ? "n/a" : `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
}

function tpot(metric) {
  const average = finiteNumber(metric?.avg);
  if (average === null) return "n/a";
  const milliseconds = metric?.unit === "us" ? average / 1000 : average;
  return `${milliseconds.toFixed(2)}ms/token`;
}

function cacheHitRate(cache = {}) {
  const hits = finiteNumber(cache.cache_hits);
  const misses = finiteNumber(cache.cache_misses);
  if (hits === null || misses === null || hits + misses <= 0) return "n/a";
  return `${((hits / (hits + misses)) * 100).toFixed(1)}%`;
}

function profileSummary(label, profile = {}) {
  const client = profile.client || {};
  const models = profile.models || {};
  const mode = ["legacy", "inherited", "isolated"].includes(profile.mode)
    ? profile.mode
    : "unknown";
  const source = typeof models.source === "string" && models.source ? models.source : "unknown";
  const token = client.token_cached
    ? `token cached (${duration(client.token_expires_in_ms)} remaining)`
    : "token not cached";
  return `${label} ${mode}: ${token}, ${count(models.models)} total/${count(models.claude_models)} Claude models (${source})`;
}

function routingTarget(value) {
  if (value === "codex") return "Codex";
  if (value === "claude") return "Claude";
  return "unknown";
}

function pmRouteSummary(requests = {}) {
  const routes = requests.by_route;
  if (!routes || typeof routes !== "object") return null;
  const names = ["pm_models", "pm_chat_completions"];
  const totals = names.reduce((summary, name) => {
    const route = routes[name] || {};
    summary.total += finiteNumber(route.total) || 0;
    summary.active += finiteNumber(route.active) || 0;
    summary.errors += finiteNumber(route.errors) || 0;
    return summary;
  }, { total: 0, active: 0, errors: 0 });
  return `PM relay: ${count(totals.total)} requests, ${count(totals.active)} active, ${count(totals.errors)} errors; models ${count(routes.pm_models?.total)}, chat ${count(routes.pm_chat_completions?.total)}`;
}

function errorCode(error) {
  const seen = new Set();
  const pending = [error];
  while (pending.length) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (typeof current.code === "string") return current.code;
    pending.push(current.cause, ...(Array.isArray(current.errors) ? current.errors : []));
  }
  return "";
}

export async function readAdapterStatus({
  host = "127.0.0.1",
  port = 2026,
  timeoutMs = 500,
  fetchImpl = fetch,
} = {}) {
  const baseUrl = adapterBaseUrl(host, port);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}${ADAPTER_STATUS_PATH}`, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: ctrl.signal,
    });
    if (!response.ok) throw new Error(`returned HTTP ${response.status}`);

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("returned invalid JSON");
    }
    if (data?.ok !== true
      || data?.name !== "codex-copilot-dx"
      || typeof data.version !== "string"
      || !Number.isInteger(data.pid)) {
      throw new Error("returned an incompatible status payload");
    }
    return { baseUrl, data };
  } catch (error) {
    const code = errorCode(error);
    const reason = ctrl.signal.aborted
      ? `timed out after ${timeoutMs}ms`
      : code === "ECONNREFUSED" || code === "ENETUNREACH"
        ? "adapter is not running"
        : error?.message || String(error);
    const nextStep = reason === "adapter is not running"
      ? `. Run ccdx start, then retry ccdx status`
      : "";
    throw new Error(`Could not read adapter status at ${baseUrl}: ${reason}${nextStep}`);
  } finally {
    clearTimeout(timer);
  }
}

export function formatAdapterStatus({ baseUrl, data }, { commandName = "ccdx", cliVersion = data.version } = {}) {
  const requests = data.requests || {};
  const performance = data.stream_performance?.by_route?.responses || {};
  const admission = data.admission || {};
  const history = data.response_history || {};
  const images = data.image_optimization || {};
  const imageHistory = data.image_history_pressure;
  const models = data.models || {};
  const copilot = data.copilot || {};
  const limits = data.limits || {};
  const processStats = data.process || {};
  const adapterLine = data.version === cliVersion
    ? status("ok", `Adapter ${data.version} is running at ${baseUrl} (PID ${data.pid}, uptime ${duration(data.uptime_ms)})`)
    : status("warn", `Adapter ${data.version} is running at ${baseUrl}, but this CLI is ${cliVersion}; stop the running adapter before switching versions`);

  const lines = [
    `${commandName} status`,
    adapterLine,
    status("info", `Requests: ${count(requests.completed)}/${count(requests.total)} completed, ${count(requests.active)} active, ${count(requests.status_4xx)} 4xx, ${count(requests.status_5xx)} 5xx, ${count(requests.aborted)} aborted`),
    status("info", `Responses stream: TTFT avg ${latency(performance.ttft_ms?.avg)} (${count(performance.ttft_ms?.samples)} samples), TPOT avg ${tpot(performance.tpot_us)}`),
    status("info", `Admission: ${count(admission.activeRequests)} active, ${count(admission.queued)} queued, ${count(admission.rejected)} rejected, ${count(admission.timedOut)} timed out, wait avg ${latency(admission.waitMsAvg)}`),
    status("info", `Memory: RSS ${mebibytes(processStats.rss_bytes)}, heap ${mebibytes(processStats.heap_used_bytes)}`),
    status("info", `History: ${mebibytes(history.bytes)} / ${mebibytes(limits.response_history_max_bytes)}, ${count(history.entries)} entries, ${count(history.evicted)} evicted`),
    status("info", `Image cache: ${count(images.cache_entries)} entries, ${cacheHitRate(images)} hits, ${mebibytes(images.cache_bytes)} / ${mebibytes(images.cache_max_bytes)}`),
  ];
  if (imageHistory && typeof imageHistory === "object") {
    lines.push(status("info", `Visual history: ${count(imageHistory.active_recovery_trees)} recovery trees, ${count(imageHistory.adapted_requests)} adapted requests, ${count(imageHistory.historical_images_omitted)} older images omitted, ${count(imageHistory.timeouts_recorded)} timeouts`));
  }
  lines.push(status("info", `Models: ${count(models.models)} total, ${count(models.claude_models)} Claude; Copilot token ${copilot.token_cached ? `cached (${duration(copilot.token_expires_in_ms)} remaining)` : "not cached"}`));
  if (data.profiles?.codex || data.profiles?.claude) {
    lines.push(status("info", `Profiles: ${profileSummary("Codex", data.profiles?.codex)}; ${profileSummary("Claude", data.profiles?.claude)}`));
  }
  if (data.routing) {
    lines.push(status("info", `Routing: /v1/responses -> ${routingTarget(data.routing.responses)}; /v1/messages -> ${routingTarget(data.routing.messages)}`));
  }
  const pmSummary = pmRouteSummary(requests);
  if (pmSummary) lines.push(status("info", pmSummary));
  lines.push(status("info", `Limits: request body ${mebibytes(limits.max_body_bytes)}, decoded body ${mebibytes(limits.max_decoded_body_bytes)}`));
  return lines.join("\n");
}
