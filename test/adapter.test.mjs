import { test } from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import * as zlib from "node:zlib";
import {
  clearResponseHistoryForTests,
  isEncryptedContentVerificationError,
  openCopilotResponse,
  prepareResponsesRequest,
  readJsonBody,
  rememberResponseHistory,
  requestPath,
  sanitizeEncryptedReasoningRequest,
  shouldServeClaudeDesktopModels,
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
