import { test } from "node:test";
import assert from "node:assert/strict";
import { clearResponseHistoryForTests } from "../src/response-history.mjs";
import { isEncryptedContentVerificationError } from "../src/copilot-responses-policy.mjs";
import {
  prepareResponsesRequest,
  rememberResponseHistory,
  sanitizeEncryptedReasoningRequest,
  stripInternalResponsesInputFields,
} from "../src/responses-request.mjs";
import { isResponsesToolOutputItem } from "../src/responses-content.mjs";

const ENCRYPTED_TOOL_OUTPUT_MARKER = "[CCDX: encrypted tool output omitted because upstream could not decrypt it.]";

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
      { type: "reasoning", id: "rs_1", encrypted_content: "opaque-reasoning", summary: [] },
      { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "STORED" }] },
      { type: "future_output_item", id: "future_1", state: { opaque: true } },
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
    { type: "reasoning", id: "rs_1", encrypted_content: "opaque-reasoning", summary: [] },
    { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "STORED" }] },
    { type: "future_output_item", id: "future_1", state: { opaque: true } },
    { type: "message", role: "user", content: [{ type: "input_text", text: "What marker?" }] },
  ]);
});

test("prepareResponsesRequest preserves custom tool call pairing across local history", () => {
  clearResponseHistoryForTests();

  const first = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "Run the custom tool." });
  rememberResponseHistory(first, {
    id: "resp_custom_call",
    status: "completed",
    output: [{
      type: "custom_tool_call",
      id: "custom_call_1",
      call_id: "call_custom_1",
      name: "shell",
      input: "pwd",
    }],
  });

  const second = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    previous_response_id: "resp_custom_call",
    input: [{
      type: "custom_tool_call_output",
      call_id: "call_custom_1",
      output: "/tmp",
    }],
  });

  assert.deepEqual(second.body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Run the custom tool." }] },
    {
      type: "custom_tool_call",
      id: "custom_call_1",
      call_id: "call_custom_1",
      name: "shell",
      input: "pwd",
    },
    { type: "custom_tool_call_output", call_id: "call_custom_1", output: "/tmp" },
  ]);
  clearResponseHistoryForTests();
});

test("prepareResponsesRequest reports the current input start after top-level history images are pruned", () => {
  clearResponseHistoryForTests();

  const historyImages = Array.from({ length: 50 }, (_, index) => ({
    type: "input_image",
    image_url: `data:image/png;base64,aGlzdG9yeS0${index}`,
  }));
  const original = prepareResponsesRequest({ model: "gpt-5.6-sol", input: historyImages });
  rememberResponseHistory(original, { id: "resp_image_boundary", output: [] });

  const prepared = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    previous_response_id: "resp_image_boundary",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,Y3VycmVudA==" }],
    }],
  });

  assert.equal(prepared.body.input.length, 50);
  assert.equal(prepared.currentInputStart, 49);
  assert.equal(prepared.body.input[prepared.currentInputStart].type, "message");
  clearResponseHistoryForTests();
});

test("prepareResponsesRequest: rejects missing local previous response history", () => {
  clearResponseHistoryForTests();

  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "missing", input: "hello" }),
    /previous_response_id is not available/,
  );
});

