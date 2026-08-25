import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearResponseHistoryForTests,
  configureResponseHistoryForTests,
  responseHistoryStats,
} from "../src/response-history.mjs";
import {
  applyResponseHistoryRoutePlan,
  dropMaterializedResponseHistory,
  prepareResponsesRequest,
  rememberResponseHistory,
  responseHistoryPressureRootId,
} from "../src/responses-request.mjs";
import {
  createRoutePlan,
  routePlanAffinity,
  sameRoutePlanAffinity,
} from "../src/route-plan.mjs";

function responsesPlan(model, protocol = "openai-responses") {
  return createRoutePlan({
    disposition: "relay",
    origin: "ccdx",
    profile: "codex",
    protocol,
    model,
    surface: "responses",
  });
}

function rememberEncryptedRoot(plan = null) {
  let prepared = prepareResponsesRequest({ model: "model-a", input: "start" });
  if (plan) prepared = applyResponseHistoryRoutePlan(prepared, plan);
  rememberResponseHistory(prepared, {
    id: "resp_affinity_root",
    status: "completed",
    output: [
      { type: "reasoning", id: "rs_1", encrypted_content: "cipher-a", summary: [] },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "visible", encrypted_content: "cipher-field" }],
      },
    ],
  });
}

test("route plans are immutable and compare only upstream replay affinity", () => {
  const first = responsesPlan("model-a");
  const same = createRoutePlan({ ...first, surface: "responses-compact" });
  const different = responsesPlan("model-a", "openai-chat-completions");

  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(routePlanAffinity(first), {
    origin: "ccdx",
    profile: "codex",
    protocol: "openai-responses",
    model: "model-a",
  });
  assert.equal(sameRoutePlanAffinity(routePlanAffinity(first), routePlanAffinity(same)), true);
  assert.equal(sameRoutePlanAffinity(routePlanAffinity(first), routePlanAffinity(different)), false);
});

test("same-route response history preserves encrypted replay on the first payload", () => {
  clearResponseHistoryForTests();
  const plan = responsesPlan("model-a");
  rememberEncryptedRoot(plan);

  const prepared = prepareResponsesRequest({
    model: "model-a",
    previous_response_id: "resp_affinity_root",
    input: "continue",
  });
  const routed = applyResponseHistoryRoutePlan(prepared, plan);

  assert.equal(routed.historyParentId, "resp_affinity_root");
  assert.equal(JSON.stringify(routed.body).includes("cipher-a"), true);
  assert.equal(JSON.stringify(routed.body).includes("cipher-field"), true);
});

test("cross-model history removes only historical opaque state and rebases visible context", () => {
  clearResponseHistoryForTests();
  rememberEncryptedRoot(responsesPlan("model-a"));

  const prepared = prepareResponsesRequest({
    model: "model-b",
    previous_response_id: "resp_affinity_root",
    input: "continue",
  });
  const routed = applyResponseHistoryRoutePlan(prepared, responsesPlan("model-b"));
  const serialized = JSON.stringify(routed.body);

  assert.equal(serialized.includes("encrypted_content"), false);
  assert.equal(serialized.includes("visible"), true);
  assert.equal(serialized.includes("continue"), true);
  assert.equal(routed.historyParentId, null);
  assert.equal(routed.historyRootId, null);
  assert.equal(responseHistoryPressureRootId(routed), "resp_affinity_root");
  assert.strictEqual(routed.historyInputItems, routed.body.input);
  assert.equal(dropMaterializedResponseHistory(routed), true);
  assert.deepEqual(routed.body.input, [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "continue" }],
  }]);
});

test("protocol changes sanitize native opaque history before Chat fallback", () => {
  clearResponseHistoryForTests();
  rememberEncryptedRoot(responsesPlan("model-a", "openai-responses"));

  const prepared = prepareResponsesRequest({
    model: "model-a",
    previous_response_id: "resp_affinity_root",
    input: "continue",
  });
  const routed = applyResponseHistoryRoutePlan(
    prepared,
    responsesPlan("model-a", "openai-chat-completions"),
  );

  assert.equal(JSON.stringify(routed.body).includes("encrypted_content"), false);
  assert.equal(routed.historyParentId, null);
});

test("cross-route plain history remains byte-equivalent and incrementally linked", () => {
  clearResponseHistoryForTests();
  let root = prepareResponsesRequest({ model: "model-a", input: "plain start" });
  root = applyResponseHistoryRoutePlan(root, responsesPlan("model-a"));
  rememberResponseHistory(root, {
    id: "resp_plain_root",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "plain reply" }] }],
  });

  const prepared = prepareResponsesRequest({
    model: "model-b",
    previous_response_id: "resp_plain_root",
    input: "plain continue",
  });
  const before = JSON.stringify(prepared.body);
  const routed = applyResponseHistoryRoutePlan(prepared, responsesPlan("model-b"));

  assert.equal(JSON.stringify(routed.body), before);
  assert.equal(routed.historyParentId, "resp_plain_root");
});

test("alternating models keep plain response history linear", () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 1024 * 1024, maxEntries: 1024 });
  let previousId = null;
  for (let index = 0; index < 80; index += 1) {
    const model = index % 2 === 0 ? "model-a" : "model-b";
    let prepared = prepareResponsesRequest({
      model,
      ...(previousId ? { previous_response_id: previousId } : {}),
      input: `turn-${index}`,
    });
    prepared = applyResponseHistoryRoutePlan(prepared, responsesPlan(model));
    if (previousId) assert.equal(prepared.historyParentId, previousId);
    const id = `resp_plain_${index}`;
    rememberResponseHistory(prepared, {
      id,
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `reply-${index}` }] }],
    });
    previousId = id;
  }

  const stats = responseHistoryStats();
  assert.equal(stats.entries, 80);
  assert.ok(stats.bytes < 64 * 1024);
});

test("history accounting includes bounded route affinity metadata", () => {
  clearResponseHistoryForTests();
  const model = "m".repeat(10_000);
  const plan = responsesPlan(model);
  const affinity = routePlanAffinity(plan);
  assert.match(affinity.model, /^sha256:[a-f0-9]{64}$/);

  let prepared = prepareResponsesRequest({ model, input: "small" });
  prepared = applyResponseHistoryRoutePlan(prepared, plan);
  const response = { id: "resp_bounded_affinity", status: "completed", output: [] };
  rememberResponseHistory(prepared, response);

  const contentOnlyBytes = Buffer.byteLength(JSON.stringify([prepared.historyInputItems, response.output]));
  assert.ok(responseHistoryStats().bytes > contentOnlyBytes);
  assert.ok(responseHistoryStats().bytes < contentOnlyBytes + 1024);
});

test("unknown legacy provenance keeps the existing upstream-error fallback behavior", () => {
  clearResponseHistoryForTests();
  rememberEncryptedRoot();

  const prepared = prepareResponsesRequest({
    model: "model-b",
    previous_response_id: "resp_affinity_root",
    input: "continue",
  });
  const routed = applyResponseHistoryRoutePlan(prepared, responsesPlan("model-b"));

  assert.equal(routed.historyParentId, "resp_affinity_root");
  assert.equal(JSON.stringify(routed.body).includes("cipher-a"), true);
});
