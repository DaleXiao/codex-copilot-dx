import { test } from "node:test";
import assert from "node:assert/strict";
import {
  discardBoundedResponseBody,
  readBoundedResponseBuffer,
  readBoundedResponseText,
} from "../src/http-transport.mjs";

function chunkedResponse(chunks, { contentLength } = {}) {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(Buffer.from(chunk));
    },
    cancel() { cancelled = true; },
  });
  const headers = contentLength === undefined ? {} : { "Content-Length": String(contentLength) };
  return { response: new Response(body, { headers }), cancelled: () => cancelled };
}

test("bounded upstream reads preserve split UTF-8 text and exact-boundary bytes", async () => {
  const encoded = Buffer.from("\ufeffhello 😀");
  const { response } = chunkedResponse([
    encoded.subarray(0, 5),
    encoded.subarray(5, encoded.length - 1),
    encoded.subarray(encoded.length - 1),
  ]);
  assert.equal(await readBoundedResponseText(response, { maxBytes: encoded.length }), "hello 😀");

  const exact = Buffer.from("12345678");
  assert.deepEqual(
    await readBoundedResponseBuffer(new Response(exact), { maxBytes: exact.length }),
    exact,
  );
});

test("bounded upstream reads enforce actual bytes and cancel an oversized stream", async () => {
  const source = chunkedResponse(["1234", "5678"], { contentLength: 2 });
  await assert.rejects(
    readBoundedResponseText(source.response, { maxBytes: 7, label: "Test upstream body" }),
    (error) => error.statusCode === 502
      && error.code === "ccdx_upstream_response_too_large"
      && /Test upstream body exceeds 7 bytes/.test(error.message),
  );
  assert.equal(source.cancelled(), true);
});

test("bounded upstream reads reject advertised overflow before pulling the body", async () => {
  let pulls = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(Buffer.from("unexpected"));
    },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Length": "99" } });

  await assert.rejects(readBoundedResponseBuffer(response, { maxBytes: 8 }));
  assert.equal(cancelled, true);
  assert.ok(pulls <= 1);
});

test("bounded retry drain cancels oversized bodies without surfacing a second failure", async () => {
  const source = chunkedResponse([Buffer.alloc(8), Buffer.alloc(8)]);
  assert.equal(await discardBoundedResponseBody(source.response, 12), false);
  assert.equal(source.cancelled(), true);
});

test("bounded upstream reads never fall back to an unbounded response-like arrayBuffer", async () => {
  let arrayBufferCalls = 0;
  const response = {
    body: {},
    headers: new Headers(),
    async arrayBuffer() {
      arrayBufferCalls += 1;
      throw new Error("must not allocate");
    },
  };

  await assert.rejects(
    readBoundedResponseBuffer(response, { maxBytes: 8, label: "Injected upstream body" }),
    (error) => error.statusCode === 502 && error.code === "ccdx_upstream_response_unreadable",
  );
  assert.equal(arrayBufferCalls, 0);
});