test("prepareResponsesRequest: drops unsupported image generation tools", () => {
  const prepared = prepareResponsesRequest({
    model: "gpt-5.5",
    input: "hello",
    tools: [
      { type: "image_generation" },
      { type: "function", name: "lookup" },
    ],
  });

  assert.deepEqual(prepared.body.tools, [{ type: "function", name: "lookup" }]);

  const onlyUnsupported = prepareResponsesRequest({
    model: "gpt-5.5",
    input: "hello",
    tools: [{ type: "image_generation" }],
  });
  assert.equal(onlyUnsupported.body.tools, undefined);

  const similarlyNamedFunction = prepareResponsesRequest({
    model: "gpt-5.5",
    input: "hello",
    tools: [{ type: "function", name: "image_generation_status", parameters: { type: "object" } }],
  });
  assert.deepEqual(similarlyNamedFunction.body.tools, [
    { type: "function", name: "image_generation_status", parameters: { type: "object" } },
  ]);

  const forcedUnsupported = prepareResponsesRequest({
    model: "gpt-5.5",
    input: "hello",
    tools: [
      { type: "image_generation" },
      { type: "function", name: "lookup" },
    ],
    tool_choice: { type: "image_generation" },
  });
  assert.deepEqual(forcedUnsupported.body.tools, [{ type: "function", name: "lookup" }]);
  assert.equal(forcedUnsupported.body.tool_choice, "none");

  const requiredWithoutTools = prepareResponsesRequest({
    model: "gpt-5.5",
    input: "hello",
    tools: [{ type: "image_generation" }],
    tool_choice: "required",
  });
  assert.equal(requiredWithoutTools.body.tools, undefined);
  assert.equal(requiredWithoutTools.body.tool_choice, undefined);

  const requiredWithSurvivingTool = prepareResponsesRequest({
    model: "gpt-5.5",
    input: "hello",
    tools: [
      { type: "image_generation" },
      { type: "function", name: "lookup" },
    ],
    tool_choice: "required",
  });
  assert.equal(requiredWithSurvivingTool.body.tool_choice, "required");
});

test("stripInternalResponsesInputFields: drops only top-level internal input fields", () => {
  const input = [
    {
      type: "message",
      role: "user",
      internal_chat_message_metadata_passthrough: { hidden: true },
      content: [{ type: "input_text", text: "hello" }],
    },
  ];

  assert.equal(stripInternalResponsesInputFields(input), input);
  assert.deepEqual(input, [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    },
  ]);
});

test("prepareResponsesRequest: strips Codex private input fields without mutating request", () => {
  const req = {
    model: "gpt-5.5",
    input: [{
      type: "message",
      role: "user",
      internal_chat_message_metadata_passthrough: { hidden: true },
      content: [{ type: "input_text", text: "hello" }],
    }],
  };

  const prepared = prepareResponsesRequest(req);

  assert.equal(req.input[0].internal_chat_message_metadata_passthrough.hidden, true);
  assert.deepEqual(prepared.body.input, [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "hello" }],
  }]);
  assert.deepEqual(prepared.inputItems, prepared.body.input);
});

test("prepareResponsesRequest: can take ownership of a freshly parsed request", () => {
  const request = {
    model: "gpt-5.5",
    store: true,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
  };
  const input = request.input;
  const prepared = prepareResponsesRequest(request, { mutate: true });

  assert.equal(prepared.body, request);
  assert.equal(prepared.body.input, input);
  assert.equal(prepared.historyInputItems, input);
  assert.equal(prepared.takeHistoryOwnership, true);
  assert.equal(request.store, undefined);
});

test("prepareResponsesRequest: strips private fields from expanded previous response history", () => {
  clearResponseHistoryForTests();

  const first = prepareResponsesRequest({
    model: "gpt-5.5",
    input: [{
      type: "message",
      role: "user",
      internal_chat_message_metadata_passthrough: { hidden: true },
      content: [{ type: "input_text", text: "remember alpha" }],
    }],
  });
  rememberResponseHistory(first, {
    id: "resp_internal",
    output: [{ type: "message", id: "msg_internal", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
  });

  const second = prepareResponsesRequest({
    model: "gpt-5.5",
    previous_response_id: "resp_internal",
    input: "what did I say?",
  });

  assert.deepEqual(second.body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "remember alpha" }] },
    { type: "message", id: "msg_internal", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "what did I say?" }] },
  ]);
});

