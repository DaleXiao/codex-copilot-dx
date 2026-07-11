import { test } from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import * as zlib from "node:zlib";
import {
  abortErrorStatusCode,
  clearResponseHistoryForTests,
  configureResponseHistoryForTests,
  createAdapterHandler,
  createRequestAbort,
  isAbortLikeError,
  isEncryptedContentVerificationError,
  isImageNamespaceCollisionError,
  forwardToChat,
  openCopilotResponse,
  prepareResponsesRequest,
  readJsonBody,
  rememberResponseHistory,
  responseHistoryStats,
  requestPath,
  responsesToChat,
  sanitizeImageNamespaceCollisionRequest,
  sanitizeEncryptedReasoningRequest,
  shouldServeClaudeDesktopModels,
  stripInternalResponsesInputFields,
  writeOrDrain,
} from "../src/adapter.mjs";

const gzipAsync = promisify(zlib.gzip);
const zstdCompressAsync = zlib.zstdCompress ? promisify(zlib.zstdCompress) : null;

function jsonRequest(body, contentEncoding, headers = {}) {
  const req = Readable.from([body]);
  req.headers = { ...headers };
  if (contentEncoding) req.headers["content-encoding"] = contentEncoding;
  return req;
}

async function invokeAdapter(options, { method = "POST", url = "/v1/responses", body, headers = {} } = {}) {
  const req = jsonRequest(Buffer.from(JSON.stringify(body ?? {})), undefined, { "content-type": "application/json", ...headers });
  req.method = method;
  req.url = url;

  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.headersSent = false;
  res.statusCode = 200;
  res.headers = {};
  const chunks = [];
  res.writeHead = (statusCode, headers = {}) => {
    res.statusCode = statusCode;
    res.headers = { ...res.headers, ...headers };
    res.headersSent = true;
    return res;
  };
  res.write = (chunk) => {
    chunks.push(Buffer.from(chunk));
    return true;
  };
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  res.end = (chunk) => {
    if (chunk !== undefined) chunks.push(Buffer.from(chunk));
    res.writableEnded = true;
    finish();
    return res;
  };

  const pending = createAdapterHandler(options)(req, res);
  await Promise.all([pending, finished]);
  return {
    status: res.statusCode,
    headers: res.headers,
    text: Buffer.concat(chunks).toString("utf8"),
  };
}

test("requestPath: ignores Claude Code beta query on messages route", () => {
  assert.equal(requestPath("/v1/messages?beta=true"), "/v1/messages");
});

test("requestPath: ignores query strings on other API routes", () => {
  assert.equal(requestPath("/v1/messages/count_tokens?beta=true"), "/v1/messages/count_tokens");
  assert.equal(requestPath("/v1/responses?stream=true"), "/v1/responses");
  assert.equal(requestPath("/v1/responses/compact?stream=true"), "/v1/responses/compact");
  assert.equal(requestPath("/v1/models?foo=bar"), "/v1/models");
});

test("shouldServeClaudeDesktopModels: detects only configured Desktop keys", () => {
  assert.equal(shouldServeClaudeDesktopModels({ headers: { "anthropic-version": "2023-06-01" } }, ""), false);
  assert.equal(shouldServeClaudeDesktopModels({ headers: { authorization: "Bearer ccdx_secret" } }, "ccdx_secret"), true);
  assert.equal(shouldServeClaudeDesktopModels({ headers: { "x-api-key": "ccdx_secret" } }, "ccdx_secret"), true);
  assert.equal(shouldServeClaudeDesktopModels({ headers: { authorization: "Bearer dummy" } }, "dummy"), false);
  assert.equal(shouldServeClaudeDesktopModels({ headers: { authorization: "Bearer other" } }, "ccdx_secret"), false);
});

test("createRequestAbort: records client close reason", () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writableEnded = false;

  const abort = createRequestAbort(req, res);
  res.emit("close");

  assert.equal(abort.signal.aborted, true);
  assert.equal(abort.reason, "client_closed");
  abort.cleanup();
});

test("createRequestAbort: ignores normal response close after end", () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writableEnded = true;

  const abort = createRequestAbort(req, res);
  res.emit("close");

  assert.equal(abort.signal.aborted, false);
  assert.equal(abort.reason, null);
  abort.cleanup();
});

