import { test } from "node:test";
import assert from "node:assert/strict";
import { clearResponseHistoryForTests } from "../src/response-history.mjs";
import { openCopilotResponse } from "../src/copilot-responses-compat.mjs";
import {
  isImageNamespaceCollisionError,
  sanitizeImageNamespaceCollisionRequest,
} from "../src/copilot-responses-policy.mjs";
import { prepareResponsesRequest, rememberResponseHistory } from "../src/responses-request.mjs";

const ENCRYPTED_TOOL_OUTPUT_MARKER = "[CCDX: encrypted tool output omitted because upstream could not decrypt it.]";

test("openCopilotResponse: retries encrypted reasoning failures with sanitized input", async () => {
  const encryptedError = JSON.stringify({
    error: {
      message: "The encrypted content gAAA... could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
      code: "invalid_request_body",
    },
  });
  const calls = [];
  const payloadPrepared = [];
  const ctx = {
    body: {
      model: "gpt-5.5",
      store: false,
      stream: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "reasoning", encrypted_content: "gAAA", summary: [] },
        { type: "function_call", id: "call_retry", name: "lookup", arguments: "{}" },
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "visible", annotations: [] },
            { type: "encrypted_content", encrypted_content: "gAAA-nested" },
          ],
        },
      ],
    },
    inputItems: [],
  };
  const upstream = async (body, requestOptions) => {
    calls.push(body);
    payloadPrepared.push(requestOptions.payloadPrepared);
    if (calls.length === 1) {
      return new Response(encryptedError, { status: 400, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ id: "resp_1", output: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const opened = await openCopilotResponse(ctx, upstream);

  assert.equal(calls.length, 2);
  assert.deepEqual(payloadPrepared, [false, true]);
  assert.equal(opened.resp.ok, true);
  assert.equal(calls[0].input[3].content[1].encrypted_content, "gAAA-nested");
  assert.deepEqual(calls[1].input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    { type: "function_call", id: "call_retry", name: "lookup", arguments: "{}" },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "visible", annotations: [] }],
    },
  ]);
  assert.deepEqual(opened.reqContext.inputItems, calls[1].input);
  assert.deepEqual(await opened.resp.json(), { id: "resp_1", output: [] });
});

test("openCopilotResponse: retries exact encrypted function output failures with intact first payload", async () => {
  const encryptedError = JSON.stringify({
    error: {
      message: "Encrypted function output content could not be decrypted or decoded.",
      code: "invalid_request_body",
    },
  });
  const ctx = {
    body: {
      model: "gpt-5.5",
      store: false,
      input: [
        { type: "function_call", call_id: "call_function", name: "lookup", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "call_function",
          output: [
            { type: "input_text", text: "function visible" },
            { type: "encrypted_content", encrypted_content: "function-part" },
          ],
        },
        { type: "custom_tool_call", call_id: "call_custom", name: "shell", input: "pwd" },
        {
          type: "custom_tool_call_output",
          call_id: "call_custom",
          output: JSON.stringify([
            { type: "input_text", text: "custom visible" },
            { type: "encrypted_content", encrypted_content: "custom-part" },
          ]),
        },
      ],
    },
    inputItems: [],
  };
  const original = structuredClone(ctx.body);
  const calls = [];
  const upstream = async (body) => {
    calls.push(structuredClone(body));
    return calls.length === 1
      ? new Response(encryptedError, { status: 400, headers: { "Content-Type": "application/json" } })
      : Response.json({ id: "resp_function_output", output: [] });
  };

  const opened = await openCopilotResponse(ctx, upstream);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], original);
  assert.deepEqual(calls[1].input.map((item) => item.type), [
    "function_call",
    "function_call_output",
    "custom_tool_call",
    "custom_tool_call_output",
  ]);
  assert.deepEqual(calls[1].input[1].output, [{ type: "input_text", text: "function visible" }]);
  assert.deepEqual(JSON.parse(calls[1].input[3].output), [{ type: "input_text", text: "custom visible" }]);
  assert.equal(JSON.stringify(calls[1]).includes("encrypted_content"), false);
  assert.equal(opened.resp.ok, true);
});

