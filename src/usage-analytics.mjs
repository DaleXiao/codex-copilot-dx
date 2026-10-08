import { cacheReadTokens, usageCacheHitRate } from "./usage-store.mjs";

const DAY_MS = 86400000;
const DAYS = 365;
const MAX_MODELS = 100;
const TOKEN_FIELDS = ["input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "cache_read_input_tokens", "cache_hit_unknown_requests", "cache_hit_invalid_requests"];

export function createUsageAnalytics({ timeZone = "UTC", now = Date.now() } = {}) {
  const formatter = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const today = formatter.format(new Date(now));
  const end = Date.parse(`${today}T00:00:00Z`);
  const start = end - (DAYS - 1) * DAY_MS;
  const from = new Date(start).toISOString().slice(0, 10);
  const dates = new Map();
  const models = new Set();
  let first = Infinity;
  let last = -Infinity;
  let undated = 0;
  let modelsTruncated = false;

  function add(target, values) {
    target.requests += 1;
    for (const key of TOKEN_FIELDS) {
      if (Number.isFinite(values[key]) && values[key] >= 0) target[key] = (target[key] || 0) + values[key];
    }
    if (!Number.isFinite(values.input_tokens) || values.input_tokens < 0 || !Number.isFinite(values.output_tokens) || values.output_tokens < 0) target.tokens_partial = true;
  }

  function row(values = {}) {
    return {
      requests: values.requests || 0,
      input_tokens: values.input_tokens || 0,
      output_tokens: values.output_tokens || 0,
      total_tokens: values.total_tokens ?? (values.input_tokens || 0) + (values.output_tokens || 0),
      cache_read_tokens: cacheReadTokens(values) ?? null,
      cache_hit_rate: usageCacheHitRate(values),
      cache_hit_rate_partial: values.cache_hit_unknown_requests > 0,
      tokens_partial: values.tokens_partial === true || values.cache_hit_invalid_requests > 0,
    };
  }

  return {
    record(record, summary) {
      const timestamp = typeof record.ts === "string" ? Date.parse(record.ts) : NaN;
      if (!Number.isFinite(timestamp) || timestamp > now) { undated += 1; return; }
      first = Math.min(first, timestamp);
      last = Math.max(last, timestamp);
      if (timestamp < start - 2 * DAY_MS) return;
      const date = formatter.format(new Date(timestamp));
      if (date < from || date > today) return;
      let point = dates.get(date);
      if (!point) { point = { requests: 0, byModel: new Map() }; dates.set(date, point); }
      add(point, summary.totals);
      const model = String(record.model || "unknown").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 100);
      if (!models.has(model) && models.size >= MAX_MODELS) { modelsTruncated = true; return; }
      models.add(model);
      if (!point.byModel.has(model)) point.byModel.set(model, { requests: 0 });
      add(point.byModel.get(model), summary.totals);
    },
    snapshot() {
      const firstDate = Number.isFinite(first) ? formatter.format(new Date(first)) : null;
      const days = Array.from({ length: DAYS }, (_, index) => {
        const date = new Date(start + index * DAY_MS).toISOString().slice(0, 10);
        const point = dates.get(date);
        return {
          date,
          available: firstDate !== null && date >= firstDate,
          ...row(point),
          models: point ? [...point.byModel].map(([model, values]) => ({ model, ...row(values) })) : [],
        };
      });
      return { time_zone: formatter.resolvedOptions().timeZone, from, to: today, first_date: firstDate,
        last_date: Number.isFinite(last) ? formatter.format(new Date(last)) : null,
        undated_records: undated, models_truncated: modelsTruncated, models: [...models].sort(), days };
    },
  };
}