test("createRequestAbort: records timeout reason", async () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writableEnded = false;

  const abort = createRequestAbort(req, res);
  abort.setTimeout(1);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(abort.signal.aborted, true);
  assert.equal(abort.reason, "upstream_timeout");
  abort.cleanup();
});

test("abort helpers classify expected abort errors", () => {
  assert.equal(isAbortLikeError(new DOMException("This operation was aborted", "AbortError")), true);
  assert.equal(isAbortLikeError(new Error("This operation was aborted")), true);
  assert.equal(isAbortLikeError(new Error("socket hang up")), false);
  assert.equal(abortErrorStatusCode("upstream_timeout"), 504);
  assert.equal(abortErrorStatusCode("stream_handshake_timeout"), 504);
  assert.equal(abortErrorStatusCode("stream_idle_timeout"), 504);
  assert.equal(abortErrorStatusCode("client_closed"), 499);
});

test("HTTP streaming responses time out while waiting for upstream headers", async () => {
  const result = await invokeAdapter({
    streamHandshakeTimeoutMs: 5,
    chatCompletionsFn: (_body, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")), { once: true });
    }),
  }, {
    body: { model: "gpt-4o", stream: true, input: "hello" },
  });

  assert.equal(result.status, 504);
  assert.match(result.text, /aborted/i);
});

test("HTTP streaming responses time out when the upstream body becomes idle", async () => {
  const result = await invokeAdapter({
    streamIdleTimeoutMs: 5,
    chatCompletionsFn: (_body, { signal }) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"));
          signal.addEventListener("abort", () => controller.error(new DOMException("This operation was aborted", "AbortError")), { once: true });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    },
  }, {
    body: { model: "gpt-4o", stream: true, input: "hello" },
  });

  assert.equal(result.status, 200);
  assert.match(result.text, /response\.output_text\.delta/);
  assert.match(result.text, /aborted/i);
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

test("response history stores incremental nodes and enforces a byte budget", () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 500, maxEntries: 100 });

  const first = prepareResponsesRequest({ model: "gpt-5.5", input: "a".repeat(300) });
  rememberResponseHistory(first, {
    id: "resp_large",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "b".repeat(300) }] }],
  });

  assert.equal(responseHistoryStats().entries, 0);
  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "resp_large", input: "next" }),
    /was evicted after reaching the local history limit/,
  );
  clearResponseHistoryForTests();
});

test("oversized history entries do not evict unrelated conversations", () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 500, maxEntries: 100 });

  const small = prepareResponsesRequest({ model: "gpt-5.5", input: "small" });
  rememberResponseHistory(small, { id: "resp_small", output: [] });
  const large = prepareResponsesRequest({ model: "gpt-5.5", input: "x".repeat(600) });
  rememberResponseHistory(large, { id: "resp_large", output: [] });

  assert.equal(responseHistoryStats().entries, 1);
  assert.equal(
    prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "resp_small", input: "next" }).body.input.length,
    2,
  );
  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "resp_large", input: "next" }),
    /was evicted after reaching the local history limit/,
  );
  clearResponseHistoryForTests();
});

test("response history byte accounting matches serialized JSON", () => {
  clearResponseHistoryForTests();
  const prepared = prepareResponsesRequest({ model: "gpt-5.5", input: `quote=\" slash=\\ newline=\n unicode=é😀 lone=\ud800` });
  const output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }];
  rememberResponseHistory(prepared, { id: "resp_bytes", output });

  assert.equal(
    responseHistoryStats().bytes,
    Buffer.byteLength(JSON.stringify([prepared.historyInputItems, output])),
  );
  clearResponseHistoryForTests();
});

test("response history grows linearly across chained turns", () => {
  clearResponseHistoryForTests();
  let previousId = null;
  for (let i = 0; i < 20; i += 1) {
    const prepared = prepareResponsesRequest({
      model: "gpt-5.5",
      ...(previousId ? { previous_response_id: previousId } : {}),
      input: `turn-${i}`,
    });
    previousId = `resp_${i}`;
    rememberResponseHistory(prepared, {
      id: previousId,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `answer-${i}` }] }],
    });
  }

  const stats = responseHistoryStats();
  assert.equal(stats.entries, 20);
  assert.ok(stats.bytes < 20_000);
  const final = prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: previousId, input: "final" });
  assert.equal(final.body.input.length, 41);
  clearResponseHistoryForTests();
});

