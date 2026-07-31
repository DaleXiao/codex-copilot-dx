import { test } from "node:test";
import assert from "node:assert/strict";
import { trimResponsesHistoryToByteBudget } from "../src/responses-byte-budget.mjs";

function imagePart(id, size = 1000) {
  return { type: "input_image", image_url: `data:image/png;base64,${id.repeat(size)}` };
}

function imageMessage(id, size) {
  return { type: "message", role: "user", content: [imagePart(id, size)] };
}

test("byte budget removes an older duplicate before unique historical images", () => {
  const body = {
    model: "gpt-5.6-sol",
    input: [imageMessage("u"), imageMessage("d"), imageMessage("d")],
  };
  const initialBytes = Buffer.byteLength(JSON.stringify(body));

  const result = trimResponsesHistoryToByteBudget(body, {
    currentInputStart: 2,
    targetBytes: initialBytes - 500,
  });

  assert.equal(result.overBudget, false);
  assert.equal(result.imagesOmitted, 1);
  assert.equal(body.input[0].content[0].type, "input_image");
  assert.equal(body.input[1].content[0].type, "input_text");
  assert.equal(body.input[2].content[0].type, "input_image");
});

test("byte budget recognizes duplicates across Responses and Anthropic image wrappers", () => {
  const duplicateData = Buffer.alloc(1000, 7).toString("base64");
  const duplicateUrl = `data:image/png;base64,${duplicateData}`;
  const body = {
    model: "gpt-5.6-sol",
    input: [
      imageMessage("u", 1000),
      { type: "message", role: "user", content: [{ type: "input_image", image_url: duplicateUrl }] },
      {
        type: "custom_tool_call_output",
        call_id: "call_duplicate",
        output: [{
          type: "image",
          source: { type: "base64", media_type: "image/png", data: duplicateData },
        }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
  };
  const initialBytes = Buffer.byteLength(JSON.stringify(body));

  const result = trimResponsesHistoryToByteBudget(body, {
    currentInputStart: 3,
    targetBytes: initialBytes - 500,
  });

  assert.equal(result.overBudget, false);
  assert.equal(result.imagesOmitted, 1);
  assert.equal(body.input[0].content[0].type, "input_image");
  assert.equal(body.input[1].content[0].type, "input_text");
  assert.equal(body.input[2].output[0].type, "image");
  assert.equal(body.input[3].content[0].text, "continue");
});

test("byte budget removes historical tool images before other historical images", () => {
  const body = {
    model: "gpt-5.6-sol",
    input: [
      imageMessage("m"),
      {
        type: "custom_tool_call_output",
        call_id: "call_image",
        output: [imagePart("t")],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
  };
  const initialBytes = Buffer.byteLength(JSON.stringify(body));

  const result = trimResponsesHistoryToByteBudget(body, {
    currentInputStart: 2,
    targetBytes: initialBytes - 500,
  });

  assert.equal(result.imagesOmitted, 1);
  assert.equal(body.input[0].content[0].type, "input_image");
  assert.equal(body.input[1].output[0].type, "input_text");
});

test("byte budget omits old custom tool output while preserving its call skeleton", () => {
  const body = {
    model: "gpt-5.6-sol",
    input: [
      { type: "custom_tool_call_output", call_id: "call_old", output: "x".repeat(4000) },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
  };
  const initialBytes = Buffer.byteLength(JSON.stringify(body));

  const result = trimResponsesHistoryToByteBudget(body, {
    currentInputStart: 1,
    targetBytes: initialBytes - 1000,
  });

  assert.equal(result.overBudget, false);
  assert.equal(result.toolOutputsOmitted, 1);
  assert.equal(body.input[0].type, "custom_tool_call_output");
  assert.equal(body.input[0].call_id, "call_old");
  assert.match(body.input[0].output, /earlier tool output omitted/);
  assert.equal(body.input[1].content[0].text, "continue");
});

test("byte budget keeps a historical image when its omission marker would be larger", () => {
  const tinyImage = imageMessage("A", 1);
  const originalTinyImage = structuredClone(tinyImage);
  const body = {
    model: "gpt-5.6-sol",
    input: [
      tinyImage,
      { type: "function_call_output", call_id: "call_large", output: "x".repeat(4000) },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
  };
  const initialBytes = Buffer.byteLength(JSON.stringify(body));

  const result = trimResponsesHistoryToByteBudget(body, {
    currentInputStart: 2,
    targetBytes: initialBytes - 1000,
  });

  assert.equal(result.overBudget, false);
  assert.equal(result.imagesOmitted, 0);
  assert.equal(result.toolOutputsOmitted, 1);
  assert.deepEqual(body.input[0], originalTinyImage);
  assert.equal(body.input[2].content[0].text, "continue");
});

test("byte budget preserves non-saving stringified history images and current images", () => {
  const tinyOutput = JSON.stringify([imagePart("A", 1)]);
  const currentImage = {
    type: "custom_tool_call_output",
    call_id: "call_current",
    output: [{
      type: "image_url",
      image_url: { url: `data:image/png;base64,${Buffer.alloc(1000, 9).toString("base64")}` },
    }],
  };
  const originalCurrentImage = structuredClone(currentImage);
  const body = {
    model: "gpt-5.6-sol",
    input: [
      { type: "custom_tool_call_output", call_id: "call_tiny", output: tinyOutput },
      { type: "function_call_output", call_id: "call_large", output: "x".repeat(4000) },
      currentImage,
    ],
  };
  const initialBytes = Buffer.byteLength(JSON.stringify(body));

  const result = trimResponsesHistoryToByteBudget(body, {
    currentInputStart: 2,
    targetBytes: initialBytes - 1000,
  });

  assert.equal(result.overBudget, false);
  assert.equal(result.imagesOmitted, 0);
  assert.equal(result.toolOutputsOmitted, 1);
  assert.equal(body.input[0].output, tinyOutput);
  assert.deepEqual(body.input[2], originalCurrentImage);
});

test("byte budget never trims irreducible current input", () => {
  const body = {
    model: "gpt-5.6-sol",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(4000) }] }],
  };
  const original = structuredClone(body);

  const result = trimResponsesHistoryToByteBudget(body, {
    currentInputStart: 0,
    targetBytes: 100,
  });

  assert.equal(result.overBudget, true);
  assert.equal(result.imagesOmitted, 0);
  assert.equal(result.toolOutputsOmitted, 0);
  assert.deepEqual(body, original);
});
