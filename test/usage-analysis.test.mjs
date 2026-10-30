import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { analyzeUsageLogs } from "../src/usage-analysis.mjs";
import { summarizeUsageLogs } from "../src/usage-store.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-usage-analysis-"));
  const file = path.join(directory, "usage.jsonl");
  const oldRead = fs.createReadStream;
  const oldNow = Date.now;
  let reads = 0;
  fs.createReadStream = (...args) => { reads++; return oldRead(...args); };
  Date.now = () => oldNow() + 3000;
  t.after(() => { Date.now = oldNow; fs.createReadStream = oldRead; fs.rmSync(directory, { recursive: true, force: true }); });
  const now = Date.parse("2026-10-11T12:00:00Z");
  const row = (model = "gpt-test", ts = "2026-10-11T01:00:00Z") => JSON.stringify({ ts, model, usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 80 } }) + "\n";
  return { file, now, row, reads: () => reads, realTime: () => { Date.now = oldNow; } };
}

test("source filters isolate same-name models in both settled summaries and daily analytics", async t => {
  const f = fixture(t), legacy = JSON.parse(f.row("same-model"));
  const m365 = { ...legacy, provider: "m365", usage: { input_tokens: 20, output_tokens: 2, cached_input_tokens: 0 } };
  fs.writeFileSync(f.file, JSON.stringify(legacy) + "\n" + JSON.stringify(m365) + "\n");
  for (const provider of ["github", "m365", "github"]) {
    const result = await analyzeUsageLogs(f.file, { now: f.now, provider });
    const expected = provider === "github" ? 100 : 20;
    assert.equal(result.summary.requests, 1);assert.equal(result.summary.totals.input_tokens, expected);
    assert.equal(result.analytics.days.at(-1).input_tokens, expected);
    assert.equal((await summarizeUsageLogs(f.file, { provider })).totals.input_tokens, expected);
  }
  f.realTime();
  assert.equal((await summarizeUsageLogs(f.file, { provider: "m365" })).requests, 1, "unsettled files must still apply the filter");
  await assert.rejects(summarizeUsageLogs(f.file, { provider: "bad/provider" }), /provider/);
});

test("usage analysis shares one settled scan and returns independent bounded aggregates", async t => {
  const f = fixture(t); fs.writeFileSync(f.file, f.row());
  const results = await Promise.all(Array.from({ length: 4 }, () => analyzeUsageLogs(f.file, { now: f.now, timeZone: "Asia/Shanghai" })));
  assert.equal(f.reads(), 2);
  assert.equal(results[0].summary.requests, 1);
  assert.equal(results[0].analytics.days.at(-1).input_tokens, 100);
  results[0].analytics.days.at(-1).models[0].input_tokens = -1;
  results[0].summary.requests = -1;
  assert.equal((await analyzeUsageLogs(f.file, { now: f.now, timeZone: "Asia/Shanghai" })).analytics.days.at(-1).models[0].input_tokens, 100);
  assert.equal(f.reads(), 2);
});

test("active-log queries share only their in-flight scan and return isolated aggregates", async t => {
  const f = fixture(t);f.realTime();fs.writeFileSync(f.file, f.row());const options = { now: f.now, timeZone: "UTC" };
  const results = await Promise.all(Array.from({ length: 4 }, () => analyzeUsageLogs(f.file, options)));
  assert.equal(f.reads(), 2);results[0].summary.requests = -1;assert.equal(results[1].summary.requests, 1);
  await analyzeUsageLogs(f.file, options);assert.equal(f.reads(), 4, "Active results are not retained after settlement");
  fs.appendFileSync(f.file, f.row("next"));
  assert.equal((await analyzeUsageLogs(f.file, options)).summary.requests, 2);assert.equal(f.reads(), 6);
});