test("response history eviction removes descendants without affecting other roots", () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 1_000_000, maxEntries: 3 });

  const root = prepareResponsesRequest({ model: "gpt-5.5", input: "root" });
  rememberResponseHistory(root, { id: "resp_root", output: [] });
  const child = prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "resp_root", input: "child" });
  rememberResponseHistory(child, { id: "resp_child", output: [] });
  rememberResponseHistory(prepareResponsesRequest({ model: "gpt-5.5", input: "other" }), { id: "resp_other", output: [] });
  rememberResponseHistory(prepareResponsesRequest({ model: "gpt-5.5", input: "newer" }), { id: "resp_newer", output: [] });

  assert.equal(responseHistoryStats().entries, 2);
  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "resp_child", input: "next" }),
    /was evicted after reaching the local history limit/,
  );
  assert.equal(
    prepareResponsesRequest({ model: "gpt-5.5", previous_response_id: "resp_other", input: "next" }).body.input.length,
    2,
  );
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
});

test("responsesToChat: preserves flat Responses function tools", () => {
  const converted = responsesToChat({
    model: "gpt-4o",
    input: "hello",
    tools: [{
      type: "function",
      name: "lookup",
      description: "Look something up",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      strict: true,
    }],
  });

  assert.deepEqual(converted.tools, [{
    type: "function",
    function: {
      name: "lookup",
      description: "Look something up",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      strict: true,
    },
  }]);
});

test("responsesToChat: preserves image detail and unsupported content as text", () => {
  const converted = responsesToChat({
    model: "gpt-4o",
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "inspect" },
        { type: "input_image", image_url: "data:image/png;base64,YQ==", detail: "high" },
        { type: "input_file", filename: "note.txt", file_data: "data:text/plain;base64,YQ==" },
      ],
    }],
  });

  assert.deepEqual(converted.messages[0].content, [
    { type: "text", text: "inspect" },
    { type: "image_url", image_url: { url: "data:image/png;base64,YQ==", detail: "high" } },
    { type: "text", text: JSON.stringify({ type: "input_file", filename: "note.txt", file_data: "data:text/plain;base64,YQ==" }) },
  ]);
});

