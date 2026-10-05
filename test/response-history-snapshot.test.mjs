import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  acquireResponseHistorySnapshot,
  clearResponseHistoryForTests,
  configureResponseHistoryForTests,
  materializeResponseHistory,
  rememberResponseHistoryNode,
  responseHistoryStats,
} from "../src/response-history.mjs";
import { prepareResponsesRequest } from "../src/responses-request.mjs";

afterEach(() => clearResponseHistoryForTests());

function rememberNode(id, { parentId = null, inputItems = [], outputItems = [] } = {}) {
  return rememberResponseHistoryNode({ id, parentId, inputItems, outputItems });
}

test("response history snapshot materializes a stable chain and route metadata", () => {
  rememberResponseHistoryNode({
    id: "resp_root",
    parentId: null,
    inputItems: ["root-input"],
    outputItems: ["root-output"],
    hasOpaque: true,
    routeAffinity: { model: "model-a" },
  });
  rememberNode("resp_child", {
    parentId: "resp_root",
    inputItems: ["child-input"],
    outputItems: ["child-output"],
  });

  const snapshot = acquireResponseHistorySnapshot("resp_child");
  const routeMetadata = [];
  assert.equal(snapshot.responseId, "resp_child");
  assert.equal(snapshot.rootId, "resp_root");
  assert.ok(snapshot.bytes > 0);
  assert.deepEqual(snapshot.materialize({ routeMetadata }), [
    "root-input",
    "root-output",
    "child-input",
    "child-output",
  ]);
  assert.deepEqual(routeMetadata, [
    { affinity: { model: "model-a" }, hasOpaque: true },
    { affinity: null, hasOpaque: false },
  ]);
  snapshot.release();
  snapshot.release();
});

test("large history strings retain exact JSON byte accounting", () => {
  const imageUrl = `data:image/png;base64,${"A".repeat(1024 * 1024)}`;
  const inputItems = [
    { type: "input_image", image_url: imageUrl },
    { type: "input_text", text: "é".repeat(1024) },
    { type: "input_text", text: `${"x".repeat(1024)}😀` },
    { type: "input_text", text: `${"x".repeat(1024)}"` },
  ];
  assert.equal(rememberResponseHistoryNode({
    id: "resp_image", inputItems, outputItems: [], takeOwnership: true,
  }), true);
  assert.equal(responseHistoryStats().bytes, Buffer.byteLength(JSON.stringify([inputItems, []])));
});

test("opaque state preserves every UTF-16 code unit and exact JSON accounting through history replay", () => {
  const values = ["AA==", "AA", "_-8", "\u0000\r\n\"\\", "\ud800", "\udfff", "😀", "é", ""].map((value, index) => (
    `${index}:${value}:${"x".repeat(1025)}`
  ));
  const inputItems = values.map((value) => ({ type: "reasoning", id: value, encrypted_content: value, summary: [] }));
  const outputItems = [{ type: "compaction", encrypted_content: values.join("|") }];
  rememberResponseHistoryNode({ id: "resp_unicode", inputItems, outputItems, hasOpaque: true });
  assert.equal(responseHistoryStats().bytes, Buffer.byteLength(JSON.stringify([inputItems, outputItems])));
  const snapshot = acquireResponseHistorySnapshot("resp_unicode");
  try {
    const replay = prepareResponsesRequest({ model: "gpt-6-astra", previous_response_id: "resp_unicode", input: [] }, { historySnapshot: snapshot });
    assert.deepEqual(replay.body.input, [...inputItems, ...outputItems]);
    const decoded = JSON.parse(JSON.stringify(replay.body.input));
    assert.deepEqual(decoded, [...inputItems, ...outputItems]);
    decoded[0].encrypted_content = "changed-copy";
    assert.equal(snapshot.materialize()[0].encrypted_content, values[0]);
  } finally { snapshot.release(); }
});

