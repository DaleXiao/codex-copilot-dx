import assert from "node:assert/strict";
import test from "node:test";
import {
  clearResponsesToolOutputPartsCache,
  readResponsesToolOutputParts,
} from "../src/responses-content.mjs";

test("stringified tool output is parsed once per unchanged item", () => {
  const item = {
    type: "function_call_output",
    output: JSON.stringify([{ type: "input_text", text: "large output" }]),
  };
  const originalParse = JSON.parse;
  let parses = 0;
  JSON.parse = function countedParse(value, ...args) {
    if (value === item.output) parses += 1;
    return originalParse.call(this, value, ...args);
  };

  try {
    const first = readResponsesToolOutputParts(item);
    const second = readResponsesToolOutputParts(item);
    assert.equal(parses, 1);
    assert.equal(first.parts, second.parts);
  } finally {
    JSON.parse = originalParse;
  }
});

test("tool output cache follows commits and invalidates on external replacement", () => {
  const item = {
    type: "custom_tool_call_output",
    output: JSON.stringify([{ type: "input_text", text: "before" }]),
  };
  const first = readResponsesToolOutputParts(item);
  first.parts[0].text = "after";
  first.commit();

  const committed = readResponsesToolOutputParts(item);
  assert.equal(committed.parts, first.parts);
  assert.equal(committed.parts[0].text, "after");

  item.output = JSON.stringify([{ type: "input_text", text: "replacement" }]);
  const replaced = readResponsesToolOutputParts(item);
  assert.notEqual(replaced.parts, first.parts);
  assert.equal(replaced.parts[0].text, "replacement");
});

test("invalid stringified tool output parse failures are cached", () => {
  const item = { type: "function_call_output", output: "[invalid" };
  const originalParse = JSON.parse;
  let parses = 0;
  JSON.parse = function countedParse(value, ...args) {
    if (value === item.output) parses += 1;
    return originalParse.call(this, value, ...args);
  };

  try {
    assert.equal(readResponsesToolOutputParts(item), null);
    assert.equal(readResponsesToolOutputParts(item), null);
    assert.equal(parses, 1);
  } finally {
    JSON.parse = originalParse;
  }
});

test("tool output cache can be released at the upstream request boundary", () => {
  const item = {
    type: "function_call_output",
    output: JSON.stringify([{ type: "input_text", text: "temporary" }]),
  };
  const first = readResponsesToolOutputParts(item);
  clearResponsesToolOutputPartsCache([item]);
  const second = readResponsesToolOutputParts(item);
  assert.notEqual(first.parts, second.parts);
  assert.deepEqual(first.parts, second.parts);
});
