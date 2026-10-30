import path from "node:path";
import fs from "node:fs/promises";
import { summarizeUsage, summarizeUsageLogs, usageLogPath, usageSummaryVersion, subscribeUsageAppends, usageProvider, mergeUsageSummary } from "./usage-store.mjs";
import { createUsageAnalytics } from "./usage-analytics.mjs";
import { createAbortAwareSingleflight } from "./bounded-result-cache.mjs";

const MAX_ENTRIES = 2;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_BYTES = 256 * 1024;
const cache = new Map(), activeReads = createAbortAwareSingleflight();
let unsubscribe;

async function completeLines(file) {
  for (const candidate of [file + ".1", file]) {
    let handle;
    try {
      handle = await fs.open(candidate, "r");const stat = await handle.stat();
      if (!stat.size) continue;
      const byte = Buffer.alloc(1);await handle.read(byte, 0, 1, stat.size - 1);
      if (byte[0] !== 10) return false;
    } catch (error) { if (error.code !== "ENOENT") return false; }
    finally { await handle?.close(); }
  }
  return true;
}

// Reuse only appends witnessed inside the writer's existing cross-process lock.
// External edits, another process's writes and rotations force the normal scan.
function appendOnly(before, after, bytes) {
  if (!before || !after) return false;
  const a = before.split("\0"), b = after.split("\0");
  if (a.length !== 2 || b.length !== 2 || a[0] !== b[0]) return false;
  const oldFiles = a[1].split("|"), nextFiles = b[1].split("|");
  if (oldFiles.length !== 2 || nextFiles.length !== 2 || oldFiles[0] !== nextFiles[0]) return false;
  const old = oldFiles[1].split(":"), next = nextFiles[1].split(":");
  return next.length === 5 && (oldFiles[1] === "missing" ? Number(next[2]) === bytes
    : old.length === 5 && old[0] === next[0] && old[1] === next[1] && Number(next[2]) === Number(old[2]) + bytes);
}
function prune() {
  let bytes = [...cache.values()].reduce((sum, e) => sum + e.bytes + e.pendingBytes, 0);
  for (const [key, entry] of cache) {
    if (bytes <= MAX_BYTES && cache.size <= MAX_ENTRIES) break;
    cache.delete(key);bytes -= entry.bytes + entry.pendingBytes;
  }
  if (!cache.size && unsubscribe) { unsubscribe();unsubscribe = null; }
}
function observe() {
  unsubscribe ||= subscribeUsageAppends(change => {
    for (const [key, entry] of cache) {
      if (entry.file !== change.filePath) continue;
      if (entry.version !== change.before || !appendOnly(change.before, change.after, change.bytes)
        || entry.pendingBytes + change.bytes > MAX_PENDING_BYTES) { cache.delete(key);continue; }
      entry.pending.push(...change.lines);entry.pendingBytes += change.bytes;entry.version = change.after;
    }
    prune();
  });
}

export async function analyzeUsageLogs(filePath = usageLogPath(), { timeZone = "UTC", now = Date.now(), warn = console.error, provider = "", signal } = {}) {
  const zone = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const file = path.resolve(filePath), query = `${file}\0${provider}\0${zone.resolvedOptions().timeZone}\0${zone.format(new Date(now))}`;
  const version = warn === console.error ? await usageSummaryVersion(file, { settled: false }) : null;
  const collect = async () => {
    const cached = version && cache.get(query);
    if (cached?.version === version) {
      cache.delete(query);cache.set(query, cached);
      cached.analytics.advanceTime(now);
      for (const line of cached.pending) {
        const record = JSON.parse(line);
        if (provider && provider !== usageProvider(record)) continue;
        const one = summarizeUsage([record]);mergeUsageSummary(cached.summary, one);cached.analytics.record(record, one);
      }
      cached.pending = [];cached.pendingBytes = 0;
      const result = { summary: cached.summary, analytics: cached.analytics.snapshot() };
      cached.bytes = Buffer.byteLength(JSON.stringify(result));
      if (result.analytics.undated_records > 0) cache.delete(query);
      prune();return result;
    }
    cache.delete(query);prune();
    const analytics = createUsageAnalytics({ timeZone, now, qualifyProviders: !provider });
    let warned = false;
    const summary = await summarizeUsageLogs(filePath, { provider, onRecord: analytics.record,
      warn(message) { warned = true;warn(message); } });
    const result = { summary, analytics: analytics.snapshot() };
    const complete = version && await completeLines(file);
    const after = version ? await usageSummaryVersion(file, { settled: false }) : null;
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (version && complete && after === version && !warned && !result.analytics.undated_records && bytes <= MAX_BYTES) {
      cache.set(query, { file, version, summary, analytics, bytes, pending: [], pendingBytes: 0 });observe();prune();
    }
    return result;
  };
  return structuredClone(await (version ? activeReads.run(`${version}\0${query}`, collect, { signal }) : collect()));
}