test("openCopilotResponse: exact function output fallback retries once and unrelated errors do not retry", async () => {
  const encryptedError = JSON.stringify({
    error: { message: "Encrypted function output content could not be decrypted or decoded." },
  });
  const ctx = {
    body: {
      model: "gpt-5.5",
      input: [{
        type: "custom_tool_call_output",
        call_id: "call_once",
        output: JSON.stringify([
          { type: "encrypted_content", encrypted_content: "custom-part" },
          { type: "input_text", text: "visible" },
        ]),
      }],
    },
    inputItems: [],
  };
  let encryptedCalls = 0;
  const failed = await openCopilotResponse(ctx, async () => {
    encryptedCalls += 1;
    return new Response(encryptedError, { status: 400 });
  });
  assert.equal(encryptedCalls, 2);
  assert.equal(failed.errorText, encryptedError);

  const unrelatedError = JSON.stringify({ error: { message: "Function output is invalid." } });
  let unrelatedCalls = 0;
  const unrelated = await openCopilotResponse(ctx, async () => {
    unrelatedCalls += 1;
    return new Response(unrelatedError, { status: 400 });
  });
  assert.equal(unrelatedCalls, 1);
  assert.equal(unrelated.errorText, unrelatedError);
});

test("openCopilotResponse: missing encrypted_content retries once only when sanitization changes input", async () => {
  const missingEncryptedContentError = JSON.stringify({
    error: {
      message: "Missing required parameter: 'input[3].content[1].encrypted_content'.",
      code: "missing_required_parameter",
    },
  });
  const encryptedCtx = {
    body: {
      model: "gpt-5.5",
      input: [{
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "visible" },
          { type: "encrypted_content", encrypted_content: "nested-part" },
        ],
      }],
    },
    inputItems: [],
  };
  const encryptedCalls = [];
  const failed = await openCopilotResponse(encryptedCtx, async (body) => {
    encryptedCalls.push(structuredClone(body));
    return new Response(missingEncryptedContentError, { status: 400 });
  });

  assert.equal(encryptedCalls.length, 2);
  assert.equal(encryptedCalls[0].input[0].content[1].encrypted_content, "nested-part");
  assert.deepEqual(encryptedCalls[1].input[0].content, [{ type: "output_text", text: "visible" }]);
  assert.equal(failed.errorText, missingEncryptedContentError);

  const cleanCtx = {
    body: { model: "gpt-5.5", input: [{ type: "message", role: "user", content: "hello" }] },
    inputItems: [],
  };
  let cleanCalls = 0;
  const cleanFailed = await openCopilotResponse(cleanCtx, async () => {
    cleanCalls += 1;
    return new Response(missingEncryptedContentError, { status: 400 });
  });

  assert.equal(cleanCalls, 1);
  assert.equal(cleanFailed.errorText, missingEncryptedContentError);
});

test("openCopilotResponse: exact missing encrypted message retry omits the message and rebases history", async () => {
  const missingEncryptedContentError = JSON.stringify({
    error: {
      message: "Missing required parameter: 'input[0].content[0].encrypted_content'.",
      code: "missing_required_parameter",
    },
  });
  const encryptedOnly = {
    type: "message",
    role: "assistant",
    content: [{ type: "encrypted_content", encrypted_content: "history-message-cipher" }],
  };
  const current = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "continue" }],
  };
  const ctx = {
    body: { model: "gpt-5.5", input: [encryptedOnly, current] },
    inputItems: [current],
    currentInputStart: 1,
    historyParentId: "resp_encrypted_message_parent",
    historyRootId: "resp_encrypted_message_root",
    historyInputItems: [current],
  };
  const originalBody = structuredClone(ctx.body);
  const calls = [];
  const currentInputStarts = [];

  const opened = await openCopilotResponse(ctx, async (body, options) => {
    calls.push(structuredClone(body));
    currentInputStarts.push(options.currentInputStart);
    return calls.length === 1
      ? new Response(missingEncryptedContentError, { status: 400 })
      : Response.json({ id: "resp_clean_message", status: "completed", output: [] });
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], originalBody);
  assert.deepEqual(calls[1].input, [current]);
  assert.deepEqual(currentInputStarts, [1, 0]);
  assert.equal(calls[1].input.some((item) => typeof item === "symbol"), false);
  assert.equal(calls[1].input.some((item) => Array.isArray(item?.content) && item.content.length === 0), false);
  assert.equal(opened.reqContext.historyParentId, null);
  assert.equal(opened.reqContext.historyRootId, null);
  assert.equal(opened.reqContext.currentInputStart, 0);
  assert.strictEqual(opened.reqContext.historyInputItems, opened.reqContext.body.input);
  assert.deepEqual(opened.reqContext.historyInputItems, [current]);
});

