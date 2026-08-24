import { test } from "node:test";
import assert from "node:assert/strict";
import { webStreamLines } from "../src/stream.mjs";

function responseFrom(chunks) {
  const stream = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });
  return new Response(stream);
}

function responseFromBytes(chunks) {
  const stream = new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
  return new Response(stream);
}

test("webStreamLines: joins lines split across chunks", async () => {
  const resp = responseFrom(["data: hel", "lo\n", "data: wor", "ld\n"]);
  const lines = [];
  for await (const line of webStreamLines(resp)) lines.push(line);
  assert.deepEqual(lines, ["data: hello", "data: world"]);
});

test("webStreamLines: yields a final line without trailing newline", async () => {
  const resp = responseFrom(["a\n", "b"]);
  const lines = [];
  for await (const line of webStreamLines(resp)) lines.push(line);
  assert.deepEqual(lines, ["a", "b"]);
});

test("webStreamLines: strips CRLF carriage returns", async () => {
  const resp = responseFrom(["data: a\r", "\ndata: b\r", "\n"]);
  const lines = [];
  for await (const line of webStreamLines(resp)) lines.push(line);
  assert.deepEqual(lines, ["data: a", "data: b"]);
});

test("webStreamLines: preserves UTF-8 code points split across chunks", async () => {
  const encoded = new TextEncoder().encode("data: 你好\n");
  const resp = responseFromBytes([
    encoded.subarray(0, 7),
    encoded.subarray(7, 9),
    encoded.subarray(9),
  ]);
  const lines = [];
  for await (const line of webStreamLines(resp)) lines.push(line);
  assert.deepEqual(lines, ["data: 你好"]);
});

test("webStreamLines: does not read another chunk while a yielded line is backpressured", async () => {
  const chunks = ["first\n", "second\n"].map((value) => new TextEncoder().encode(value));
  let pulls = 0;
  const resp = {
    body: new ReadableStream({
      pull(controller) {
        const chunk = chunks[pulls];
        pulls += 1;
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    }, { highWaterMark: 0 }),
  };
  const iterator = webStreamLines(resp)[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), { value: "first", done: false });
  assert.equal(pulls, 1);
  assert.deepEqual(await iterator.next(), { value: "second", done: false });
  assert.equal(pulls, 2);
  await iterator.return();
  assert.equal(resp.body.locked, false);
});

test("webStreamLines: releases the body lock after early break", async () => {
  const resp = responseFrom(["x\n", "y\n", "z\n"]);
  for await (const line of webStreamLines(resp)) {
    if (line === "x") break;
  }
  assert.equal(resp.body.locked, false);
});

test("webStreamLines: reports every received byte chunk", async () => {
  const resp = responseFrom(["data: a", "\n", "data: b\n"]);
  const chunks = [];
  const lines = [];
  for await (const line of webStreamLines(resp, { onChunk: (chunk) => chunks.push(chunk.byteLength) })) {
    lines.push(line);
  }
  assert.deepEqual(chunks, [7, 1, 8]);
  assert.deepEqual(lines, ["data: a", "data: b"]);
});

test("webStreamLines: rejects an upstream line above the buffer limit", async () => {
  const resp = responseFrom(["data: ", "x".repeat(32), "\n"]);

  await assert.rejects(async () => {
    for await (const _line of webStreamLines(resp, { maxBufferBytes: 16 })) {
      // Consume the iterator.
    }
  }, /SSE buffer exceeds 16 bytes/);

  assert.equal(resp.body.locked, false);
});

test("webStreamLines: scans a fragmented line in linear total bytes", async () => {
  const chunkBytes = 1024;
  const chunkCount = 256;
  const resp = responseFrom(Array.from({ length: chunkCount }, () => "x".repeat(chunkBytes)));
  const originalByteLength = Buffer.byteLength;
  let scannedBytes = 0;
  Buffer.byteLength = function trackedByteLength(value, ...args) {
    const bytes = originalByteLength(value, ...args);
    scannedBytes += bytes;
    return bytes;
  };

  try {
    const lines = [];
    for await (const line of webStreamLines(resp)) lines.push(line);
    assert.deepEqual(lines.map((line) => line.length), [chunkBytes * chunkCount]);
  } finally {
    Buffer.byteLength = originalByteLength;
  }

  assert.ok(scannedBytes <= chunkBytes * chunkCount * 1.01, `scanned ${scannedBytes} bytes`);
});
