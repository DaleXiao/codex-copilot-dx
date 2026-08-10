import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildAnthropicUsageRecord,
  buildResponsesUsageRecord,
  formatUsageSummary,
  flushUsageWritesForTests,
  printUsageSummary,
  readUsageRecords,
  recordUsage,
  summarizeUsage,
  summarizeUsageLogs,
} from "../src/usage.mjs";

test("buildResponsesUsageRecord: captures response and Copilot token usage", () => {
  const record = buildResponsesUsageRecord({
    surface: "responses",
    mode: "stream",
    event: {
      response: {
        id: "resp_1",
        model: "gpt-5.5",
        usage: {
          input_tokens: 100,
          output_tokens: 12,
          total_tokens: 112,
          input_tokens_details: { cached_tokens: 80 },
        },
      },
      copilot_usage: {
        token_details: [
          { token_type: "input", token_count: 20 },
          { token_type: "cache_read", token_count: 80 },
          { token_type: "output", token_count: 12 },
        ],
        total_nano_aiu: 123,
      },
    },
  });

  assert.equal(record.model, "gpt-5.5");
  assert.equal(record.response_id, "resp_1");
  assert.equal(record.usage.input_tokens, 100);
  assert.equal(record.usage.cached_input_tokens, 80);
  assert.equal(record.copilot_usage.cache_read_tokens, 80);
  assert.equal(record.copilot_usage.total_tokens, 112);
  assert.equal(record.copilot_usage.total_nano_aiu, 123);
});

test("recordUsage: rotates at the configured size and streaming summary includes both files", async () => {
  const oldPath = process.env.CCDX_USAGE_PATH;
  const oldMax = process.env.CCDX_USAGE_MAX_BYTES;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-usage-rotate-"));
  const filePath = path.join(dir, "usage.jsonl");
  process.env.CCDX_USAGE_PATH = filePath;
  process.env.CCDX_USAGE_MAX_BYTES = "180";
  try {
    await recordUsage({ ts: "2026-01-01T00:00:00.000Z", model: "a", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } });
    await recordUsage({ ts: "2026-01-01T00:00:01.000Z", model: "b", usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 } });
    await flushUsageWritesForTests();
    assert.equal(await fs.stat(`${filePath}.1`).then(() => true), true);
    const summary = await summarizeUsageLogs(filePath);
    assert.equal(summary.requests, 2);
    assert.equal(summary.totals.total_tokens, 12);
    assert.equal(summary.byModel.a.requests, 1);
    assert.equal(summary.byModel.b.requests, 1);
  } finally {
    if (oldPath === undefined) delete process.env.CCDX_USAGE_PATH;
    else process.env.CCDX_USAGE_PATH = oldPath;
    if (oldMax === undefined) delete process.env.CCDX_USAGE_MAX_BYTES;
    else process.env.CCDX_USAGE_MAX_BYTES = oldMax;
  }
});

test("buildResponsesUsageRecord: skips empty usage", () => {
  const record = buildResponsesUsageRecord({
    response: { id: "resp_1", model: "gpt-5.5", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
  });
  assert.equal(record, null);
});

test("buildAnthropicUsageRecord: totals Anthropic usage fields", () => {
  const record = buildAnthropicUsageRecord({
    mode: "json",
    model: "claude-sonnet-4.5",
    responseId: "msg_1",
    usage: { input_tokens: 7, cache_read_input_tokens: 30, output_tokens: 4 },
  });
  assert.equal(record.usage.input_tokens, 7);
  assert.equal(record.usage.cache_read_input_tokens, 30);
  assert.equal(record.usage.output_tokens, 4);
  assert.equal(record.usage.total_tokens, 41);
});

test("recordUsage: appends JSONL records to CCDX_USAGE_PATH", async () => {
  const oldPath = process.env.CCDX_USAGE_PATH;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-usage-"));
  process.env.CCDX_USAGE_PATH = path.join(dir, "usage.jsonl");
  try {
    await recordUsage({ ts: "2026-01-01T00:00:00.000Z", model: "m", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } });
    await flushUsageWritesForTests();
    const records = await readUsageRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].model, "m");
    assert.deepEqual(records[0].usage, { input_tokens: 1, output_tokens: 2, total_tokens: 3 });
  } finally {
    if (oldPath === undefined) delete process.env.CCDX_USAGE_PATH;
    else process.env.CCDX_USAGE_PATH = oldPath;
  }
});

