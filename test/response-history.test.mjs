import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearResponseHistoryForTests,
  configureResponseHistoryForTests,
  responseHistoryStats,
} from "../src/response-history.mjs";
import { prepareResponsesRequest, rememberResponseHistory } from "../src/responses-request.mjs";

test("response history stores incremental nodes and enforces a byte budget", () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 500, maxEntries: 100 });

  const first = prepareResponsesRequest({ model: "gpt-5.5", input: "a".repeat(300) });
  rememberResponseHistory(first, {
    id: "resp_large",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "b".repeat(300) }] }],
  });

  assert.equal(responseHistoryStats().entries, 0);
  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "resp_large", input: "next" }),
    /was evicted after reaching the local history limit/,
  );
  clearResponseHistoryForTests();
});

test("oversized history entries do not evict unrelated conversations", () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 500, maxEntries: 100 });

  const small = prepareResponsesRequest({ model: "gpt-5.5", input: "small" });
  rememberResponseHistory(small, { id: "resp_small", output: [] });
  const large = prepareResponsesRequest({ model: "gpt-5.5", input: "x".repeat(600) });
  rememberResponseHistory(large, { id: "resp_large", output: [] });

  assert.equal(responseHistoryStats().entries, 1);
  assert.equal(
    prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "resp_small", input: "next" }).body.input.length,
    2,
  );
  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "resp_large", input: "next" }),
    /was evicted after reaching the local history limit/,
  );
  clearResponseHistoryForTests();
});

test("response history byte accounting matches serialized JSON", () => {
  clearResponseHistoryForTests();
  const prepared = prepareResponsesRequest({ model: "gpt-5.5", input: `quote=\" slash=\\ newline=\n unicode=é😀 lone=\ud800` });
  const output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }];
  rememberResponseHistory(prepared, { id: "resp_bytes", output });

  assert.equal(
    responseHistoryStats().bytes,
    Buffer.byteLength(JSON.stringify([prepared.historyInputItems, output])),
  );
  clearResponseHistoryForTests();
});

test("response history grows linearly across chained turns", () => {
  clearResponseHistoryForTests();
  let previousId = null;
  for (let i = 0; i < 20; i += 1) {
    const prepared = prepareResponsesRequest({
      model: "gpt-5.5",
      ...(previousId ? { previous_response_id: previousId } : {}),
      input: `turn-${i}`,
    });
    previousId = `resp_${i}`;
    rememberResponseHistory(prepared, {
      id: previousId,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `answer-${i}` }] }],
    });
  }

  const stats = responseHistoryStats();
  assert.equal(stats.entries, 20);
  assert.ok(stats.bytes < 20_000);
  const final = prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: previousId, input: "final" });
  assert.equal(final.body.input.length, 41);
  clearResponseHistoryForTests();
});

test("response history eviction removes descendants without affecting other roots", () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 1_000_000, maxEntries: 3 });

  const root = prepareResponsesRequest({ model: "gpt-5.5", input: "root" });
  rememberResponseHistory(root, { id: "resp_root", output: [] });
  const child = prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "resp_root", input: "child" });
  rememberResponseHistory(child, { id: "resp_child", output: [] });
  rememberResponseHistory(prepareResponsesRequest({ model: "gpt-5.5", input: "other" }), { id: "resp_other", output: [] });
  rememberResponseHistory(prepareResponsesRequest({ model: "gpt-5.5", input: "newer" }), { id: "resp_newer", output: [] });

  assert.equal(responseHistoryStats().entries, 2);
  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "resp_child", input: "next" }),
    /was evicted after reaching the local history limit/,
  );
  assert.equal(
    prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "resp_other", input: "next" }).body.input.length,
    2,
  );
  clearResponseHistoryForTests();
});

test("response history tree LRU treats successful materialization as recent use", () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 1_000_000, maxEntries: 2 });

  rememberResponseHistory(
    prepareResponsesRequest({ model: "gpt-5.6-sol", input: "active" }),
    { id: "resp_active", output: [] },
  );
  rememberResponseHistory(
    prepareResponsesRequest({ model: "gpt-5.6-sol", input: "idle" }),
    { id: "resp_idle", output: [] },
  );
  prepareResponsesRequest({ model: "gpt-5.6-sol", previous_response_id: "resp_active", input: "retry" });
  rememberResponseHistory(
    prepareResponsesRequest({ model: "gpt-5.6-sol", input: "new" }),
    { id: "resp_new", output: [] },
  );

  assert.equal(
    prepareResponsesRequest({ model: "gpt-5.6-sol", previous_response_id: "resp_active", input: "next" }).body.input.length,
    2,
  );
  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.6-sol", previous_response_id: "resp_idle", input: "next" }),
    /was evicted after reaching the local history limit/,
  );
  clearResponseHistoryForTests();
});

test("response history tree LRU keeps hard limits for a single oversized tree", () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 1_000_000, maxEntries: 2 });

  let previousId = null;
  for (let index = 0; index < 3; index += 1) {
    const prepared = prepareResponsesRequest({
      model: "gpt-5.6-sol",
      ...(previousId ? { previous_response_id: previousId } : {}),
      input: `turn-${index}`,
    });
    previousId = `resp_hard_limit_${index}`;
    rememberResponseHistory(prepared, { id: previousId, output: [] });
  }

  assert.equal(responseHistoryStats().entries, 0);
  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.6-sol", previous_response_id: previousId, input: "next" }),
    /was evicted after reaching the local history limit/,
  );
  clearResponseHistoryForTests();
});
