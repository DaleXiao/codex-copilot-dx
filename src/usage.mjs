import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { parseByteLimit, rotateFileIfNeededSync, rotatedFilePath } from "./file-rotation.mjs";

const DEFAULT_USAGE_PATH = path.join(os.homedir(), ".local", "share", "codex-copilot-dx", "usage.jsonl");
const DEFAULT_USAGE_MAX_BYTES = 32 * 1024 * 1024;

let writeQueue = Promise.resolve();

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
  const out = compactObject({
    input_tokens: positiveNumber(usage.input_tokens),
    cached_input_tokens: positiveNumber(usage.cached_input_tokens ?? usage.input_tokens_details?.cached_tokens),
    output_tokens: positiveNumber(usage.output_tokens),
    reasoning_output_tokens: positiveNumber(usage.reasoning_output_tokens ?? usage.output_tokens_details?.reasoning_tokens),
    total_tokens: positiveNumber(usage.total_tokens),
  });
  if (out.total_tokens === undefined && (out.input_tokens !== undefined || out.output_tokens !== undefined)) {
    out.total_tokens = (out.input_tokens || 0) + (out.output_tokens || 0);
  }
  return hasPositiveTokenValue(out) ? out : undefined;
}

function normalizeAnthropicUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const out = compactObject({
    input_tokens: positiveNumber(usage.input_tokens),
    cache_read_input_tokens: positiveNumber(usage.cache_read_input_tokens),
    cache_creation_input_tokens: positiveNumber(usage.cache_creation_input_tokens),
    output_tokens: positiveNumber(usage.output_tokens),
  });
  if (out.input_tokens !== undefined || out.cache_read_input_tokens !== undefined || out.cache_creation_input_tokens !== undefined || out.output_tokens !== undefined) {
    out.total_tokens = (out.input_tokens || 0) + (out.cache_read_input_tokens || 0) + (out.cache_creation_input_tokens || 0) + (out.output_tokens || 0);
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

export function buildAnthropicUsageRecord({ surface = "messages", mode, model, responseId, usage } = {}) {
  const normalized = normalizeAnthropicUsage(usage);
  if (!normalized) return null;
  return compactObject({
    ts: new Date().toISOString(),
    surface,
    mode,
    model,
    response_id: responseId,
    usage: normalized,
  });
}

export function recordUsage(record) {
  if (!record || process.env.CCDX_DISABLE_USAGE === "1") return Promise.resolve();
  const filePath = usageLogPath();
  const line = `${JSON.stringify(record)}\n`;
  writeQueue = writeQueue
    .catch(() => {})
    .then(async () => {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      rotateFileIfNeededSync(filePath, Buffer.byteLength(line), usageLogMaxBytes());
      await fs.promises.appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
    })
    .catch((e) => console.error(`codex-copilot-dx usage log write failed: ${e.message}`));
  return writeQueue;
}

export function recordResponsesUsage(args) {
  return recordUsage(buildResponsesUsageRecord(args));
}

export function recordAnthropicUsage(args) {
  return recordUsage(buildAnthropicUsageRecord(args));
}

export async function flushUsageWritesForTests() {
  await writeQueue;
}

export async function flushUsageWrites() {
  await writeQueue;
}

async function* iterateUsageRecords(filePath) {
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
  for await (const line of lines) {
    if (line) yield JSON.parse(line);
  }
}

export async function readUsageRecords(filePath = usageLogPath()) {
  const records = [];
  for await (const record of iterateUsageRecords(filePath)) records.push(record);
  return records;
}

function addUsageTotals(target, usage = {}) {
  for (const [key, value] of Object.entries(usage)) {
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
  }
  return summary;
}

export async function summarizeUsageLogs(filePath = usageLogPath()) {
  const summary = { requests: 0, totals: {}, byModel: {} };
  for (const candidate of [rotatedFilePath(filePath), filePath]) {
    for await (const record of iterateUsageRecords(candidate)) {
      const one = summarizeUsage([record]);
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

function fmt(n) {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "0";
}

export async function printUsageSummary() {
  const summary = await summarizeUsageLogs();
  console.log(`Usage log: ${usageLogPath()}`);
  if (summary.requests === 0) {
    console.log("No usage records yet.");
    return;
  }
  console.log(`Requests: ${fmt(summary.requests)}`);
  console.log(`Tokens: input=${fmt(summary.totals.input_tokens)} cache_read=${fmt(summary.totals.cache_read_input_tokens || summary.totals.cached_input_tokens)} output=${fmt(summary.totals.output_tokens)} total=${fmt(summary.totals.total_tokens)}`);
  console.log("\nBy model:");
  for (const [model, row] of Object.entries(summary.byModel)) {
    console.log(`  ${model}: requests=${fmt(row.requests)} input=${fmt(row.input_tokens)} cache_read=${fmt(row.cache_read_input_tokens || row.cached_input_tokens)} output=${fmt(row.output_tokens)} total=${fmt(row.total_tokens)}`);
  }
}