test("encrypted history retry rebases the successful branch without rewriting the old response branch", async () => {
  clearResponseHistoryForTests();
  try {
    const root = prepareResponsesRequest({
      model: "gpt-5.5",
      input: [{ type: "message", role: "user", content: "start" }],
    });
    rememberResponseHistory(root, {
      id: "resp_cipher_root",
      status: "completed",
      output: [
        {
          type: "reasoning",
          id: "rs_history",
          encrypted_content: "root-reasoning-cipher",
          summary: [],
        },
        {
          type: "function_call",
          id: "fc_history",
          call_id: "call_function",
          name: "lookup",
          arguments: "{}",
          encrypted_content: "root-function-cipher",
        },
        {
          type: "custom_tool_call",
          id: "ct_history",
          call_id: "call_custom",
          name: "shell",
          input: "pwd",
          encrypted_content: "root-custom-cipher",
        },
      ],
    });

    const second = prepareResponsesRequest({
      model: "gpt-5.5",
      previous_response_id: "resp_cipher_root",
      input: [
        { type: "function_call_output", call_id: "call_function", output: "function visible" },
        { type: "custom_tool_call_output", call_id: "call_custom", output: "custom visible" },
      ],
    });
    const originalSecondBody = structuredClone(second.body);
    const exactError = JSON.stringify({
      error: { message: "Encrypted function output content could not be decrypted or decoded." },
    });
    const secondCalls = [];
    const opened = await openCopilotResponse(second, async (body) => {
      secondCalls.push(structuredClone(body));
      return secondCalls.length === 1
        ? new Response(exactError, { status: 400 })
        : Response.json({
          id: "resp_clean_child",
          status: "completed",
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          }],
        });
    });

    assert.equal(secondCalls.length, 2);
    assert.deepEqual(secondCalls[0], originalSecondBody);
    assert.equal(JSON.stringify(secondCalls[0]).includes("root-reasoning-cipher"), true);
    assert.deepEqual(secondCalls[1].input.map((item) => item.type), [
      "message",
      "function_call",
      "custom_tool_call",
      "function_call_output",
      "custom_tool_call_output",
    ]);
    assert.deepEqual(secondCalls[1].input.map((item) => item.call_id), [
      undefined,
      "call_function",
      "call_custom",
      "call_function",
      "call_custom",
    ]);
    assert.equal(JSON.stringify(secondCalls[1]).includes("encrypted_content"), false);
    assert.equal(opened.reqContext.historyParentId, null);
    assert.equal(opened.reqContext.historyRootId, null);
    assert.strictEqual(opened.reqContext.historyInputItems, opened.reqContext.body.input);

    rememberResponseHistory(opened.reqContext, await opened.resp.json());
    const third = prepareResponsesRequest({
      model: "gpt-5.5",
      previous_response_id: "resp_clean_child",
      input: "next",
    });
    const thirdCalls = [];
    await openCopilotResponse(third, async (body) => {
      thirdCalls.push(structuredClone(body));
      return Response.json({ id: "resp_third", status: "completed", output: [] });
    });

    assert.equal(thirdCalls.length, 1);
    assert.equal(JSON.stringify(thirdCalls[0]).includes("root-reasoning-cipher"), false);
    assert.equal(JSON.stringify(thirdCalls[0]).includes("root-function-cipher"), false);
    assert.equal(JSON.stringify(thirdCalls[0]).includes("root-custom-cipher"), false);
    assert.deepEqual(
      thirdCalls[0].input
        .filter((item) => ["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(item.type))
        .map((item) => [item.type, item.call_id]),
      [
        ["function_call", "call_function"],
        ["custom_tool_call", "call_custom"],
        ["function_call_output", "call_function"],
        ["custom_tool_call_output", "call_custom"],
      ],
    );

    const oldBranch = prepareResponsesRequest({
      model: "gpt-5.5",
      previous_response_id: "resp_cipher_root",
      input: "old branch",
    });
    assert.equal(JSON.stringify(oldBranch.body).includes("root-function-cipher"), true);
    assert.equal(JSON.stringify(oldBranch.body).includes("root-custom-cipher"), true);
  } finally {
    clearResponseHistoryForTests();
  }
});

