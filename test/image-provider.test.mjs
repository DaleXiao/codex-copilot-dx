import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadPublicImage, generateImage } from "../src/image-provider.mjs";

function png(width = 1024, height = 1024) {
  const bytes = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test("image provider: adapts qwen messages and downloads its generated URL", async () => {
  let body;
  const bytes = png();
  const result = await generateImage({
    endpoint: "https://images.example/v1/images/generations",
    api_key: "secret-value",
    model: "qwen-image-3.0-pro",
    protocol: "qwen-messages",
  }, { prompt: "A blue circle", size: "1024x1024" }, {
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      assert.equal(init.headers.Authorization, "Bearer secret-value");
      return Response.json({ output: { choices: [{ message: { content: [{ image: "https://cdn.example/result.png" }] } }] } });
    },
    downloadImage: async (url) => {
      assert.equal(url, "https://cdn.example/result.png");
      return bytes;
    },
  });

  assert.deepEqual(body, {
    model: "qwen-image-3.0-pro",
    input: { messages: [{ role: "user", content: [{ text: "A blue circle" }] }] },
    parameters: { n: 1, size: "1024*1024", watermark: false },
  });
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.width, 1024);
  assert.equal(result.height, 1024);
  assert.equal(result.data, bytes.toString("base64"));
});

test("image provider: accepts standard OpenAI base64 responses", async () => {
  const bytes = png(1536, 1024);
  let body;
  const result = await generateImage({
    endpoint: "https://images.example/v1/images/generations",
    api_key: "secret-value",
    model: "gpt-image-1",
    protocol: "openai-images",
  }, { prompt: "A landscape", size: "1536x1024" }, {
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json({ data: [{ b64_json: bytes.toString("base64") }] });
    },
  });

  assert.deepEqual(body, { model: "gpt-image-1", prompt: "A landscape", n: 1, size: "1536x1024" });
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.width, 1536);
});

test("image provider: rejects unsafe downloads, invalid arguments, and upstream errors", async () => {
  await assert.rejects(
    downloadPublicImage("https://internal.example/image.png", {
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    }),
    /non-public/,
  );
  const config = {
    endpoint: "https://images.example/v1/images/generations",
    api_key: "secret-value",
    model: "gpt-image-1",
    protocol: "openai-images",
  };
  await assert.rejects(generateImage(config, { prompt: "", size: "1024x1024" }), /prompt is required/);
  await assert.rejects(generateImage(config, { prompt: "hello", size: "1x1" }), /size must be one of/);
  await assert.rejects(generateImage(config, { prompt: "hello" }, {
    fetchImpl: async () => Response.json({ error: { message: "quota exhausted" } }, { status: 429 }),
  }), /HTTP 429: quota exhausted/);
});
