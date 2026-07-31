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
    const reason = ctrl.signal.aborted
      ? `timed out after ${timeoutMs}ms`
      : error?.cause?.code === "ECONNREFUSED"
        ? "adapter is not running"
        : error?.message || String(error);
    throw new Error(`Could not read adapter status at ${baseUrl}: ${reason}`);
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
  const models = data.models || {};
  const copilot = data.copilot || {};
  const limits = data.limits || {};
  const processStats = data.process || {};
  const adapterLine = data.version === cliVersion
    ? status("ok", `Adapter ${data.version} is running at ${baseUrl} (PID ${data.pid}, uptime ${duration(data.uptime_ms)})`)
    : status("warn", `Adapter ${data.version} is running at ${baseUrl}, but this CLI is ${cliVersion}; stop the running adapter before switching versions`);

  return [
    `${commandName} status`,
    adapterLine,
    status("info", `Requests: ${count(requests.completed)}/${count(requests.total)} completed, ${count(requests.active)} active, ${count(requests.status_4xx)} 4xx, ${count(requests.status_5xx)} 5xx, ${count(requests.aborted)} aborted`),
    status("info", `Responses stream: TTFT avg ${latency(performance.ttft_ms?.avg)} (${count(performance.ttft_ms?.samples)} samples), TPOT avg ${tpot(performance.tpot_us)}`),
    status("info", `Admission: ${count(admission.activeRequests)} active, ${count(admission.queued)} queued, ${count(admission.rejected)} rejected, ${count(admission.timedOut)} timed out, wait avg ${latency(admission.waitMsAvg)}`),
    status("info", `Memory: RSS ${mebibytes(processStats.rss_bytes)}, heap ${mebibytes(processStats.heap_used_bytes)}`),
    status("info", `History: ${mebibytes(history.bytes)} / ${mebibytes(limits.response_history_max_bytes)}, ${count(history.entries)} entries, ${count(history.evicted)} evicted`),
    status("info", `Image cache: ${count(images.cache_entries)} entries, ${cacheHitRate(images)} hits, ${mebibytes(images.cache_bytes)} / ${mebibytes(images.cache_max_bytes)}`),
    status("info", `Models: ${count(models.models)} total, ${count(models.claude_models)} Claude; Copilot token ${copilot.token_cached ? `cached (${duration(copilot.token_expires_in_ms)} remaining)` : "not cached"}`),
    status("info", `Limits: request body ${mebibytes(limits.max_body_bytes)}, decoded body ${mebibytes(limits.max_decoded_body_bytes)}`),
  ].join("\n");
}
