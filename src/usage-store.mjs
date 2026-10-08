import fs from "node:fs";
import { markRequestObservation } from "./stream-performance.mjs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { appendRotatingLines, parseByteLimit, rotatedFilePath } from "./file-rotation.mjs";
import { withFileLock } from "./lock.mjs";
import { terminalCell } from "./terminal-text.mjs";

const DEFAULT_USAGE_PATH = path.join(os.homedir(), ".local", "share", "codex-copilot-dx", "usage.jsonl");
const DEFAULT_USAGE_MAX_BYTES = 32 * 1024 * 1024;
const USAGE_WRITE_LOCK_TIMEOUT_MS = 1_000;
const USAGE_WRITE_LOCK_STALE_MS = 1_000;
const USAGE_WRITE_LOCK_POLL_MS = 5;
const USAGE_FLUSH_TIMEOUT_MS = 1_500;

const pendingWrites = [];
let writeDrain = null;
const USAGE_QUEUE_MAX_RECORDS = 4096;
const USAGE_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
let pendingRecords = 0;
let pendingBytes = 0;
let droppedRecords = 0;
let writeFailures = 0;

export function usageLoggingStats() {
  return { pending_records: pendingRecords, pending_bytes: pendingBytes, dropped_records: droppedRecords,
    write_failures: writeFailures, max_records: USAGE_QUEUE_MAX_RECORDS, max_bytes: USAGE_QUEUE_MAX_BYTES };
}

export function usageLogPath() {
  return process.env.CCDX_USAGE_PATH || DEFAULT_USAGE_PATH;
}

export function usageLogMaxBytes(env = process.env) {
  return parseByteLimit(env.CCDX_USAGE_MAX_BYTES, DEFAULT_USAGE_MAX_BYTES);
}

function numberOrUndefined(value) {
  return Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value) {
  const n = numberOrUndefined(value);
  return n && n > 0 ? n : undefined;
}

function compactObject(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

function hasPositiveTokenValue(usage) {
  return Object.entries(usage || {}).some(([k, v]) => k.endsWith("_tokens") && Number.isFinite(v) && v > 0);
}

function normalizeResponsesUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const cachedInput = numberOrUndefined(usage.cached_input_tokens ?? usage.input_tokens_details?.cached_tokens);
  const out = compactObject({
    input_tokens: positiveNumber(usage.input_tokens),
    cached_input_tokens: cachedInput >= 0 ? cachedInput : undefined,
    output_tokens: positiveNumber(usage.output_tokens),
    reasoning_output_tokens: positiveNumber(usage.reasoning_output_tokens ?? usage.output_tokens_details?.reasoning_tokens),
    total_tokens: positiveNumber(usage.total_tokens),
  });
  if (out.total_tokens === undefined && (out.input_tokens !== undefined || out.output_tokens !== undefined)) {
    out.total_tokens = (out.input_tokens || 0) + (out.output_tokens || 0);
  }
  return hasPositiveTokenValue(out) ? out : undefined;
}

function normalizeCopilotUsage(copilotUsage) {
  if (!copilotUsage || typeof copilotUsage !== "object") return undefined;
  const out = {};
  for (const detail of copilotUsage.token_details || []) {
    const tokens = positiveNumber(detail?.token_count);
    if (!tokens) continue;
    switch (detail.token_type) {
      case "input":
        out.input_tokens = (out.input_tokens || 0) + tokens;
        break;
      case "cache_read":
        out.cache_read_tokens = (out.cache_read_tokens || 0) + tokens;
        break;
      case "output":
        out.output_tokens = (out.output_tokens || 0) + tokens;
        break;
      default:
        out[`${detail.token_type || "unknown"}_tokens`] = (out[`${detail.token_type || "unknown"}_tokens`] || 0) + tokens;
        break;
    }
  }
  out.total_tokens = (out.input_tokens || 0) + (out.cache_read_tokens || 0) + (out.output_tokens || 0);
  if (Number.isFinite(copilotUsage.total_nano_aiu)) out.total_nano_aiu = copilotUsage.total_nano_aiu;
  return hasPositiveTokenValue(out) ? out : undefined;
}

export function buildResponsesUsageRecord({ surface = "responses", mode, model, response, event } = {}) {
  const responseObj = response || event?.response;
  const usage = normalizeResponsesUsage(responseObj?.usage);
  const copilotUsage = normalizeCopilotUsage(event?.copilot_usage || responseObj?.copilot_usage);
  if (!usage && !copilotUsage) return null;
  return compactObject({
    ts: new Date().toISOString(),
    surface,
    mode,
    model: responseObj?.model || model,
    response_id: responseObj?.id,
    usage,
    copilot_usage: copilotUsage,
  });
}

function takePendingWrites(filePath, maxBytes) {
  const batch = [];
  let retained = 0;
  for (const entry of pendingWrites) {
    if (entry.filePath === filePath && entry.maxBytes === maxBytes) batch.push(entry);
    else pendingWrites[retained++] = entry;
  }
  pendingWrites.length = retained;
  return batch;
}