test("openCopilotResponse: history rebase waits for the final payload after an image retry", async () => {
  const currentOutput = { type: "function_call_output", call_id: "call_history", output: "visible" };
  const ctx = {
    body: {
      model: "gpt-5.5",
      tools: [{ type: "image_gen" }],
      input: [
        { type: "reasoning", encrypted_content: "history-reasoning-cipher", summary: [] },
        {
          type: "function_call",
          call_id: "call_history",
          name: "lookup",
          arguments: "{}",
          encrypted_content: "history-cipher",
        },
        currentOutput,
      ],
    },
    inputItems: [],
    currentInputStart: 2,
    historyParentId: "resp_history_parent",
    historyRootId: "resp_history_root",
    historyInputItems: [currentOutput],
  };
  const encryptedError = JSON.stringify({
    error: { message: "Encrypted function output content could not be decrypted or decoded." },
  });
  const imageError = JSON.stringify({
    error: { message: "Namespace image_gen collided with an upstream tool namespace." },
  });
  const calls = [];
  const currentInputStarts = [];

  const opened = await openCopilotResponse(ctx, async (body, options) => {
    calls.push(structuredClone(body));
    currentInputStarts.push(options.currentInputStart);
    if (calls.length === 1) return new Response(encryptedError, { status: 400 });
    if (calls.length === 2) return new Response(imageError, { status: 400 });
    return Response.json({ id: "resp_final_payload", status: "completed", output: [] });
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(currentInputStarts, [2, 1, 1]);
  assert.equal(JSON.stringify(calls[0]).includes("history-cipher"), true);
  assert.equal(JSON.stringify(calls[1]).includes("history-cipher"), false);
  assert.deepEqual(calls[1].tools, [{ type: "image_gen" }]);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[2], "tools"), false);
  assert.deepEqual(opened.reqContext.body, calls[2]);
  assert.equal(opened.reqContext.historyParentId, null);
  assert.equal(opened.reqContext.historyRootId, null);
  assert.equal(opened.reqContext.currentInputStart, 1);
  assert.strictEqual(opened.reqContext.historyInputItems, opened.reqContext.body.input);
  assert.strictEqual(opened.reqContext.inputItems, opened.reqContext.body.input);
});

test("openCopilotResponse: mixed historical and current encrypted content still rebases history", async () => {
  const ctx = {
    body: {
      model: "gpt-5.5",
      input: [
        {
          type: "function_call",
          call_id: "call_mixed",
          name: "lookup",
          arguments: "{}",
          encrypted_content: "historical-cipher",
        },
        {
          type: "function_call_output",
          call_id: "call_mixed",
          output: { type: "encrypted_content", encrypted_content: "current-cipher" },
        },
      ],
    },
    inputItems: [],
    currentInputStart: 1,
    historyParentId: "resp_mixed_parent",
    historyRootId: "resp_mixed_root",
    historyInputItems: [{
      type: "function_call_output",
      call_id: "call_mixed",
      output: { type: "encrypted_content", encrypted_content: "current-cipher" },
    }],
  };
  const exactError = JSON.stringify({
    error: { message: "Encrypted function output content could not be decrypted or decoded." },
  });
  const calls = [];

  const opened = await openCopilotResponse(ctx, async (body) => {
    calls.push(structuredClone(body));
    return calls.length === 1
      ? new Response(exactError, { status: 400 })
      : Response.json({ id: "resp_mixed_clean", status: "completed", output: [] });
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].input.map((item) => [item.type, item.call_id]), [
    ["function_call", "call_mixed"],
    ["function_call_output", "call_mixed"],
  ]);
  assert.equal(calls[1].input[1].output, ENCRYPTED_TOOL_OUTPUT_MARKER);
  assert.equal(JSON.stringify(calls[1]).includes("encrypted_content"), false);
  assert.equal(opened.reqContext.historyParentId, null);
  assert.equal(opened.reqContext.historyRootId, null);
  assert.strictEqual(opened.reqContext.historyInputItems, opened.reqContext.body.input);
});