test("active summary reads coalesce and cancelled analytics do not poison another caller", async t => {
  const f = fixture(t);f.realTime();fs.writeFileSync(f.file, f.row());
  const values = await Promise.all(Array.from({ length: 4 }, () => summarizeUsageLogs(f.file)));
  assert.equal(f.reads(), 2);values[0].totals.input_tokens = -1;assert.equal(values[1].totals.input_tokens, 100);
  const controller = new AbortController(), reason = Error("fixture cancelled");controller.abort(reason);
  const aborted = analyzeUsageLogs(f.file, { now: f.now, signal: controller.signal });
  const good = analyzeUsageLogs(f.file, { now: f.now });
  await assert.rejects(aborted, error => error === reason);assert.equal((await good).summary.requests, 1);
});

test("active reads keep source filters and file replacements separate", async t => {
  const f = fixture(t);f.realTime();const github = JSON.parse(f.row()), m365 = { ...github, provider: "m365", model: "company", usage: { input_tokens: 20 } };
  fs.writeFileSync(f.file, JSON.stringify(github) + "\n" + JSON.stringify(m365) + "\n");
  const rows = await Promise.all(["github", "m365", "github", "m365"].map(provider => analyzeUsageLogs(f.file, { now: f.now, provider })));
  assert.deepEqual(rows.map(row => row.summary.totals.input_tokens), [100, 20, 100, 20]);assert.equal(f.reads(), 4);
  fs.writeFileSync(f.file + ".tmp", f.row("replacement"));fs.renameSync(f.file + ".tmp", f.file);
  const replaced = await analyzeUsageLogs(f.file, { now: f.now });assert.ok(replaced.summary.byModel.replacement);assert.equal(replaced.summary.byModel.company, undefined);
});