async function writeUsageBatch(batch) {
  const { filePath, maxBytes } = batch[0];
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await withFileLock(`${path.resolve(filePath)}.lock`, async () => {
    batch.push(...takePendingWrites(filePath, maxBytes));
    await appendRotatingLines(filePath, batch.map(({ line }) => line), maxBytes);
  }, {
    timeoutMs: USAGE_WRITE_LOCK_TIMEOUT_MS,
    staleMs: USAGE_WRITE_LOCK_STALE_MS,
    pollMs: USAGE_WRITE_LOCK_POLL_MS,
  });
}

function scheduleUsageWriteDrain() {
  if (writeDrain) return;
  writeDrain = Promise.resolve().then(async () => {
    while (pendingWrites.length > 0) {
      const first = pendingWrites.shift();
      const batch = [first, ...takePendingWrites(first.filePath, first.maxBytes)];
      try {
        await writeUsageBatch(batch);
      } catch (error) {
        writeFailures += 1;
        batch.push(...takePendingWrites(first.filePath, first.maxBytes));
        console.error(`codex-copilot-dx usage log write failed: ${error.message}`);
      } finally {
        for (const entry of batch) {
          pendingRecords -= 1;
          pendingBytes -= entry.bytes;
          entry.resolve();
        }
      }
    }
  }).finally(() => {
    writeDrain = null;
    if (pendingWrites.length > 0) scheduleUsageWriteDrain();
  });
}

export function recordUsage(record) {
  if (!record || process.env.CCDX_DISABLE_USAGE === "1") return Promise.resolve();
  const filePath = usageLogPath();
  const line = `${JSON.stringify(record)}\n`;
  const bytes = Buffer.byteLength(line);
  if (pendingRecords >= USAGE_QUEUE_MAX_RECORDS || pendingBytes + bytes > USAGE_QUEUE_MAX_BYTES) {
    droppedRecords += 1;
    if (droppedRecords === 1) console.error("codex-copilot-dx usage queue is full; excess usage records are dropped, inference is unaffected (see ccdx status)");
    return Promise.resolve();
  }
  pendingRecords += 1;
  pendingBytes += bytes;
  const completed = new Promise((resolve) => {
    pendingWrites.push({ filePath, line, bytes, maxBytes: usageLogMaxBytes(), resolve });
  });
  scheduleUsageWriteDrain();
  return completed;
}

export function recordResponsesUsage(args) {
  const response = args.response || args.event?.response || args.event;
  markRequestObservation({ input_tokens: response?.usage?.input_tokens });
  return recordUsage(buildResponsesUsageRecord(args));
}

export async function flushUsageWritesForTests() {
  while (writeDrain || pendingWrites.length > 0) {
    if (writeDrain) await writeDrain;
    else scheduleUsageWriteDrain();
  }
}

export async function flushUsageWrites({
  timeoutMs = USAGE_FLUSH_TIMEOUT_MS,
  warn = console.error,
} = {}) {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? Math.floor(timeoutMs)
    : USAGE_FLUSH_TIMEOUT_MS;
  let timer;
  const completed = await Promise.race([
    flushUsageWritesForTests().then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeout); }),
  ]);
  if (timer) clearTimeout(timer);
  if (!completed) {
    try { warn(`codex-copilot-dx usage log flush timed out after ${timeout}ms`); } catch {}
  }
}

async function* iterateUsageRecords(filePath, { warn = console.error } = {}) {
  let input;
  try {
    input = fs.createReadStream(filePath, { encoding: "utf8" });
    await new Promise((resolve, reject) => {
      input.once("open", resolve);
      input.once("error", reject);
    });
  } catch (e) {
    input?.destroy();
    if (e?.code === "ENOENT") return;
    throw e;
  }

  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let invalidRecords = 0;
  for await (const line of lines) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        invalidRecords += 1;
        continue;
      }
      yield record;
    } catch {
      invalidRecords += 1;
    }
  }
  if (invalidRecords > 0) {
    try {
      const safePath = terminalCell(JSON.stringify(filePath));
      warn(`codex-copilot-dx usage log ignored ${invalidRecords} invalid record${invalidRecords === 1 ? "" : "s"} in ${safePath}`);
    } catch {}
  }
}

export async function readUsageRecords(filePath = usageLogPath(), { warn = console.error } = {}) {
  const records = [];
  for await (const record of iterateUsageRecords(filePath, { warn })) records.push(record);
  return records;
}

function addUsageTotals(target, usage = {}) {
  for (const [key, value] of Object.entries(usage || {})) {
    if (Number.isFinite(value)) target[key] = (target[key] || 0) + value;
  }
}

