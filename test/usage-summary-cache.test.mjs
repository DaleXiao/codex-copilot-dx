import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { summarizeUsageLogs } from "../src/usage.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-summary-cache-"));
  const file = path.join(dir, "usage.jsonl");
  const originalRead = fs.createReadStream;
  const originalNow = Date.now;
  let reads = 0;
  fs.createReadStream = (...args) => { reads += 1; return originalRead(...args); };
  // Test settled-file reuse without waiting for the coarse-clock guard in every case.
  Date.now = () => originalNow() + 3000;
  t.after(() => { fs.createReadStream = originalRead; Date.now = originalNow; fs.rmSync(dir, { recursive: true, force: true }); });
  const row = (model) => JSON.stringify({ model, usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20 } }) + "\n";
  return { file, row, reads: () => reads, realTime: () => { Date.now = originalNow; } };
}

test("settled summaries share concurrent reads and return independent copies", async (t) => {
  const f = fixture(t); fs.writeFileSync(f.file, f.row("gpt-6-astra"));
  const results = await Promise.all(Array.from({ length: 4 }, () => summarizeUsageLogs(f.file)));
  assert.equal(f.reads(), 2); // Rotated file (missing) plus current file, once.
  results[0].totals.input_tokens = -1;
  results[0].byModel["gpt-6-astra"].requests = -1;
  const hit = await summarizeUsageLogs(f.file);
  assert.equal(hit.totals.input_tokens, 100);
  assert.equal(hit.byModel["gpt-6-astra"].requests, 1);
  assert.equal(f.reads(), 2);
});

test("append, replacement, same-size rewrite, truncation and rotation invalidate summaries", async (t) => {
  const f = fixture(t); fs.writeFileSync(f.file, f.row("gpt-a"));
  assert.equal((await summarizeUsageLogs(f.file)).requests, 1);
  fs.appendFileSync(f.file, f.row("gpt-b"));
  assert.equal((await summarizeUsageLogs(f.file)).requests, 2);
  const oldTime = fs.statSync(f.file).mtime;
  fs.writeFileSync(f.file, f.row("gpt-c") + f.row("gpt-d"));
  fs.utimesSync(f.file, oldTime, oldTime);
  const rewrite = await summarizeUsageLogs(f.file);
  assert.ok(rewrite.byModel["gpt-c"]);
  assert.equal(rewrite.byModel["gpt-a"], undefined);
  const replacement = `${f.file}.tmp`; fs.writeFileSync(replacement, f.row("gpt-e")); fs.renameSync(replacement, f.file);
  assert.ok((await summarizeUsageLogs(f.file)).byModel["gpt-e"]);
  fs.renameSync(f.file, `${f.file}.1`); fs.writeFileSync(f.file, f.row("gpt-f"));
  assert.equal((await summarizeUsageLogs(f.file)).requests, 2);
  fs.writeFileSync(f.file, "");
  assert.equal((await summarizeUsageLogs(f.file)).requests, 1);
  fs.unlinkSync(`${f.file}.1`);
  assert.equal((await summarizeUsageLogs(f.file)).requests, 0);
});

test("callbacks and custom warnings retain the original uncached contract", async (t) => {
  const f = fixture(t); fs.writeFileSync(f.file, f.row("gpt-6-astra"));
  const expected = await summarizeUsageLogs(f.file);
  let callbacks = 0;
  const before = f.reads();
  assert.deepEqual(await summarizeUsageLogs(f.file, { onRecord() { callbacks += 1; } }), expected);
  assert.deepEqual(await summarizeUsageLogs(f.file, { warn() {} }), expected);
  assert.equal(callbacks, 1);
  assert.equal(f.reads(), before + 4);
});

test("fresh files, oversized summaries and read failures do not become reusable cache entries", async (t) => {
  const f = fixture(t); fs.writeFileSync(f.file, f.row("gpt-6-astra")); f.realTime();
  await summarizeUsageLogs(f.file); const freshReads = f.reads(); await summarizeUsageLogs(f.file);
  assert.equal(f.reads(), freshReads + 2);
  const now = Date.now; Date.now = () => now() + 3000;
  fs.writeFileSync(f.file, f.row("gpt-" + "x".repeat(300 * 1024)));
  assert.equal((await summarizeUsageLogs(f.file)).requests, 1);
  const largeReads = f.reads(); await summarizeUsageLogs(f.file);
  assert.equal(f.reads(), largeReads + 2);
  fs.rmSync(f.file); fs.mkdirSync(f.file);
  await assert.rejects(summarizeUsageLogs(f.file));
  fs.rmdirSync(f.file); fs.writeFileSync(f.file, f.row("gpt-fixed"));
  assert.ok((await summarizeUsageLogs(f.file)).byModel["gpt-fixed"]);
});

test("warnings and changes during a scan do not become cached clean snapshots", async (t) => {
  const f = fixture(t);
  const originalError = console.error;
  let warnings = 0;
  console.error = () => { warnings += 1; };
  t.after(() => { console.error = originalError; });
  fs.writeFileSync(f.file, "invalid\n" + f.row("gpt-a"));
  await summarizeUsageLogs(f.file); await summarizeUsageLogs(f.file);
  assert.equal(warnings, 2);
  fs.writeFileSync(f.file, f.row("gpt-a"));
  const read = fs.createReadStream;
  let changed = false;
  fs.createReadStream = (...args) => {
    const stream = read(...args);
    if (args[0] === f.file && !changed) stream.once("open", () => {
      changed = true; fs.appendFileSync(f.file, f.row("gpt-b"));
    });
    return stream;
  };
  await summarizeUsageLogs(f.file);
  const before = f.reads();
  assert.equal((await summarizeUsageLogs(f.file)).requests, 2);
  assert.equal(f.reads(), before + 2);
});