test("an active query for a replacement file never joins an older in-flight scan", async t => {
  const f = fixture(t);f.realTime();fs.writeFileSync(f.file, f.row("before"));
  const original = fs.createReadStream, held = new PassThrough();let intercepted = false, began;
  const started = new Promise(resolve => { began = resolve; });
  fs.createReadStream = (...args) => {
    if (args[0] !== f.file || intercepted) return original(...args);
    intercepted = true;setImmediate(() => { held.emit("open");began(); });return held;
  };
  const first = analyzeUsageLogs(f.file, { now: f.now });let timer;
  try {
    await started;
    fs.writeFileSync(f.file + ".tmp", f.row("after"));fs.renameSync(f.file + ".tmp", f.file);
    const second = await Promise.race([analyzeUsageLogs(f.file, { now: f.now }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Replacement query joined a stale scan")), 3000); })]);
    assert.ok(second.summary.byModel.after);assert.equal(second.summary.byModel.before, undefined);
    held.end(f.row("before"));assert.ok((await first).summary.byModel.before);
  } finally { clearTimeout(timer);held.end();await first.catch(() => {});fs.createReadStream = original; }
});

test("analysis invalidates append, rewrite, replacement, truncation, rotation and removal", async t => {
  const f = fixture(t); fs.writeFileSync(f.file, f.row("first"));
  const options = { now: f.now };
  await analyzeUsageLogs(f.file, options);
  fs.appendFileSync(f.file, f.row("second"));
  assert.equal((await analyzeUsageLogs(f.file, options)).summary.requests, 2);
  const oldStamp = fs.statSync(f.file).mtime;
  fs.writeFileSync(f.file, f.row("other") + f.row("second")); fs.utimesSync(f.file, oldStamp, oldStamp);
  assert.equal((await analyzeUsageLogs(f.file, options)).summary.byModel.first, undefined);
  fs.writeFileSync(f.file + ".tmp", f.row("replacement")); fs.renameSync(f.file + ".tmp", f.file);
  assert.ok((await analyzeUsageLogs(f.file, options)).summary.byModel.replacement);
  fs.renameSync(f.file, f.file + ".1"); fs.writeFileSync(f.file, f.row("new"));
  assert.equal((await analyzeUsageLogs(f.file, options)).summary.requests, 2);
  fs.writeFileSync(f.file, ""); assert.equal((await analyzeUsageLogs(f.file, options)).summary.requests, 1);
  fs.unlinkSync(f.file + ".1"); assert.equal((await analyzeUsageLogs(f.file, options)).summary.requests, 0);
});

test("analysis keys separate time zones, midnight and bounded recent choices", async t => {
  const f = fixture(t); fs.writeFileSync(f.file, f.row());
  const options = { now: f.now };
  const utc = await analyzeUsageLogs(f.file, { ...options, timeZone: "UTC" });
  const la = await analyzeUsageLogs(f.file, { ...options, timeZone: "America/Los_Angeles" });
  assert.equal(utc.analytics.days.at(-1).requests, 1);
  assert.equal(la.analytics.days.at(-2).requests, 1);
  const before = f.reads(); await analyzeUsageLogs(f.file, { ...options, timeZone: "UTC" }); assert.equal(f.reads(), before);
  await analyzeUsageLogs(f.file, { ...options, timeZone: "Asia/Tokyo" });
  await analyzeUsageLogs(f.file, { ...options, timeZone: "UTC" }); assert.ok(f.reads() > before);
  const next = await analyzeUsageLogs(f.file, { now: f.now + 86400000, timeZone: "UTC" });
  assert.equal(next.analytics.to, "2026-10-12");
  assert.equal(next.analytics.days.at(-1).requests, 0);
  await assert.rejects(analyzeUsageLogs(f.file, { timeZone: "invalid" }));
});

test("warnings, future records, oversized aggregates, fresh files and read errors remain uncached", async t => {
  const f = fixture(t); const options = { now: f.now };
  const oldError = console.error; let warnings = 0; console.error = () => { warnings++; };
  t.after(() => { console.error = oldError; });
  fs.writeFileSync(f.file, "invalid\n" + f.row());
  await analyzeUsageLogs(f.file, options); await analyzeUsageLogs(f.file, options); assert.equal(warnings, 2);
  fs.writeFileSync(f.file, f.row("future", "2026-10-11T13:00:00Z"));
  await analyzeUsageLogs(f.file, options); const futureReads = f.reads();
  await analyzeUsageLogs(f.file, options); assert.equal(f.reads(), futureReads + 2);
  fs.writeFileSync(f.file, f.row("x".repeat(2 * 1024 * 1024)));
  await analyzeUsageLogs(f.file, options); const largeReads = f.reads();
  await analyzeUsageLogs(f.file, options); assert.equal(f.reads(), largeReads + 2);
  fs.writeFileSync(f.file, f.row()); f.realTime();
  await analyzeUsageLogs(f.file, options); const freshReads = f.reads();
  await analyzeUsageLogs(f.file, options); assert.equal(f.reads(), freshReads + 2);
  fs.rmSync(f.file); fs.mkdirSync(f.file); await assert.rejects(analyzeUsageLogs(f.file, options));
});

test("custom warnings and changes during scans cannot retain a reusable clean snapshot", async t => {
  const f = fixture(t); fs.writeFileSync(f.file, f.row());
  await analyzeUsageLogs(f.file, { now: f.now, warn() {} });
  const before = f.reads(); await analyzeUsageLogs(f.file, { now: f.now, warn() {} });
  assert.equal(f.reads(), before + 2);
  const read = fs.createReadStream;
  let changed = false;
  fs.createReadStream = (...args) => {
    const stream = read(...args);
    if (args[0] === f.file && !changed) stream.once("open", () => { changed = true; fs.appendFileSync(f.file, f.row("added")); });
    return stream;
  };
  await analyzeUsageLogs(f.file, { now: f.now });
  const scanningReads = f.reads();
  assert.equal((await analyzeUsageLogs(f.file, { now: f.now })).summary.requests, 2);
  assert.equal(f.reads(), scanningReads + 2);
});
