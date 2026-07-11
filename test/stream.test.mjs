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
  const resp = responseFrom(["data: a\r\n", "data: b\r\n"]);
  const lines = [];
  for await (const line of webStreamLines(resp)) lines.push(line);
  assert.deepEqual(lines, ["data: a", "data: b"]);
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