test("summarizeUsage: aggregates totals and per-model rows", () => {
  const summary = summarizeUsage([
    { model: "a", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } },
    { model: "a", usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 } },
    { model: "b", usage: { output_tokens: 6, total_tokens: 6 } },
  ]);
  assert.equal(summary.requests, 3);
  assert.equal(summary.totals.input_tokens, 5);
  assert.equal(summary.totals.output_tokens, 13);
  assert.equal(summary.totals.total_tokens, 18);
  assert.equal(summary.byModel.a.requests, 2);
  assert.equal(summary.byModel.a.total_tokens, 12);
  assert.equal(summary.byModel.b.requests, 1);
});

test("formatUsageSummary: plain layout remains compatible and combines cache fields", () => {
  const summary = summarizeUsage([
    { model: "b", usage: { input_tokens: 4, cached_input_tokens: 2, output_tokens: 1, total_tokens: 5 } },
    { model: "a", usage: { input_tokens: 8, cache_read_input_tokens: 3, output_tokens: 2, total_tokens: 10 } },
  ]);
  assert.equal(formatUsageSummary(summary, {
    filePath: "/tmp/usage.jsonl",
    format: "plain",
    output: { isTTY: true, columns: 120 },
  }), [
    "Usage log: /tmp/usage.jsonl",
    "Requests: 2",
    "Tokens: input=12 cache_read=5 output=3 total=15",
    "",
    "By model:",
    "  b: requests=1 input=4 cache_read=2 output=1 total=5",
    "  a: requests=1 input=8 cache_read=3 output=2 total=10",
  ].join("\n"));
});

test("formatUsageSummary: auto uses a full table on a wide TTY and sorts models by total", () => {
  const summary = summarizeUsage([
    { model: "small", usage: { input_tokens: 2, cached_input_tokens: 1, output_tokens: 1, total_tokens: 3 } },
    { model: "large-b", usage: { input_tokens: 6, cache_read_input_tokens: 2, output_tokens: 4, total_tokens: 10 } },
    { model: "large-a", usage: { input_tokens: 7, cached_input_tokens: 3, output_tokens: 3, total_tokens: 10 } },
  ]);
  const output = formatUsageSummary(summary, {
    filePath: "/tmp/usage.jsonl",
    format: "auto",
    output: { isTTY: true, columns: 120 },
  });
  assert.match(output, /^Usage log: \/tmp\/usage\.jsonl\n\nMODEL\s+RECORDS\s+INPUT\s+CACHE READ\s+OUTPUT\s+TOTAL/m);
  assert.ok(output.indexOf("TOTAL") < output.indexOf("large-a"));
  assert.ok(output.indexOf("large-a") < output.indexOf("large-b"));
  assert.ok(output.indexOf("large-b") < output.indexOf("small"));
  assert.match(output, /TOTAL\s+3\s+15\s+6\s+8\s+23/);
});

test("formatUsageSummary: large totals still fit a standard 80-column terminal", () => {
  const summary = summarizeUsage([{
    model: "gpt-5.5-2026-04-23",
    usage: {
      input_tokens: 7_104_928_038,
      cached_input_tokens: 6_881_800_221,
      output_tokens: 21_566_984,
      total_tokens: 7_126_495_022,
    },
  }]);
  const output = formatUsageSummary(summary, {
    filePath: "/tmp/usage.jsonl",
    format: "auto",
    output: { isTTY: true, columns: 80 },
  });
  assert.match(output, /MODEL\s+RECORDS\s+INPUT\s+CACHE READ\s+OUTPUT\s+TOTAL/);
  assert.doesNotMatch(output, /Details:/);
});

