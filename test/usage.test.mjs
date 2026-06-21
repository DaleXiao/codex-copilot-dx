import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildAnthropicUsageRecord,
  buildResponsesUsageRecord,
  flushUsageWritesForTests,
  readUsageRecords,
  recordUsage,
  summarizeUsage,
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