export function summarizeUsage(records) {
  const summary = { requests: 0, totals: {}, byModel: {} };
  for (const record of records) {
    summary.requests += 1;
    addUsageTotals(summary.totals, record.usage);
    if (record.copilot_usage) {
      summary.totals.copilot_total_tokens = (summary.totals.copilot_total_tokens || 0) + (record.copilot_usage.total_tokens || 0);
      summary.totals.total_nano_aiu = (summary.totals.total_nano_aiu || 0) + (record.copilot_usage.total_nano_aiu || 0);
    }
    const model = record.model || "unknown";
    if (!summary.byModel[model]) summary.byModel[model] = { requests: 0 };
    const modelTotals = summary.byModel[model];
    modelTotals.requests += 1;
    addUsageTotals(modelTotals, record.usage);
    const input = record.usage?.input_tokens;
    const cached = cacheReadTokens(record.usage || {});
    if (!Number.isFinite(input) || input < 0 || !Number.isFinite(cached) || cached < 0 || cached > input) {
      summary.totals.cache_hit_unknown_requests = (summary.totals.cache_hit_unknown_requests || 0) + 1;
      modelTotals.cache_hit_unknown_requests = (modelTotals.cache_hit_unknown_requests || 0) + 1;
    }
    const cacheCounts = [record.usage?.cached_input_tokens, record.usage?.cache_read_input_tokens];
    if ((input != null && (!Number.isFinite(input) || input < 0))
      || cacheCounts.some((value) => value != null && (!Number.isFinite(value) || value < 0))
      || (Number.isFinite(input) && Number.isFinite(cached) && cached > input)) {
      summary.totals.cache_hit_invalid_requests = (summary.totals.cache_hit_invalid_requests || 0) + 1;
      modelTotals.cache_hit_invalid_requests = (modelTotals.cache_hit_invalid_requests || 0) + 1;
    }
  }
  return summary;
}

async function summarizeUsageLogFiles(filePath, { warn = console.error, onRecord } = {}) {
  const summary = { requests: 0, totals: {}, byModel: {} };
  for (const candidate of [rotatedFilePath(filePath), filePath]) {
    for await (const record of iterateUsageRecords(candidate, { warn })) {
      const one = summarizeUsage([record]);
      onRecord?.(record, one);
      summary.requests += one.requests;
      addUsageTotals(summary.totals, one.totals);
      for (const [model, values] of Object.entries(one.byModel)) {
        if (!summary.byModel[model]) summary.byModel[model] = { requests: 0 };
        addUsageTotals(summary.byModel[model], values);
      }
    }
  }
  return summary;
}

const SUMMARY_CACHE_MAX_BYTES = 256 * 1024;
const SUMMARY_CACHE_SETTLED_MS = 2000;
let cachedSummary = null;

async function usageSummaryVersion(filePath) {
  try {
    const files = await Promise.all([rotatedFilePath(filePath), filePath].map(async (file) => {
      try {
        const stat = await fs.promises.stat(file, { bigint: true });
        if (!stat.isFile()) return null;
        const recent = Math.max(Number(stat.mtimeMs), Number(stat.ctimeMs));
        if (Date.now() - recent < SUMMARY_CACHE_SETTLED_MS) return null;
        return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
      } catch (error) {
        if (error?.code === "ENOENT") return "missing";
        throw error;
      }
    }));
    return files.some((version) => version === null) ? null : `${path.resolve(filePath)}\0${files.join("|")}`;
  } catch { return null; } // Uncacheable metadata never replaces the normal read/error path.
}

export async function summarizeUsageLogs(filePath = usageLogPath(), { warn = console.error, onRecord } = {}) {
  if (onRecord || warn !== console.error) return summarizeUsageLogFiles(filePath, { warn, onRecord });
  const version = await usageSummaryVersion(filePath);
  if (version === null) {
    cachedSummary = null;
    return summarizeUsageLogFiles(filePath, { warn });
  }
  if (cachedSummary?.version === version) return structuredClone(await cachedSummary.promise);
  const entry = { version, promise: null };
  cachedSummary = entry;
  entry.promise = (async () => {
    let warned = false;
    const summary = await summarizeUsageLogFiles(filePath, { warn(message) { warned = true; warn(message); } });
    const after = await usageSummaryVersion(filePath);
    const retain = !warned && after === version && Object.keys(summary.byModel).length <= 128
      && Buffer.byteLength(JSON.stringify(summary)) <= SUMMARY_CACHE_MAX_BYTES;
    if (!retain && cachedSummary === entry) cachedSummary = null;
    return summary;
  })();
  try { return structuredClone(await entry.promise); }
  catch (error) { if (cachedSummary === entry) cachedSummary = null; throw error; }
}

export function cacheReadTokens(usage = {}) {
  const values = [usage.cache_read_input_tokens, usage.cached_input_tokens]
    .filter((value) => Number.isFinite(value));
  const value = values.length > 0 ? values.reduce((total, current) => total + current, 0) : undefined;
  return Number.isFinite(value) ? value : undefined;
}

export function usageCacheHitRate(usage = {}) {
  const input = usage.input_tokens;
  const cached = cacheReadTokens(usage);
  if (usage.cache_hit_invalid_requests > 0 || !Number.isFinite(input) || input <= 0
    || !Number.isFinite(cached) || cached < 0 || cached > input) return null;
  return cached / input;
}