test("isEncryptedContentVerificationError: detects upstream encrypted reasoning failures", () => {
  const text = JSON.stringify({
    error: {
      message: "The encrypted content gAAA... could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
      code: "invalid_request_body",
    },
  });
  const functionOutputText = JSON.stringify({
    error: {
      message: "Encrypted function output content could not be decrypted or decoded.",
      code: "invalid_request_body",
    },
  });
  const missingEncryptedContentText = JSON.stringify({
    error: {
      message: "Missing required parameter: 'input[3].content[1].encrypted_content'.",
      code: "missing_required_parameter",
    },
  });

  assert.equal(isEncryptedContentVerificationError(400, text), true);
  assert.equal(isEncryptedContentVerificationError(400, functionOutputText), true);
  assert.equal(isEncryptedContentVerificationError(400, missingEncryptedContentText), true);
  assert.equal(isEncryptedContentVerificationError(422, missingEncryptedContentText), true);
  assert.equal(isEncryptedContentVerificationError(200, text), false);
  assert.equal(isEncryptedContentVerificationError(200, functionOutputText), false);
  assert.equal(isEncryptedContentVerificationError(500, missingEncryptedContentText), false);
  assert.equal(isEncryptedContentVerificationError(400, "Missing required parameter: 'input[3].content[1].text'."), false);
  assert.equal(isEncryptedContentVerificationError(400, "Missing required parameter: 'input[3].content[1].encrypted_content_backup'."), false);
  assert.equal(isEncryptedContentVerificationError(400, "Missing required parameter: 'input[3].content[1].encrypted_content.extra'."), false);
  assert.equal(isEncryptedContentVerificationError(400, "Raw request body exceeds 1 bytes"), false);
});

test("sanitizeEncryptedReasoningRequest: removes reasoning items and encrypted content fields", () => {
  const ctx = {
    body: {
      model: "gpt-5.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "reasoning", id: "rs_1", encrypted_content: "gAAA", summary: [] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible", encrypted_content: "gAAA" }] },
      ],
    },
    inputItems: [],
  };

  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  assert.deepEqual(sanitized.body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible" }] },
  ]);
  assert.deepEqual(sanitized.inputItems, sanitized.body.input);
  assert.equal(ctx.body.input.length, 3);
});

test("sanitizeEncryptedReasoningRequest: drops nested encrypted_content parts without schema shells", () => {
  const ctx = {
    body: {
      model: "gpt-5.5",
      store: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
        { type: "reasoning", id: "rs_nested", encrypted_content: "gAAA-reasoning", summary: [] },
        { type: "function_call", id: "call_1", name: "lookup", arguments: "{}", status: "completed" },
        {
          type: "message",
          role: "assistant",
          id: "msg_nested",
          status: "completed",
          content: [
            { type: "output_text", text: "before", annotations: [] },
            { type: "encrypted_content", encrypted_content: "gAAA-nested", id: "enc_1" },
            { type: "output_text", text: "after", annotations: [], metadata: { keep: true } },
          ],
        },
      ],
    },
    inputItems: [],
  };

  assert.equal(ctx.body.input[3].content[1].type, "encrypted_content");
  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  assert.deepEqual(sanitized.body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
    { type: "function_call", id: "call_1", name: "lookup", arguments: "{}", status: "completed" },
    {
      type: "message",
      role: "assistant",
      id: "msg_nested",
      status: "completed",
      content: [
        { type: "output_text", text: "before", annotations: [] },
        { type: "output_text", text: "after", annotations: [], metadata: { keep: true } },
      ],
    },
  ]);
  assert.equal(JSON.stringify(sanitized.body).includes('"type":"encrypted_content"'), false);
  assert.deepEqual(ctx.body.input[3].content[1], {
    type: "encrypted_content",
    encrypted_content: "gAAA-nested",
    id: "enc_1",
  });
});