test("repeated opaque-history eviction releases payload memory after warm-up", () => {
  const moduleUrl = new URL("../src/response-history.mjs", import.meta.url).href;
  const result = execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { rememberResponseHistoryNode, acquireResponseHistorySnapshot, clearResponseHistoryForTests,
      configureResponseHistoryForTests, responseHistoryStats } from ${JSON.stringify(moduleUrl)};
    configureResponseHistoryForTests({ maxBytes: 256 * 1024, maxEntries: 8 });
    function batch(offset) {
      for (let index = 0; index < 128; index += 1) {
        const id = "resp_" + (offset + index);
        const opaque = (String(offset + index) + ":x").repeat(4096) + "\\ud800";
        assert.equal(rememberResponseHistoryNode({ id, inputItems: [], outputItems: [
          { type: "reasoning", encrypted_content: opaque, summary: [] }
        ], hasOpaque: true }), true);
        const snapshot = acquireResponseHistorySnapshot(id);
        assert.equal(snapshot.materialize()[0].encrypted_content, opaque);
        snapshot.release();
        assert.ok(responseHistoryStats().bytes <= 256 * 1024);
        assert.ok(responseHistoryStats().entries <= 8);
      }
    }
    function memory() { global.gc(); global.gc(); return process.memoryUsage().heapUsed; }
    batch(0); clearResponseHistoryForTests(); const baseline = memory();
    configureResponseHistoryForTests({ maxBytes: 256 * 1024, maxEntries: 8 });
    for (let round = 0; round < 6; round += 1) batch((round + 1) * 128);
    const retained = memory(); clearResponseHistoryForTests(); const cleared = memory();
    assert.ok(retained - baseline < 8 * 1024 * 1024, "bounded history retained excess heap");
    assert.ok(cleared - baseline < 4 * 1024 * 1024, "evicted history was not released");
    console.log(JSON.stringify({ retained_delta_bytes: retained - baseline, cleared_delta_bytes: cleared - baseline }));
  `], { encoding: "utf8", timeout: 20_000 });
  const memory = JSON.parse(result);
  assert.ok(Number.isFinite(memory.retained_delta_bytes));
});

test("all response history snapshot leases must release before a root is evictable", () => {
  configureResponseHistoryForTests({ maxBytes: 1_000_000, maxEntries: 1 });
  assert.equal(rememberNode("resp_root"), true);
  const first = acquireResponseHistorySnapshot("resp_root");
  const second = acquireResponseHistorySnapshot("resp_root");

  assert.equal(rememberNode("resp_blocked_a"), false);
  first.release();
  assert.equal(rememberNode("resp_blocked_b"), false);
  assert.deepEqual(materializeResponseHistory("resp_root"), []);

  second.release();
  assert.equal(rememberNode("resp_replacement"), true);
  assert.throws(
    () => materializeResponseHistory("resp_root"),
    /was evicted after reaching the local history limit/,
  );
  assert.deepEqual(materializeResponseHistory("resp_replacement"), []);
});

test("history pressure diagnostics distinguish evicted entries from failed lookups", () => {
  configureResponseHistoryForTests({ maxBytes: 1_000_000, maxEntries: 1 });
  assert.equal(rememberNode("resp_old", { inputItems: ["old"] }), true);
  assert.equal(rememberNode("resp_new", { inputItems: ["new"] }), true);
  const beforeLookup = responseHistoryStats();
  assert.equal(beforeLookup.tree_count, 1);
  assert.equal(beforeLookup.largest_tree_bytes, beforeLookup.bytes);
  assert.equal(beforeLookup.evicted_entries_total, 1);
  assert.equal(beforeLookup.lookup_misses, 0);
  assert.throws(() => materializeResponseHistory("resp_old"), /was evicted/);
  const afterLookup = responseHistoryStats();
  assert.equal(afterLookup.lookup_misses, 1);
  assert.equal(afterLookup.evicted_lookup_misses, 1);
  assert.equal(afterLookup.evicted, 1);
});

test("pinned parent keeps maxEntries hard and rejects only the new child", () => {
  configureResponseHistoryForTests({ maxBytes: 1_000_000, maxEntries: 1 });
  assert.equal(rememberNode("resp_root"), true);
  const snapshot = acquireResponseHistorySnapshot("resp_root");

  assert.equal(rememberNode("resp_child", { parentId: "resp_root" }), false);
  assert.equal(responseHistoryStats().entries, 1);
  assert.deepEqual(snapshot.materialize(), []);
  assert.throws(
    () => materializeResponseHistory("resp_child"),
    /was evicted after reaching the local history limit/,
  );
  snapshot.release();
});

test("pinned parent keeps maxBytes hard and rejects only the new child", () => {
  configureResponseHistoryForTests({ maxBytes: 15, maxEntries: 100 });
  assert.equal(rememberNode("resp_root"), true);
  assert.equal(responseHistoryStats().bytes, Buffer.byteLength(JSON.stringify([[], []])));
  const snapshot = acquireResponseHistorySnapshot("resp_root");

  assert.equal(rememberNode("resp_child", {
    parentId: "resp_root",
    inputItems: ["x"],
  }), false);
  assert.equal(responseHistoryStats().bytes, Buffer.byteLength(JSON.stringify([[], []])));
  assert.deepEqual(snapshot.materialize(), []);
  snapshot.release();
});

test("pinned root evicts only unrelated trees while committing a child", () => {
  configureResponseHistoryForTests({ maxBytes: 1_000_000, maxEntries: 2 });
  assert.equal(rememberNode("resp_root", { inputItems: ["root"] }), true);
  const snapshot = acquireResponseHistorySnapshot("resp_root");
  assert.equal(rememberNode("resp_other_a"), true);
  assert.equal(rememberNode("resp_other_b"), true);
  assert.equal(rememberNode("resp_child", {
    parentId: "resp_root",
    inputItems: ["child"],
  }), true);

  assert.equal(responseHistoryStats().entries, 2);
  assert.deepEqual(materializeResponseHistory("resp_child"), ["root", "child"]);
  assert.throws(
    () => materializeResponseHistory("resp_other_b"),
    /was evicted after reaching the local history limit/,
  );
  snapshot.release();
});

test("remember refuses a child whose parent disappeared", () => {
  configureResponseHistoryForTests({ maxBytes: 1_000_000, maxEntries: 1 });
  assert.equal(rememberNode("resp_root"), true);
  assert.equal(rememberNode("resp_replacement"), true);

  assert.equal(rememberNode("resp_child", { parentId: "resp_root" }), false);
  assert.equal(responseHistoryStats().entries, 1);
  assert.throws(
    () => materializeResponseHistory("resp_child"),
    /was evicted after reaching the local history limit/,
  );
  assert.deepEqual(materializeResponseHistory("resp_replacement"), []);
});

test("abort releases a response history snapshot lease", () => {
  configureResponseHistoryForTests({ maxBytes: 1_000_000, maxEntries: 1 });
  assert.equal(rememberNode("resp_root"), true);
  const abort = new AbortController();
  const snapshot = acquireResponseHistorySnapshot("resp_root", { signal: abort.signal });

  abort.abort();
  assert.equal(rememberNode("resp_replacement"), true);
  assert.throws(() => snapshot.materialize(), /released/);
  assert.throws(
    () => materializeResponseHistory("resp_root"),
    /was evicted after reaching the local history limit/,
  );
  snapshot.release();
});

test("prepareResponsesRequest consumes only the matching history snapshot", () => {
  assert.equal(rememberNode("resp_root", {
    inputItems: ["root-input"],
    outputItems: ["root-output"],
  }), true);
  const snapshot = acquireResponseHistorySnapshot("resp_root");

  const prepared = prepareResponsesRequest({
    model: "gpt-5.5",
    previous_response_id: "resp_root",
    input: "current",
  }, { historySnapshot: snapshot });
  assert.equal(prepared.historyRootId, "resp_root");
  assert.deepEqual(prepared.body.input.slice(0, 2), ["root-input", "root-output"]);
  assert.throws(
    () => prepareResponsesRequest({
      model: "gpt-5.5",
      previous_response_id: "different",
      input: "current",
    }, { historySnapshot: snapshot }),
    /does not match previous_response_id/,
  );
  snapshot.release();
});