test("HTTP responses route preserves 0.4.23 image_gen compatibility", async () => {
  let upstreamBody;
  const response = await invokeAdapter({
    responsesFn: async (body) => {
      upstreamBody = body;
      return new Response(JSON.stringify({ id: "resp_img", status: "completed", output: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  }, {
    body: {
      model: "gpt-5.6-sol",
      input: "hello",
      tools: [
        { type: "image_generation", namespace: "image_gen" },
        { type: "function", name: "lookup", parameters: { type: "object" } },
      ],
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(upstreamBody.tools, [
    { type: "function", name: "lookup", parameters: { type: "object" } },
  ]);
});

test("HTTP non-stream Responses conversion preserves upstream error status", async () => {
  const response = await invokeAdapter({
    chatCompletionsFn: async () => new Response(JSON.stringify({ error: { message: "denied" } }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }),
  }, {
    body: { model: "gpt-4o", input: "hello", stream: false },
  });

  assert.equal(response.status, 403);
  assert.deepEqual(JSON.parse(response.text), { error: { message: "denied" } });
});

test("HTTP non-stream Responses conversion returns text, tools, and usage", async () => {
  let upstreamBody;
  const previousDisableUsage = process.env.CCDX_DISABLE_USAGE;
  process.env.CCDX_DISABLE_USAGE = "1";
  let response;
  try {
    response = await invokeAdapter({
      chatCompletionsFn: async (body) => {
        upstreamBody = body;
        return new Response(JSON.stringify({
          id: "chatcmpl_ok",
          model: "gpt-4o",
          choices: [{
            message: {
              role: "assistant",
              content: "done",
              tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }],
            },
          }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    }, {
      body: { model: "gpt-4o", input: "hello", stream: false },
    });
  } finally {
    if (previousDisableUsage === undefined) delete process.env.CCDX_DISABLE_USAGE;
    else process.env.CCDX_DISABLE_USAGE = previousDisableUsage;
  }

  const data = JSON.parse(response.text);
  assert.equal(response.status, 200);
  assert.equal(upstreamBody.stream, false);
  assert.deepEqual(data.output.map((item) => item.type), ["message", "function_call"]);
  assert.deepEqual(data.usage, { input_tokens: 11, output_tokens: 7, total_tokens: 18 });
});

test("HTTP non-stream Messages route preserves upstream error status", async () => {
  const response = await invokeAdapter({
    chatCompletionsFn: async () => new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    }),
  }, {
    url: "/v1/messages",
    body: { model: "claude-sonnet-4.6", messages: [{ role: "user", content: "hello" }], stream: false },
  });

  assert.equal(response.status, 429);
  assert.deepEqual(JSON.parse(response.text), { error: { message: "rate limited" } });
});

test("HTTP models route reads the live model registry on every request", async () => {
  const modelRegistry = {
    modelDefs: [{ id: "claude-a", upstream: "claude-a", displayName: "Claude A" }],
  };
  const options = { claudeDesktopApiKey: "ccdx_test", modelRegistry };
  const request = {
    method: "GET",
    url: "/v1/models",
    headers: { authorization: "Bearer ccdx_test" },
  };

  const first = await invokeAdapter(options, request);
  assert.deepEqual(JSON.parse(first.text).data.map((model) => model.id), ["claude-a"]);

  modelRegistry.modelDefs = [{ id: "claude-b", upstream: "claude-b", displayName: "Claude B" }];
  const second = await invokeAdapter(options, request);
  assert.deepEqual(JSON.parse(second.text).data.map((model) => model.id), ["claude-b"]);
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

  assert.equal(isEncryptedContentVerificationError(400, text), true);
  assert.equal(isEncryptedContentVerificationError(200, text), false);
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

test("sanitizeEncryptedReasoningRequest: returns null when no encrypted reasoning is present", () => {
  const ctx = {
    body: { model: "gpt-5.5", input: [{ type: "message", role: "user", content: "hello" }] },
    inputItems: [],
  };

  assert.equal(sanitizeEncryptedReasoningRequest(ctx), null);
});

test("openCopilotResponse: retries encrypted reasoning failures with sanitized input", async () => {
  const encryptedError = JSON.stringify({
    error: {
      message: "The encrypted content gAAA... could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
      code: "invalid_request_body",
    },
  });
  const calls = [];
  const ctx = {
    body: {
      model: "gpt-5.5",
      stream: false,
      input: [
        { type: "reasoning", encrypted_content: "gAAA", summary: [] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      ],
    },
    inputItems: [],
  };
  const upstream = async (body) => {
    calls.push(body);
    if (calls.length === 1) {
      return new Response(encryptedError, { status: 400, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ id: "resp_1", output: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const opened = await openCopilotResponse(ctx, upstream);

  assert.equal(calls.length, 2);
  assert.equal(opened.resp.ok, true);
  assert.deepEqual(calls[1].input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
  ]);
  assert.deepEqual(opened.reqContext.inputItems, calls[1].input);
  assert.deepEqual(await opened.resp.json(), { id: "resp_1", output: [] });
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
  const ctx = {
    body: {
      model: "gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: "hello" }],
      tools: [
        { type: "function", namespace: "image_gen.v2", name: "render" },
        { type: "image_gen_future", name: "future_render" },
        { type: "function", name: "lookup" },
      ],
    },
    inputItems: [],
  };
  const upstream = async (body) => {
    calls.push(body);
    if (calls.length === 1) return new Response(collision, { status: 400 });
    return new Response(JSON.stringify({ id: "resp_ok", output: [] }), { status: 200 });
  };

  const opened = await openCopilotResponse(ctx, upstream);

  assert.equal(isImageNamespaceCollisionError(400, collision), true);
  assert.equal(opened.resp.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].tools, [{ type: "function", name: "lookup" }]);
  assert.deepEqual(sanitizeImageNamespaceCollisionRequest(ctx).body.tools, [{ type: "function", name: "lookup" }]);
});

test("readJsonBody: parses gzip-compressed JSON request bodies", async () => {
  const compressed = await gzipAsync(JSON.stringify({ model: "gpt-5.5", input: "hello" }));
  const parsed = await readJsonBody(jsonRequest(compressed, "gzip"));

  assert.deepEqual(parsed, { model: "gpt-5.5", input: "hello" });
});

test("readJsonBody: rejects raw request bodies above the configured limit", async () => {
  await assert.rejects(
    readJsonBody(jsonRequest(Buffer.from("{}"), undefined, { "content-length": "2" }), { maxBodyBytes: 1 }),
    (err) => err.statusCode === 413 && /Raw request body/.test(err.message),
  );
});

test("readJsonBody: rejects decoded request bodies above the configured limit", async () => {
  const compressed = await gzipAsync(JSON.stringify({ input: "hello" }));

  await assert.rejects(
    readJsonBody(jsonRequest(compressed, "gzip"), { maxDecodedBodyBytes: 8 }),
    (err) => err.statusCode === 413 && /Decoded request body/.test(err.message),
  );
});

test("readJsonBody: parses zstd-compressed JSON request bodies", async (t) => {
  if (!zstdCompressAsync) {
    t.skip("zstd compression is not available in this Node runtime");
    return;
  }

  const compressed = await zstdCompressAsync(JSON.stringify({ model: "gpt-5.5", input: "hello" }));
  const parsed = await readJsonBody(jsonRequest(compressed, "zstd"));

  assert.deepEqual(parsed, { model: "gpt-5.5", input: "hello" });
});

test("writeOrDrain: waits for drain when response backpressure is active", async () => {
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  let writes = 0;
  res.write = () => {
    writes += 1;
    return false;
  };

  const waiting = writeOrDrain(res, "chunk");
  res.emit("drain");

  assert.equal(await waiting, true);
  assert.equal(writes, 1);
});

test("forwardToChat: emits stable mixed text and tool output indexes with usage", async () => {
  const chunks = [
    { model: "gpt-4o", choices: [{ delta: { content: "hello" } }] },
    { model: "gpt-4o", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "look", arguments: "{\"q\":" } }] } }] },
    { model: "gpt-4o", choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "up", arguments: "\"x\"}" } }] } }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 7 } } },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  const events = [];
  let done = false;
  let failure = null;

  await forwardToChat(
    { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    async (event, data) => events.push({ event, data }),
    () => { done = true; },
    (statusCode, message) => { failure = { statusCode, message }; },
    { chatCompletionsFn: async () => new Response(body, { status: 200 }) },
  );

  assert.equal(done, true);
  assert.equal(failure, null);
  const added = events.filter(({ event }) => event === "response.output_item.added");
  assert.deepEqual(added.map(({ data }) => data.output_index), [0, 1]);
  assert.deepEqual(added.map(({ data }) => data.item.type), ["message", "function_call"]);
  const completed = events.find(({ event }) => event === "response.completed").data.response;
  assert.deepEqual(completed.output.map((item) => item.type), ["message", "function_call"]);
  assert.equal(completed.output[1].name, "lookup");
  assert.equal(completed.output[1].arguments, "{\"q\":\"x\"}");
  assert.deepEqual(completed.usage, {
    input_tokens: 10,
    output_tokens: 4,
    total_tokens: 14,
    input_tokens_details: { cached_tokens: 7 },
  });
});

test("forwardToChat: preserves streaming upstream errors", async () => {
  let failure;
  await forwardToChat(
    { model: "gpt-4o", messages: [] },
    async () => {},
    () => {},
    (statusCode, message) => { failure = { statusCode, message }; },
    { chatCompletionsFn: async () => new Response("rate limited", { status: 429 }) },
  );
  assert.deepEqual(failure, { statusCode: 429, message: "rate limited" });
});

test("forwardToChat: emits a completed empty message for an empty successful stream", async () => {
  const events = [];
  await forwardToChat(
    { model: "gpt-4o", messages: [] },
    async (event, data) => events.push({ event, data }),
    () => {},
    () => assert.fail("empty stream should not fail"),
    { chatCompletionsFn: async () => new Response("data: [DONE]\n\n", { status: 200 }) },
  );

  const response = events.find(({ event }) => event === "response.completed").data.response;
  assert.equal(response.output.length, 1);
  assert.equal(response.output[0].type, "message");
  assert.equal(response.output[0].content[0].text, "");
});