test("sanitizeEncryptedReasoningRequest: omits encrypted-only messages while preserving empty and visible messages", () => {
  const preexistingEmpty = { type: "message", role: "assistant", content: [] };
  const encryptedOnly = {
    type: "message",
    role: "assistant",
    content: [{ type: "encrypted_content", encrypted_content: "history-only-cipher" }],
  };
  const untypedEncryptedOnly = {
    type: "message",
    role: "assistant",
    content: [{ encrypted_content: "history-untyped-cipher" }],
  };
  const mixed = {
    type: "message",
    role: "assistant",
    content: [
      { type: "output_text", text: "visible", encrypted_content: "visible-field-cipher" },
      { type: "encrypted_content", encrypted_content: "current-cipher" },
    ],
  };
  const historyInputItems = [preexistingEmpty, encryptedOnly, untypedEncryptedOnly, mixed];
  const ctx = {
    body: { model: "gpt-5.5", input: historyInputItems },
    inputItems: [],
    currentInputStart: 3,
    historyParentId: "resp_parent",
    historyRootId: "resp_root",
    historyInputItems,
  };
  const original = structuredClone(ctx);

  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  const expected = [
    preexistingEmpty,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible" }] },
  ];
  assert.deepEqual(sanitized.body.input, expected);
  assert.deepEqual(sanitized.historyInputItems, expected);
  assert.equal(sanitized.currentInputStart, 1);
  assert.equal(sanitized.body.input.some((item) => typeof item === "symbol"), false);
  assert.equal(sanitized.historyInputItems.some((item) => typeof item === "symbol"), false);
  assert.equal(JSON.stringify(sanitized).includes("encrypted_content"), false);
  assert.deepEqual(ctx, original);

  const emptyOnly = {
    body: { model: "gpt-5.5", input: [preexistingEmpty] },
    inputItems: [],
  };
  assert.equal(sanitizeEncryptedReasoningRequest(emptyOnly), null);
});

test("sanitizeEncryptedReasoningRequest: cleans array and stringified function outputs without breaking pairs", () => {
  const cases = [
    { callType: "function_call", outputType: "function_call_output", callId: "function_array", stringified: false },
    { callType: "function_call", outputType: "function_call_output", callId: "function_string", stringified: true },
    { callType: "custom_tool_call", outputType: "custom_tool_call_output", callId: "custom_array", stringified: false },
    { callType: "custom_tool_call", outputType: "custom_tool_call_output", callId: "custom_string", stringified: true },
  ];
  const input = cases.flatMap(({ callType, outputType, callId, stringified }) => {
    const call = callType === "function_call"
      ? { type: callType, id: `id_${callId}`, call_id: callId, name: "lookup", arguments: "{}" }
      : { type: callType, id: `id_${callId}`, call_id: callId, name: "shell", input: "pwd" };
    const parts = [
      { type: "input_text", text: `${callId} visible`, metadata: { keep: true }, encrypted_content: `${callId}-field` },
      { type: "encrypted_content", encrypted_content: `${callId}-part` },
    ];
    return [call, {
      type: outputType,
      call_id: callId,
      output: stringified ? JSON.stringify(parts) : parts,
    }];
  });
  const ctx = {
    body: {
      model: "gpt-5.5",
      store: false,
      input,
    },
    inputItems: [],
  };
  const original = structuredClone(ctx.body);

  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  const expected = cases.flatMap(({ callType, outputType, callId, stringified }) => {
    const call = callType === "function_call"
      ? { type: callType, id: `id_${callId}`, call_id: callId, name: "lookup", arguments: "{}" }
      : { type: callType, id: `id_${callId}`, call_id: callId, name: "shell", input: "pwd" };
    const visible = [{ type: "input_text", text: `${callId} visible`, metadata: { keep: true } }];
    return [call, {
      type: outputType,
      call_id: callId,
      output: stringified ? JSON.stringify(visible) : visible,
    }];
  });
  assert.deepEqual(sanitized.body.input, expected);
  assert.deepEqual(ctx.body, original);
  assert.equal(JSON.stringify(sanitized.body).includes("encrypted_content"), false);
  assert.deepEqual(sanitized.body.input.map((item) => item.type), expected.map((item) => item.type));
  assert.deepEqual(sanitized.body.input.map((item) => item.call_id), expected.map((item) => item.call_id));
});

