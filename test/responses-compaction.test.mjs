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

test("createResponsesCompactionResult preserves the canonical compacted window as-is", () => {
  const input = [
    { type: "message", role: "user", content: "must not be reconstructed" },
  ];
  const generated = {
    id: "resp_compact",
    object: "response",
    status: "completed",
    output: [
      { type: "message", id: "retained", role: "assistant", content: [{ type: "output_text", text: "canonical" }] },
      { type: "reasoning", id: "rs_1", encrypted_content: "reasoning-state", summary: [] },
      { type: "function_call", id: "call_1", call_id: "call_1", name: "lookup", arguments: "{}" },
      { type: "compaction", id: "cmp_1", encrypted_content: "one" },
      { type: "compaction", id: "cmp_2", encrypted_content: "two" },
    ],
  };
  const expectedOutput = structuredClone(generated.output);

  const result = createResponsesCompactionResult(input, generated);

  assert.equal(result.object, "response.compaction");
  assert.strictEqual(result.output, generated.output);
  assert.deepEqual(result.output, expectedOutput);
  assert.deepEqual(generated.output, expectedOutput);
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
