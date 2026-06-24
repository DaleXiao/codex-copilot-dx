import { test } from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import * as zlib from "node:zlib";
import { clearResponseHistoryForTests, prepareResponsesRequest, readJsonBody, rememberResponseHistory, requestPath } from "../src/adapter.mjs";

const gzipAsync = promisify(zlib.gzip);
const zstdCompressAsync = zlib.zstdCompress ? promisify(zlib.zstdCompress) : null;

function jsonRequest(body, contentEncoding) {
  const req = Readable.from([body]);
  req.headers = contentEncoding ? { "content-encoding": contentEncoding } : {};
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

test("readJsonBody: parses gzip-compressed JSON request bodies", async () => {
  const compressed = await gzipAsync(JSON.stringify({ model: "gpt-5.5", input: "hello" }));
  const parsed = await readJsonBody(jsonRequest(compressed, "gzip"));

  assert.deepEqual(parsed, { model: "gpt-5.5", input: "hello" });
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