test("formatUsageSummary: both formats combine cache fields and use dashes for missing values", () => {
  const summary = summarizeUsage([
    { model: "mixed", usage: { cached_input_tokens: 5, total_tokens: 5 } },
    { model: "mixed", usage: { cache_read_input_tokens: 7, total_tokens: 7 } },
    { model: "missing", usage: { output_tokens: 2, total_tokens: 2 } },
  ]);
  const output = formatUsageSummary(summary, {
    filePath: "/tmp/usage.jsonl",
    format: "table",
    output: { isTTY: false, columns: 120 },
  });
  assert.match(output, /mixed\s+2\s+—\s+12\s+—\s+12/);
  assert.match(output, /missing\s+1\s+—\s+—\s+2\s+2/);
  assert.match(formatUsageSummary(summary, {
    filePath: "/tmp/usage.jsonl",
    format: "plain",
    output: { isTTY: true, columns: 120 },
  }), /Tokens: input=0 cache_read=12 output=2 total=14/);
});

test("formatUsageSummary: auto keeps plain output when stdout is not a TTY", () => {
  const summary = summarizeUsage([{ model: "m", usage: { total_tokens: 1 } }]);
  const output = formatUsageSummary(summary, {
    filePath: "/tmp/usage.jsonl",
    format: "auto",
    output: { isTTY: false, columns: 120 },
  });
  assert.match(output, /^Usage log: \/tmp\/usage\.jsonl\nRequests: 1\nTokens:/);
  assert.doesNotMatch(output, /MODEL\s+RECORDS/);
});

test("formatUsageSummary: compact table preserves totals and appends omitted token details", () => {
  const summary = summarizeUsage([
    { model: "wide-model-name", usage: { input_tokens: 123456, cached_input_tokens: 100000, output_tokens: 789, total_tokens: 124245 } },
  ]);
  const output = formatUsageSummary(summary, {
    filePath: "/tmp/usage.jsonl",
    format: "table",
    output: { isTTY: true, columns: 48 },
  });
  assert.match(output, /MODEL\s+RECORDS\s+TOTAL/);
  assert.doesNotMatch(output, /CACHE READ/);
  assert.match(output, /wide-model-name\s+1\s+124,245/);
  assert.match(output, /Details:/);
  assert.match(output, /wide-model-name: input=123,456 cache_read=100,000 output=789/);
});

test("formatUsageSummary: auto falls back to plain when even the compact table cannot fit", () => {
  const summary = summarizeUsage([{ model: "very-long-model-name\u001b[2J\n[OK] injected", usage: { total_tokens: 1 } }]);
  const output = formatUsageSummary(summary, {
    filePath: "/tmp/usage.jsonl",
    format: "auto",
    output: { isTTY: true, columns: 8 },
  });
  assert.match(output, /^Usage log: \/tmp\/usage\.jsonl\nRequests: 1\nTokens:/);
  assert.doesNotMatch(output, /MODEL\s+RECORDS/);
  assert.doesNotMatch(output, /\u001b/);
  assert.doesNotMatch(output, /\n\[OK\] injected/);
  assert.match(output, /very-long-model-name \[OK\] injected/);
});

test("formatUsageSummary: empty table mode preserves the existing empty state", () => {
  assert.equal(formatUsageSummary(summarizeUsage([]), {
    filePath: "/tmp/usage.jsonl",
    format: "table",
    output: { isTTY: true, columns: 120 },
  }), "Usage log: /tmp/usage.jsonl\nNo usage records yet.");
});

test("printUsageSummary: uses the injected output only for format selection", async () => {
  const filePath = path.join(os.tmpdir(), `ccdx-usage-missing-${process.pid}-${Date.now()}.jsonl`);
  let logged = "";
  await printUsageSummary({
    filePath,
    format: "auto",
    output: { isTTY: true, columns: 80 },
    log(value) { logged = value; },
  });
  assert.equal(logged, `Usage log: ${filePath}\nNo usage records yet.`);
});