test("openCopilotResponse: a failed encrypted retry does not rebase history", async () => {
  const currentOutput = { type: "custom_tool_call_output", call_id: "call_history", output: "visible" };
  const ctx = {
    body: {
      model: "gpt-5.5",
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_history",
          name: "shell",
          input: "pwd",
          encrypted_content: "history-cipher",
        },
        currentOutput,
      ],
    },
    inputItems: [],
    currentInputStart: 1,
    historyParentId: "resp_history_parent",
    historyRootId: "resp_history_root",
    historyInputItems: [currentOutput],
  };
  const encryptedError = JSON.stringify({
    error: { message: "Encrypted function output content could not be decrypted or decoded." },
  });
  let calls = 0;

  const opened = await openCopilotResponse(ctx, async () => {
    calls += 1;
    return new Response(encryptedError, { status: 400 });
  });

  assert.equal(calls, 2);
  assert.equal(opened.reqContext.historyParentId, "resp_history_parent");
  assert.equal(opened.reqContext.historyRootId, "resp_history_root");
  assert.notStrictEqual(opened.reqContext.historyInputItems, opened.reqContext.body.input);
});

test("openCopilotResponse: returns the second upstream error after one encrypted fallback retry", async () => {
  const encryptedError = JSON.stringify({
    error: {
      message: "The encrypted content gAAA... could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
      code: "invalid_request_body",
    },
  });
  const secondError = JSON.stringify({
    error: {
      message: "Missing required parameter: 'input[3].content[1].encrypted_content'.",
      code: "missing_required_parameter",
    },
  });
  const calls = [];
  const ctx = {
    body: {
      model: "gpt-5.5",
      store: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
        { type: "reasoning", encrypted_content: "gAAA-reasoning", summary: [] },
        { type: "function_call", id: "call_error", name: "lookup", arguments: "{}" },
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "visible", annotations: [] },
            { type: "encrypted_content", encrypted_content: "gAAA-nested" },
          ],
        },
      ],
    },
    inputItems: [],
  };
  const upstream = async (body) => {
    calls.push(body);
    return new Response(calls.length === 1 ? encryptedError : secondError, {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  };

  const opened = await openCopilotResponse(ctx, upstream);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].input[3].content[1].encrypted_content, "gAAA-nested");
  assert.deepEqual(calls[1].input.at(-1).content, [
    { type: "output_text", text: "visible", annotations: [] },
  ]);
  assert.equal(opened.resp.status, 400);
  assert.equal(opened.errorText, secondError);
});

test("openCopilotResponse: does not retry encrypted errors when nothing can be sanitized", async () => {
  const encryptedError = JSON.stringify({
    error: {
      message: "The encrypted content gAAA... could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
      code: "invalid_request_body",
    },
  });
  const calls = [];
  const ctx = {
    body: { model: "gpt-5.5", stream: false, input: [{ type: "message", role: "user", content: "hello" }] },
    inputItems: [],
  };
  const upstream = async (body) => {
    calls.push(body);
    return new Response(encryptedError, { status: 400, headers: { "Content-Type": "application/json" } });
  };

  const opened = await openCopilotResponse(ctx, upstream);

  assert.equal(calls.length, 1);
  assert.equal(opened.resp.status, 400);
  assert.equal(opened.errorText, encryptedError);
});

test("openCopilotResponse: retries an explicit image_gen namespace collision once", async () => {
  const collision = JSON.stringify({
    error: { message: "User-defined namespace 'image_gen' collides with an existing tool namespace." },
  });
  const calls = [];
  const payloadPrepared = [];
  const ctx = {
    body: {
      model: "gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: "hello" }],
      tools: [
        { type: "function", namespace: "image_gen.v2", name: "render" },
        { type: "image_gen_future", name: "future_render" },
        { type: "function", name: "lookup" },
      ],
      tool_choice: { type: "function", namespace: "image_gen.v2", name: "render" },
    },
    inputItems: [],
  };
  const upstream = async (body, requestOptions) => {
    calls.push(body);
    payloadPrepared.push(requestOptions.payloadPrepared);
    if (calls.length === 1) return new Response(collision, { status: 400 });
    return new Response(JSON.stringify({ id: "resp_ok", output: [] }), { status: 200 });
  };

  const opened = await openCopilotResponse(ctx, upstream);

  assert.equal(isImageNamespaceCollisionError(400, collision), true);
  assert.equal(opened.resp.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(payloadPrepared, [false, true]);
  assert.deepEqual(calls[1].tools, [{ type: "function", name: "lookup" }]);
  assert.equal(calls[1].tool_choice, "none");
  const sanitized = sanitizeImageNamespaceCollisionRequest(ctx);
  assert.deepEqual(sanitized.body.tools, [{ type: "function", name: "lookup" }]);
  assert.equal(sanitized.body.tool_choice, "none");
});
