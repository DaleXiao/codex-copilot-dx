import { createInterface } from "node:readline/promises";
import os from "node:os";
import { ADAPTER_CACHE_PATH } from "./cache-control.mjs";
import { MIB, RESPONSE_HISTORY_DEFAULT_MIB } from "./cache-limits.mjs";
import { adapterBaseUrl } from "./running-adapter.mjs";
import {
  readUserSettings,
  responseHistoryLimitPreference,
  writeResponseHistoryLimitMib,
} from "./user-settings.mjs";

const RESPONSE_HISTORY_MAX_MIB_KEY = "response_history_max_mib";

function mib(bytes) {
  const value = Number(bytes);
  return Number.isFinite(value) ? `${(value / MIB).toFixed(value % MIB === 0 ? 0 : 1)} MiB` : "unknown";
}

async function cacheRequest(baseUrl, { body, fetchImpl, timeoutMs }) {
  const response = await fetchImpl(`${baseUrl}${ADAPTER_CACHE_PATH}`, {
    method: body ? "POST" : "GET",
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let payload;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const error = new Error(payload?.error || `Cache control returned HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return payload;
}

async function runningSnapshot(baseUrl, options) {
  try { return { supported: true, data: await cacheRequest(baseUrl, options) }; }
  catch (error) {
    if ([404, 405].includes(error?.statusCode)) return { supported: false, error };
    if (error?.name === "TimeoutError" || error?.cause?.code === "ECONNREFUSED") return { supported: false, offline: true, error };
    throw error;
  }
}

async function confirmHistoryCleanup({ input, output, prompt, yes }) {
  if (yes) return;
  if (prompt) {
    if (!await prompt()) throw new Error("History cache cleanup cancelled");
    return;
  }
  if (!input.isTTY || !output.isTTY) {
    throw new Error("History cleanup can break task continuation; rerun with --yes to confirm");
  }
  const readline = createInterface({ input, output });
  try {
    const answer = String(await readline.question(
      "Clear response history for all tasks? Their next continuation may fail [y/N]: ",
    )).trim().toLowerCase();
    if (!["y", "yes"].includes(answer)) throw new Error("History cache cleanup cancelled");
  } finally { readline.close(); }
}

function formatStatus(preference, runtime) {
  const lines = ["ccdx cache", `Configured history limit: ${mib(preference.bytes)} (${preference.source})`];
  if (!runtime?.supported) {
    lines.push(runtime?.offline
      ? "Runtime cache: adapter is not running"
      : "Runtime cache: restart ccdx to enable cache control");
    return lines.join("\n");
  }
  const history = runtime.data.response_history || {};
  const images = runtime.data.image_optimization || {};
  lines.push(
    `History: ${mib(history.bytes)} / ${mib(history.maxBytes)}, ${history.entries || 0} entries, ${history.evicted || 0} evicted`,
    `Image transforms: ${mib(images.cache_bytes)} / ${mib(images.cache_max_bytes)}, ${images.cache_entries || 0} entries`,
  );
  return lines.join("\n");
}

export async function runCacheCommand({
  action = "status",
  limitMib,
  resetLimit = false,
  history = false,
  yes = false,
  env = process.env,
  home = os.homedir(),
  host = "127.0.0.1",
  port = 2026,
  input = process.stdin,
  output = process.stdout,
  prompt,
  fetchImpl = fetch,
  timeoutMs = 1000,
} = {}) {
  const baseUrl = adapterBaseUrl(host, port);
  const requestOptions = { fetchImpl, timeoutMs };
  const preference = responseHistoryLimitPreference({ env, home });
  const runtime = await runningSnapshot(baseUrl, requestOptions);
  if (action === "status") {
    const text = formatStatus(preference, runtime);
    output.write(`${text}\n`);
    return { preference, runtime };
  }
  if (action === "limit") {
    if (String(env.CCDX_RESPONSE_HISTORY_MAX_BYTES || "").trim()) {
      throw new Error("CCDX_RESPONSE_HISTORY_MAX_BYTES overrides saved cache settings; unset it before using ccdx cache --limit");
    }
    const targetMib = resetLimit ? RESPONSE_HISTORY_DEFAULT_MIB : Number(limitMib);
    const targetBytes = targetMib * MIB;
    if (runtime.supported && targetBytes < runtime.data.response_history.bytes) {
      throw new Error(`History currently uses ${mib(runtime.data.response_history.bytes)}; clean history or choose a larger limit`);
    }
    const previous = readUserSettings({ env, home, strict: true });
    const previousMib = Object.hasOwn(previous, RESPONSE_HISTORY_MAX_MIB_KEY)
      ? previous[RESPONSE_HISTORY_MAX_MIB_KEY]
      : null;
    const saved = writeResponseHistoryLimitMib(resetLimit ? null : targetMib, { env, home });
    try {
      if (runtime.supported) {
        await cacheRequest(baseUrl, { ...requestOptions, body: { action: "set_limit", max_bytes: targetBytes } });
      }
    } catch (error) {
      writeResponseHistoryLimitMib(previousMib, { env, home });
      throw error;
    }
    output.write(`History cache limit: ${targetMib} MiB${runtime.supported ? " (active now)" : " (saved; restart ccdx to apply)"}\n`);
    return { ...saved, active: runtime.supported };
  }
  if (action === "clean") {
    if (!runtime.supported) throw new Error("Start or restart ccdx before cleaning runtime caches");
    if (history) await confirmHistoryCleanup({ input, output, prompt, yes });
    const result = await cacheRequest(baseUrl, {
      ...requestOptions,
      body: { action: "clean", history },
    });
    const images = result.cleaned.image_optimization;
    output.write(`Cleared image transform cache: ${images.entries} entries, ${mib(images.bytes)}\n`);
    if (history) {
      const cleared = result.cleaned.response_history;
      output.write(`Cleared response history: ${cleared.entries} entries, ${mib(cleared.bytes)}\n`);
      output.write("Saved Codex transcripts and generated image files were not deleted.\n");
    }
    return result;
  }
  throw new Error(`Unknown cache action: ${action}`);
}