test("sanitizeEncryptedReasoningRequest: replaces direct encrypted function and custom outputs with omission markers", () => {
  const cases = [
    { callType: "function_call", outputType: "function_call_output", callId: "function_direct" },
    { callType: "custom_tool_call", outputType: "custom_tool_call_output", callId: "custom_direct" },
  ];
  const input = cases.flatMap(({ callType, outputType, callId }) => [
    callType === "function_call"
      ? { type: callType, call_id: callId, name: "lookup", arguments: "{}" }
      : { type: callType, call_id: callId, name: "shell", input: "pwd" },
    {
      type: outputType,
      call_id: callId,
      output: { type: "encrypted_content", encrypted_content: `${callId}-part` },
      metadata: { keep: true },
    },
  ]);
  const ctx = { body: { model: "gpt-5.5", input }, inputItems: [] };
  const original = structuredClone(ctx.body);

  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  assert.deepEqual(sanitized.body.input.map((item) => item.type), input.map((item) => item.type));
  assert.deepEqual(sanitized.body.input.map((item) => item.call_id), input.map((item) => item.call_id));
  assert.deepEqual(sanitized.body.input.filter(isResponsesToolOutputItem).map((item) => item.output), [
    ENCRYPTED_TOOL_OUTPUT_MARKER,
    ENCRYPTED_TOOL_OUTPUT_MARKER,
  ]);
  assert.deepEqual(sanitized.body.input.filter(isResponsesToolOutputItem).map((item) => item.metadata), [
    { keep: true },
    { keep: true },
  ]);
  assert.equal(JSON.stringify(sanitized.body).includes("encrypted_content"), false);
  assert.deepEqual(ctx.body, original);
});

test("sanitizeEncryptedReasoningRequest: replaces encrypted-only array and stringified tool outputs with omission markers", () => {
  const cases = [
    { callType: "function_call", outputType: "function_call_output", callId: "function_array", stringified: false },
    { callType: "function_call", outputType: "function_call_output", callId: "function_string", stringified: true },
    { callType: "custom_tool_call", outputType: "custom_tool_call_output", callId: "custom_array", stringified: false },
    { callType: "custom_tool_call", outputType: "custom_tool_call_output", callId: "custom_string", stringified: true },
  ];
  const input = cases.flatMap(({ callType, outputType, callId, stringified }) => {
    const parts = [{ type: "encrypted_content", encrypted_content: `${callId}-part` }];
    return [
      callType === "function_call"
        ? { type: callType, call_id: callId, name: "lookup", arguments: "{}" }
        : { type: callType, call_id: callId, name: "shell", input: "pwd" },
      { type: outputType, call_id: callId, output: stringified ? JSON.stringify(parts) : parts },
    ];
  });
  const ctx = { body: { model: "gpt-5.5", input }, inputItems: [] };
  const original = structuredClone(ctx.body);

  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  assert.deepEqual(sanitized.body.input.map((item) => item.type), input.map((item) => item.type));
  assert.deepEqual(sanitized.body.input.map((item) => item.call_id), input.map((item) => item.call_id));
  assert.deepEqual(sanitized.body.input.filter(isResponsesToolOutputItem).map((item) => item.output), [
    ENCRYPTED_TOOL_OUTPUT_MARKER,
    ENCRYPTED_TOOL_OUTPUT_MARKER,
    ENCRYPTED_TOOL_OUTPUT_MARKER,
    ENCRYPTED_TOOL_OUTPUT_MARKER,
  ]);
  assert.equal(JSON.stringify(sanitized.body).includes("encrypted_content"), false);
  assert.deepEqual(ctx.body, original);
});

