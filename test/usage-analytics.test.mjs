import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createUsageAnalytics } from "../src/usage-analytics.mjs";
import { summarizeUsage, summarizeUsageLogs } from "../src/usage.mjs";

const now = Date.parse("2026-10-01T12:00:00Z");
const record = (ts, model = "gpt-6.1-sol", usage = { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, total_tokens: 110 }) => ({ ts, model, usage });
function collect(records, options = {}) {
  const analytics = createUsageAnalytics({ now, ...options });
  for (const row of records) analytics.record(row, summarizeUsage([row]));
  return analytics.snapshot();
}

test("daily analytics preserves token and cache semantics, timezone boundaries and missing history", () => {
  const data = collect([record("2026-09-29T16:00:00Z"), record("2026-09-30T16:00:00Z"), record("2026-10-01T10:00:00Z", "gpt-6-luna")], { timeZone: "Asia/Shanghai" });
  assert.equal(data.time_zone, "Asia/Shanghai");
  assert.equal(data.days.length, 365);
  assert.equal(data.to, "2026-10-01");
  assert.equal(data.first_date, "2026-09-30");
  assert.equal(data.days.at(-3).available, false);
  assert.equal(data.days.at(-2).requests, 1);
  const today = data.days.at(-1);
  assert.equal(today.requests, 2);
  assert.equal(today.input_tokens + today.output_tokens, 220);
  assert.equal(today.cache_read_tokens, 160);
  assert.equal(today.cache_hit_rate, .8);
  assert.equal(today.models.length, 2);
  assert.equal(today.total_tokens, 220);
});

test("calendar days remain contiguous across DST and zero usage differs from absent history", () => {
  const data = collect([record("2026-03-07T19:00:00Z")], { timeZone: "America/New_York", now: Date.parse("2026-03-10T12:00:00Z") });
  assert.deepEqual(data.days.slice(-4).map(({ date }) => date), ["2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"]);
  assert.equal(data.days.at(-5).available, false);
  assert.equal(data.days.at(-1).available, true);
  assert.equal(data.days.at(-1).requests, 0);
  assert.equal(data.days.at(-1).cache_hit_rate, null);
  assert.equal(collect([]).days.every(({ available }) => available === false), true);
});

test("analytics excludes invalid/future timestamps and marks partial or invalid token counts", () => {
  const data = collect([record("invalid"), record("2026-10-02T00:00:00Z"), record("2026-10-01T00:00:00Z", "unknown", { input_tokens: 10 }), record("2026-10-01T00:00:00Z", "bad", { input_tokens: -1, output_tokens: 5 })]);
  assert.equal(data.undated_records, 2);
  assert.equal(data.days.at(-1).requests, 2);
  assert.equal(data.days.at(-1).tokens_partial, true);
  assert.equal(data.days.at(-1).cache_hit_rate_partial, true);
  assert.equal(data.days.at(-1).input_tokens, 10);
  assert.equal(data.days.at(-1).output_tokens, 5);
  assert.throws(() => createUsageAnalytics({ timeZone: "Invalid/Zone" }), RangeError);
});

test("model detail is bounded while all-model counts retain every record", () => {
  const data = collect(Array.from({ length: 102 }, (_, index) => record("2026-10-01T00:00:00Z", `model-${index}`)));
  assert.equal(data.models.length, 100);
  assert.equal(data.models_truncated, true);
  assert.equal(data.days.at(-1).models.length, 100);
  assert.equal(data.days.at(-1).requests, 102);
  assert.equal(data.days.at(-1).total_tokens, 11220);
  const old = collect([record("2024-01-01T00:00:00Z")]);
  assert.equal(old.days[0].available, true);
  assert.equal(old.days.every(({ requests }) => requests === 0), true);
});

test("rotated and current logs feed analytics exactly once without changing the original summary", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-analytics-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "usage.jsonl");
  const rows = [record("2026-09-30T00:00:00Z"), record("2026-10-01T00:00:00Z")];
  fs.writeFileSync(`${file}.1`, `${JSON.stringify(rows[0])}\n`);
  fs.writeFileSync(file, `${JSON.stringify(rows[1])}\ninvalid\n`);
  const analytics = createUsageAnalytics({ now });
  let callbacks = 0;
  const summary = await summarizeUsageLogs(file, { warn() {}, onRecord(row, one) { callbacks += 1; analytics.record(row, one); } });
  assert.equal(callbacks, 2);
  assert.deepEqual(summary, summarizeUsage(rows));
  assert.deepEqual(summary, await summarizeUsageLogs(file, { warn() {} }));
  assert.equal(analytics.snapshot().days.reduce((sum, day) => sum + day.requests, 0), 2);
});
