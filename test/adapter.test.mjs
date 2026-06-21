import { test } from "node:test";
import assert from "node:assert/strict";
import { clearResponseHistoryForTests, prepareResponsesRequest, rememberResponseHistory, requestPath } from "../src/adapter.mjs";

test("requestPath: ignores Claude Code beta query on messages route", () => {
  assert.equal(requestPath("/v1/messages?beta=true"), "/v1/messages");
});

test("requestPath: ignores query strings on other API routes", () => {
  assert.equal(requestPath("/v1/messages/count_tokens?beta=true"), "/v1/messages/count_tokens");
  assert.equal(requestPath("/v1/responses?stream=true"), "/v1/responses");
  assert.equal(requestPath("/v1/responses/compact?stream=true"), "/v1/responses/compact");
  assert.equal(requestPath("/v1/models?foo=bar"), "/v1/models");
});

test("prepareResponsesRequest: expands previous response history locally", () => {
  clearResponseHistoryForTests();

  const first = prepareResponsesRequest({
    model: "gpt-5.5",
    store: true,
    input: "Remember marker alpha.",
  });
  assert.equal(first.body.store, undefined);
  assert.deepEqual(first.body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Remember marker alpha." }] },
  ]);

  rememberResponseHistory(first, {
    id: "resp_1",
    output: [
      { type: "reasoning", id: "rs_1", summary: [] },
      { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "STORED" }] },
    ],
  });

  const second = prepareResponsesRequest({
    model: "gpt-5.5",
    previous_response_id: "resp_1",
    store: true,
    input: "What marker?",
  });

  assert.equal(second.body.previous_response_id, undefined);
  assert.equal(second.body.store, undefined);
  assert.deepEqual(second.body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Remember marker alpha." }] },
    { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "STORED" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "What marker?" }] },
  ]);
});

test("prepareResponsesRequest: rejects missing local previous response history", () => {
  clearResponseHistoryForTests();

  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "missing", input: "hello" }),
    /previous_response_id is not available/,
  );
});
