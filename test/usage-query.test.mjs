import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUsageQuery } from "../src/usage-query.mjs";
import { analyzeUsageLogs } from "../src/usage-analysis.mjs";
import { summarizeUsageLogs } from "../src/usage-store.mjs";

const now = Date.parse("2026-11-12T21:00:00Z");
const record = (provider, model, ts, input = 10) => ({ provider, model, ts, usage: { input_tokens: input, output_tokens: 2, total_tokens: input + 2, cached_input_tokens: 0 } });

test("usage selection uses calendar dates in its explicit zone and keeps source-qualified models distinct", () => {
  const query = createUsageQuery({ now, days: "1", timeZone: "Asia/Shanghai", model: "google / gemini-test" });
  assert.equal(query.filters.from, "2026-11-13");
  assert.equal(query.matches(record("google", "gemini-test", "2026-11-12T16:00:00Z")), true);
  assert.equal(query.matches(record("google", "gemini-test", "2026-11-12T15:59:59Z")), false);
  assert.equal(query.matches(record("github", "gemini-test", "2026-11-12T16:00:00Z")), false);
  assert.equal(query.matches(record("google", "gemini-test", "2026-11-13T23:00:00Z")), false);
  assert.equal(createUsageQuery({ model: "gemini-test", now }).matches(record("github", "gemini-test", "invalid")), true, "All history retains legacy undated usage");
});

test("invalid usage dates, ranges, zones, sources and model inputs fail before log I/O", () => {
  for (const options of [{ days: "0" }, { days: "366" }, { days: "NaN" }, { from: "2026-02-30" }, { from: "2026-11-13", to: "2026-11-12" },
    { days: "7", from: "2026-11-01" }, { timeZone: "not/a-zone" }, { provider: "../private" }, { model: "bad\nmodel" }]) assert.throws(() => createUsageQuery({ now, ...options }));
});

test("filtered summaries, daily totals and older history agree without losing other model choices", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-usage-query-")), file = path.join(dir, "usage.jsonl");t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rows = [record("google", "gemini-test", "2026-11-12T18:00:00Z"), record("github", "gemini-test", "2026-11-12T18:00:00Z", 30),
    record("google", "gemini-other", "2026-11-12T18:00:00Z"), record("google", "gemini-test", "2024-01-01T00:00:00Z", 40)];
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const filtered = await analyzeUsageLogs(file, { now, model: "google / gemini-test", days: "1", timeZone: "Asia/Shanghai" });
  assert.equal(filtered.summary.requests, 1);assert.equal(filtered.summary.totals.input_tokens, 10);
  assert.equal(filtered.analytics.days.length, 1);assert.equal(filtered.analytics.days[0].requests, 1);assert.equal(filtered.analytics.days[0].cache_hit_rate, 0);
  assert.deepEqual(filtered.analytics.models, ["github / gemini-test", "google / gemini-other", "google / gemini-test"]);
  const all = await analyzeUsageLogs(file, { now });
  assert.equal(all.summary.requests, 4);assert.equal(all.analytics.earlier.requests, 1);
  assert.equal(all.analytics.days.reduce((sum, day) => sum + day.input_tokens, all.analytics.earlier.input_tokens), all.summary.totals.input_tokens);
  const selection = createUsageQuery({ now, from: "2026-11-13", to: "2026-11-13", provider: "google", timeZone: "Asia/Shanghai" });
  const cli = await summarizeUsageLogs(file, { provider: "google", recordFilter: selection.matches });
  const web = await analyzeUsageLogs(file, { now, from: "2026-11-13", to: "2026-11-13", provider: "google", timeZone: "Asia/Shanghai" });
  assert.deepEqual(web.summary, cli);assert.equal(web.summary.requests, 2);
  assert.deepEqual((await analyzeUsageLogs(file, { now, model: "absent" })).summary.requests, 0);
});