test("sanitizeEncryptedReasoningRequest: cleans history tool outputs without mutating source history", () => {
  const historyInputItems = [
    {
      type: "function_call_output",
      call_id: "history_function",
      output: [
        { type: "input_text", text: "visible history" },
        { type: "encrypted_content", encrypted_content: "history-function-part" },
      ],
    },
    {
      type: "custom_tool_call_output",
      call_id: "history_custom",
      output: [{ type: "encrypted_content", encrypted_content: "history-custom-part" }],
    },
  ];
  const ctx = {
    body: {
      model: "gpt-5.5",
      input: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "visible", encrypted_content: "body-part" }],
      }],
    },
    inputItems: [],
    historyInputItems,
  };
  const originalHistory = structuredClone(historyInputItems);

  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  assert.deepEqual(historyInputItems, originalHistory);
  assert.deepEqual(sanitized.historyInputItems, [
    {
      type: "function_call_output",
      call_id: "history_function",
      output: [{ type: "input_text", text: "visible history" }],
    },
    { type: "custom_tool_call_output", call_id: "history_custom", output: ENCRYPTED_TOOL_OUTPUT_MARKER },
  ]);
  assert.equal(JSON.stringify(sanitized.historyInputItems).includes("encrypted_content"), false);
});

test("sanitizeEncryptedReasoningRequest: preserves function call pairing when removing an encrypted field", () => {
  const ctx = {
    body: {
      model: "gpt-5.5",
      input: [
        {
          type: "function_call",
          id: "fc_pair",
          call_id: "call_pair",
          name: "lookup",
          arguments: "{}",
          encrypted_content: "call-part",
          metadata: { keep: true },
        },
        { type: "function_call_output", call_id: "call_pair", output: "visible output" },
      ],
    },
    inputItems: [],
  };

  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  assert.deepEqual(sanitized.body.input, [
    {
      type: "function_call",
      id: "fc_pair",
      call_id: "call_pair",
      name: "lookup",
      arguments: "{}",
      metadata: { keep: true },
    },
    { type: "function_call_output", call_id: "call_pair", output: "visible output" },
  ]);
});

test("sanitizeEncryptedReasoningRequest: removes compaction items as complete encrypted state", () => {
  const ctx = {
    body: {
      model: "gpt-5.5",
      input: [
        { type: "message", role: "user", content: "continue" },
        { type: "compaction", id: "cmp_encrypted", encrypted_content: "compaction-part" },
      ],
    },
    inputItems: [],
  };

  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  assert.deepEqual(sanitized.body.input, [{ type: "message", role: "user", content: "continue" }]);
});

test("sanitizeEncryptedReasoningRequest: keeps history parent when current input is sanitized", () => {
  const currentInput = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "visible", encrypted_content: "current-part" }],
  };
  const ctx = {
    body: {
      model: "gpt-5.5",
      input: [
        { type: "message", role: "user", content: "historical" },
        currentInput,
      ],
    },
    inputItems: [],
    currentInputStart: 1,
    historyParentId: "resp_parent",
    historyRootId: "resp_root",
    historyInputItems: [currentInput],
  };

  const sanitized = sanitizeEncryptedReasoningRequest(ctx);

  assert.equal(sanitized.historyParentId, "resp_parent");
  assert.equal(sanitized.historyRootId, "resp_root");
  assert.deepEqual(sanitized.historyInputItems, [{
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "visible" }],
  }]);
  assert.notStrictEqual(sanitized.historyInputItems, sanitized.body.input);
});

test("sanitizeEncryptedReasoningRequest: returns null when no encrypted reasoning is present", () => {
  const ctx = {
    body: { model: "gpt-5.5", input: [{ type: "message", role: "user", content: "hello" }] },
    inputItems: [],
  };

  assert.equal(sanitizeEncryptedReasoningRequest(ctx), null);
});
