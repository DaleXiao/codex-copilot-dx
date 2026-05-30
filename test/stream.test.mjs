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

test("webStreamLines: 跨 chunk 的行被正确拼接", async () => {
  const resp = responseFrom(["data: hel", "lo\n", "data: wor", "ld\n"]);
  const lines = [];
  for await (const line of webStreamLines(resp)) lines.push(line);
  assert.deepEqual(lines, ["data: hello", "data: world"]);
});

test("webStreamLines: 末尾无换行的残留行也产出", async () => {
  const resp = responseFrom(["a\n", "b"]);
  const lines = [];
  for await (const line of webStreamLines(resp)) lines.push(line);
  assert.deepEqual(lines, ["a", "b"]);
});
