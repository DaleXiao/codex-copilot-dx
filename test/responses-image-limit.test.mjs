import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearResponseHistoryForTests,
  prepareResponsesRequest,
  rememberResponseHistory,
} from "../src/adapter.mjs";
import { enforceResponsesImageLimit } from "../src/responses-image-limit.mjs";

function imagePart(id) {
  return { type: "input_image", image_url: `data:image/png;base64,${id}` };
}

function imageMessage(id) {
  return { type: "message", role: "user", content: [imagePart(id)] };
}

function countImages(inputItems) {
  let count = 0;
  for (const item of inputItems) {
    if (["input_image", "image", "image_url"].includes(item?.type)) count += 1;
    if (item?.type === "message" && Array.isArray(item.content)) {
      count += item.content.filter((part) => ["input_image", "image", "image_url"].includes(part?.type)).length;
    }
    if (["function_call_output", "custom_tool_call_output"].includes(item?.type)) {
      const output = Array.isArray(item.output) ? item.output : JSON.parse(item.output);
      count += output.filter((part) => ["input_image", "image", "image_url"].includes(part?.type)).length;
    }
  }
  return count;
}

test("image limit leaves requests at the limit unchanged", () => {
  const input = [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "inspect" }, imagePart("a"), imagePart("b")],
    },
  ];
  const original = structuredClone(input);
  let mutated = false;

  const result = enforceResponsesImageLimit(input, {
    maxImages: 2,
    beforeMutate: () => { mutated = true; },
  });

  assert.deepEqual(result, {
    total: 2,
    kept: 2,
    omitted: 0,
    duplicates: 0,
    historicalOmitted: 0,
    currentOmitted: 0,
  });
  assert.equal(mutated, false);
  assert.deepEqual(input, original);
});

test("image limit removes an older duplicate before unique history", () => {
  const input = [
    imageMessage("same"),
    imageMessage("two"),
    imageMessage("three"),
    imageMessage("four"),
    imageMessage("same"),
  ];

  const result = enforceResponsesImageLimit(input, { maxImages: 4, currentInputStart: 4 });

  assert.equal(countImages(input), 4);
  assert.equal(result.duplicates, 1);
  assert.equal(result.historicalOmitted, 1);
  assert.equal(result.currentOmitted, 0);
  assert.equal(input[0].content[0].type, "input_text");
  assert.equal(input[4].content[0].image_url, "data:image/png;base64,same");
});

test("image limit keeps recent duplicate images instead of older history", () => {
  const input = Array.from({ length: 6 }, () => imageMessage("same"));

  const result = enforceResponsesImageLimit(input, { maxImages: 4, currentInputStart: 4 });

  assert.equal(countImages(input), 4);
  assert.equal(result.duplicates, 2);
  assert.equal(result.historicalOmitted, 2);
  assert.equal(result.currentOmitted, 0);
  assert.equal(input[0].content[0].type, "input_text");
  assert.equal(input[1].content[0].type, "input_text");
  assert.equal(input[4].content[0].type, "input_image");
  assert.equal(input[5].content[0].type, "input_image");
});

test("image limit deduplicates inline images across all supported wrappers", () => {
  const duplicateData = Buffer.from("same-image").toString("base64");
  const duplicateUrl = `data:image/png;base64,${duplicateData}`;
  const input = [
    imageMessage("unique"),
    { type: "message", role: "user", content: [{ type: "input_image", image_url: duplicateUrl }] },
    {
      type: "custom_tool_call_output",
      call_id: "custom_url",
      output: [{ type: "image_url", image_url: { url: duplicateUrl } }],
    },
    {
      type: "custom_tool_call_output",
      call_id: "custom_anthropic",
      output: [{
        type: "image",
        source: { type: "base64", media_type: "image/png", data: duplicateData },
      }],
    },
  ];

  const result = enforceResponsesImageLimit(input, { maxImages: 2, currentInputStart: 3 });

  assert.equal(result.duplicates, 2);
  assert.equal(result.historicalOmitted, 2);
  assert.equal(result.currentOmitted, 0);
  assert.equal(input[0].content[0].type, "input_image");
  assert.equal(input[1].content[0].type, "input_text");
  assert.equal(input[2].output[0].type, "input_text");
  assert.equal(input[3].output[0].type, "image");
});

test("image limit keeps the most recent images and prefers current input", () => {
  const input = Array.from({ length: 6 }, (_, index) => imageMessage(`image-${index}`));

  const result = enforceResponsesImageLimit(input, { maxImages: 4, currentInputStart: 5 });

  assert.equal(countImages(input), 4);
  assert.equal(result.historicalOmitted, 2);
  assert.equal(result.currentOmitted, 0);
  assert.equal(input[0].content[0].type, "input_text");
  assert.equal(input[1].content[0].type, "input_text");
  assert.equal(input[5].content[0].image_url, "data:image/png;base64,image-5");
});

test("image limit handles stringified tool output images", () => {
  const input = [{
    type: "function_call_output",
    call_id: "call_images",
    output: JSON.stringify(Array.from({ length: 5 }, (_, index) => imagePart(`tool-${index}`))),
  }];

  const result = enforceResponsesImageLimit(input, { maxImages: 3 });
  const output = JSON.parse(input[0].output);

  assert.equal(result.currentOmitted, 2);
  assert.equal(output.length, 3);
  assert.deepEqual(output.map((part) => part.image_url), [
    "data:image/png;base64,tool-2",
    "data:image/png;base64,tool-3",
    "data:image/png;base64,tool-4",
  ]);
});

test("image limit handles array and stringified custom tool output images", () => {
  const input = [
    {
      type: "custom_tool_call_output",
      call_id: "custom_array",
      output: [imagePart("array-0"), imagePart("array-1")],
    },
    {
      type: "custom_tool_call_output",
      call_id: "custom_string",
      output: JSON.stringify([imagePart("string-0"), imagePart("string-1")]),
    },
  ];

  const result = enforceResponsesImageLimit(input, { maxImages: 2 });

  assert.equal(result.omitted, 2);
  assert.equal(countImages(input), 2);
  assert.equal(input[0].output[0].type, "input_text");
  assert.deepEqual(JSON.parse(input[1].output).map((part) => part.image_url), [
    "data:image/png;base64,string-0",
    "data:image/png;base64,string-1",
  ]);
});

test("prepareResponsesRequest keeps complete current history when forwarding an image window", () => {
  clearResponseHistoryForTests();
  const request = {
    model: "gpt-5.6-sol",
    input: [{
      type: "message",
      role: "user",
      content: Array.from({ length: 51 }, (_, index) => imagePart(`current-${index}`)),
    }],
  };

  const prepared = prepareResponsesRequest(request, { mutate: true });
  assert.equal(countImages(prepared.body.input), 50);
  assert.equal(countImages(prepared.historyInputItems), 51);
  rememberResponseHistory(prepared, { id: "resp_image_limit", output: [] });

  const continuation = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    previous_response_id: "resp_image_limit",
    input: "continue",
  });
  assert.equal(countImages(continuation.body.input), 50);
  clearResponseHistoryForTests();
});

test("prepareResponsesRequest does not clone current input below the image limit", () => {
  const request = { model: "gpt-5.6-sol", input: [imageMessage("one")] };
  const prepared = prepareResponsesRequest(request, { mutate: true });

  assert.equal(prepared.historyInputItems, request.input);
  assert.equal(countImages(prepared.body.input), 1);
});
