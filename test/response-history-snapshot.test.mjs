import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
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
