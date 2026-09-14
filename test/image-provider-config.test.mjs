import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  imageModelsEndpoint,
  imageProviderConfigPath,
  inspectImageProvider,
  normalizeImageEndpoint,
  readImageProviderConfig,
  writeImageProviderConfig,
} from "../src/image-provider-config.mjs";

test("image provider config: defaults disabled and stores a validated secret with mode 0600", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-config-"));
  assert.equal(readImageProviderConfig({ home, env: {} }), null);

  const saved = writeImageProviderConfig({
    endpoint: "https://images.example/v1/images/generations/",
    api_key: "secret-value",
    model: "qwen-image-3.0-pro",
    protocol: "qwen-messages",
  }, { home, env: {} });

  assert.equal(saved.filePath, imageProviderConfigPath({ home, env: {} }));
  assert.equal(fs.statSync(saved.filePath).mode & 0o777, 0o600);
  assert.deepEqual(readImageProviderConfig({ home, env: {}, strict: true }), {
    enabled: true,
    endpoint: "https://images.example/v1/images/generations",
    api_key: "secret-value",
    model: "qwen-image-3.0-pro",
    protocol: "qwen-messages",
  });
});

test("image provider config: validates endpoint boundaries and derives the models endpoint", () => {
  assert.equal(
    imageModelsEndpoint("https://images.example/api/v1/images/generations"),
    "https://images.example/api/v1/models",
  );
  assert.throws(() => normalizeImageEndpoint("http://images.example/v1/images/generations"), /HTTPS/);
  assert.throws(() => normalizeImageEndpoint("https://user@images.example/v1/images/generations"), /without credentials/);
  assert.throws(() => normalizeImageEndpoint("https://images.example/v1/responses"), /must end with/);
  assert.throws(() => writeImageProviderConfig({
    endpoint: "https://images.example/v1/images/generations",
    api_key: "secret-value",
    model: "image\u001b[31m",
    protocol: "openai-images",
  }, { home: os.tmpdir(), env: { XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-invalid-")) } }), /model must be/);
});

test("image provider inspection detects qwen messages without generating an image", async () => {
  const calls = [];
  const result = await inspectImageProvider({
    endpoint: "https://images.example/v1/images/generations",
    apiKey: "secret-value",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "text-model" }, { id: "qwen-image-3.0-pro" }] });
      }
      return Response.json({ code: "InvalidParameter", message: "Field required: input.messages" }, { status: 400 });
    },
  });

  assert.deepEqual(result, {
    endpoint: "https://images.example/v1/images/generations",
    modelIds: ["qwen-image-3.0-pro"],
    protocol: "qwen-messages",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret-value");
  assert.deepEqual(JSON.parse(calls[1].init.body), { model: "qwen-image-3.0-pro" });
});

test("image provider inspection detects OpenAI Images errors and rejects unknown contracts", async () => {
  const inspect = (message) => inspectImageProvider({
    endpoint: "https://images.example/v1/images/generations",
    apiKey: "secret-value",
    fetchImpl: async (url) => url.endsWith("/models")
      ? Response.json({ data: [{ id: "gpt-image-1" }] })
      : Response.json({ error: { message } }, { status: 400 }),
  });

  assert.equal((await inspect("Missing required parameter: prompt")).protocol, "openai-images");
  await assert.rejects(inspect("Invalid request"), /unsupported or could not be detected/);
});
