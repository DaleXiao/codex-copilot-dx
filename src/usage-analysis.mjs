import { summarizeUsageLogs, usageLogPath, usageSummaryVersion } from "./usage-store.mjs";
import { createUsageAnalytics } from "./usage-analytics.mjs";

const MAX_ENTRIES = 2;
const MAX_BYTES = 2 * 1024 * 1024;
const cache = new Map();

// Only bounded, settled-file aggregates survive. No record index or payload cache.
export async function analyzeUsageLogs(filePath = usageLogPath(), { timeZone = "UTC", now = Date.now(), warn = console.error } = {}) {
  const analytics = createUsageAnalytics({ timeZone, now });
  const zone = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const version = warn === console.error ? await usageSummaryVersion(filePath) : null;
  const key = version === null ? null : `${version}\0${zone.resolvedOptions().timeZone}\0${zone.format(new Date(now))}`;
  if (key && cache.has(key)) return structuredClone(await cache.get(key).promise);
  if (key) {
    for (const [old, entry] of cache) if (entry.version !== version) cache.delete(old);
    while (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  } else cache.clear();
  const entry = { version, bytes: 0, promise: null };
  entry.promise = (async () => {
    let warned = false;
    const summary = await summarizeUsageLogs(filePath, {
      onRecord: analytics.record,
      warn(message) { warned = true; warn(message); },
    });
    const result = { summary, analytics: analytics.snapshot() };
    const after = key ? await usageSummaryVersion(filePath) : null;
    if (key && cache.get(key) === entry) {
      entry.bytes = Buffer.byteLength(JSON.stringify(result));
      if (warned || after !== version || entry.bytes > MAX_BYTES || result.analytics.undated_records > 0) cache.delete(key);
      else {
        let bytes = [...cache.values()].reduce((total, item) => total + item.bytes, 0);
        for (const [old, item] of cache) {
          if (bytes <= MAX_BYTES) break;
          cache.delete(old);
          bytes -= item.bytes;
        }
      }
    }
    return result;
  })();
  if (key) cache.set(key, entry);
  try { return structuredClone(await entry.promise); }
  catch (error) { if (cache.get(key) === entry) cache.delete(key); throw error; }
}
