import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compactionInputWithoutTrigger,
  createResponsesCompactionResult,
  parseResponsesCompactionResult,
  prepareResponsesCompactionRequest,
} from "../src/responses-compaction.mjs";

test("prepareResponsesCompactionRequest appends exactly one trigger and forces unary mode", () => {
  const originalMessage = { type: "message", role: "user", content: "hello" };
  const prepared = prepareResponsesCompactionRequest({
    body: {
      model: "gpt-5.6-sol",
      stream: true,
      input: [{ type: "compaction_trigger" }, originalMessage, { type: "compaction_trigger" }],
    },
  });

  assert.equal(prepared.body.stream, false);
  assert.deepEqual(prepared.body.input, [originalMessage, { type: "compaction_trigger" }]);
  assert.deepEqual(compactionInputWithoutTrigger(prepared.body.input), [originalMessage]);
});

test("createResponsesCompactionResult rebuilds replayable retained messages and keeps every compaction item", () => {
  const result = createResponsesCompactionResult([
    { type: "message", id: "old-system-id", role: "system", content: "system text", phase: "commentary" },
    { type: "function_call", id: "call_1", name: "shell", arguments: "{}" },
    {
      type: "message",
      id: "old-assistant-id",
      status: "completed",
      role: "assistant",
      content: [
        { type: "output_text", text: "assistant text", annotations: [] },
        { type: "input_image", image_url: "https://example.test/image.png" },
      ],
    },
  ], {
    id: "resp_compact",
    object: "response",
    status: "completed",
    output: [
      { type: "message", id: "stray", role: "assistant", content: [{ type: "output_text", text: "ignore" }] },
      { type: "compaction", id: "cmp_1", encrypted_content: "one" },
      { type: "compaction", id: "cmp_2", encrypted_content: "two" },
    ],
  });

  assert.equal(result.object, "response.compaction");
  assert.deepEqual(result.output.map((item) => item.type), ["message", "message", "compaction", "compaction"]);
  assert.match(result.output[0].id, /^msg_[a-f0-9]{32}$/);
  assert.notEqual(result.output[0].id, "old-system-id");
  assert.deepEqual(result.output[0], {
    type: "message",
    id: result.output[0].id,
    status: "completed",
    role: "system",
    content: [{ type: "input_text", text: "system text" }],
    phase: "commentary",
  });
  assert.deepEqual(result.output[1].content, [
    { type: "input_text", text: "assistant text", annotations: [] },
    { type: "input_image", image_url: "https://example.test/image.png" },
  ]);
  assert.deepEqual(result.output.slice(-2), [
    { type: "compaction", id: "cmp_1", encrypted_content: "one" },
    { type: "compaction", id: "cmp_2", encrypted_content: "two" },
  ]);
});

test("createResponsesCompactionResult retains every supported message role", () => {
  const roles = ["system", "developer", "user", "assistant"];
  const result = createResponsesCompactionResult([
    ...roles.map((role) => ({ type: "message", role, content: `${role} text` })),
    { type: "message", role: "tool", content: "not retained" },
  ], {
    id: "resp_roles",
    status: "completed",
    output: [{ type: "compaction", encrypted_content: "state" }],
  });

  assert.deepEqual(result.output.slice(0, -1).map((item) => item.role), roles);
});

test("createResponsesCompactionResult keeps newest messages within the 64k approximate-token budget", () => {
  const result = createResponsesCompactionResult([
    { type: "message", role: "user", content: "x".repeat(256_000) },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "newest" }] },
  ], {
    id: "resp_budget",
    status: "completed",
    output: [{ type: "compaction", id: "cmp_budget", encrypted_content: "state" }],
  });

  assert.deepEqual(result.output.slice(0, -1).map((item) => item.content[0].text), ["newest"]);
});

test("createResponsesCompactionResult keeps one newest message even when it exceeds the budget", () => {
  const result = createResponsesCompactionResult([
    { type: "message", role: "user", content: "x".repeat(256_001) },
  ], {
    id: "resp_oversized_newest",
    status: "completed",
    output: [{ type: "compaction", id: "cmp_oversized", encrypted_content: "state" }],
  });

  assert.equal(result.output[0].type, "message");
  assert.equal(result.output[0].content[0].text.length, 256_001);
});

test("compaction result parsing fails closed without valid completed compaction state", () => {
  assert.throws(
    () => createResponsesCompactionResult([], { id: "resp_missing", status: "completed", output: [] }),
    (error) => error.statusCode === 502 && error.code === "ccdx_invalid_compaction_response"
      && /no compaction output item/.test(error.message),
  );
  assert.throws(
    () => createResponsesCompactionResult([], {
      id: "resp_incomplete",
      status: "incomplete",
      output: [{ type: "compaction", encrypted_content: "partial" }],
    }),
    /returned status incomplete/,
  );
  assert.throws(
    () => createResponsesCompactionResult([], {
      id: "resp_invalid_state",
      status: "completed",
      output: [{ type: "compaction" }],
    }),
    /invalid compaction output item/,
  );
  assert.throws(() => parseResponsesCompactionResult([], "not json"), /returned invalid JSON/);
});
