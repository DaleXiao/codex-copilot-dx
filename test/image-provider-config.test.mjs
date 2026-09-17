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
  for (const endpoint of [
    "not-a-url",
    "http://images.example",
    "http://images.example/v1/images/generations",
  ]) assert.throws(() => normalizeImageEndpoint(endpoint), /HTTPS/);
  for (const endpoint of [
    "https://user@images.example/v1/images/generations",
    "https://user:password@images.example/v1",
    "https://images.example/v1?api_key=private",
    "https://images.example/v1/images/generations?api_key=private",
    "https://images.example/#fragment",
    "https://images.example/v1/images/generations#fragment",
  ]) assert.throws(() => normalizeImageEndpoint(endpoint), /without credentials, query, or fragment/);
  for (const endpointPath of [
    "/v1/images", "/v1/images/edits", "/v1/images/variations/",
    "/v1/chat/completions", "/v1/completions", "/v1/responses", "/v1/embeddings", "/v1/models",
  ]) assert.throws(() => normalizeImageEndpoint(`https://images.example${endpointPath}`), /must be a base URL/);
  assert.throws(() => writeImageProviderConfig({
    endpoint: "https://images.example/v1/images/generations",
    api_key: "secret-value",
    model: "image\u001b[31m",
    protocol: "openai-images",
  }, { home: os.tmpdir(), env: { XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-invalid-")) } }), /model must be/);
});

test("image provider config: accepts base URLs and preserves full endpoints and custom path prefixes", () => {
  for (const [input, endpoint, models] of [
    ["https://images.example", "https://images.example/v1/images/generations", "https://images.example/v1/models"],
    [" https://images.example/ ", "https://images.example/v1/images/generations", "https://images.example/v1/models"],
    ["https://images.example/v1", "https://images.example/v1/images/generations", "https://images.example/v1/models"],
    ["https://images.example/v1/", "https://images.example/v1/images/generations", "https://images.example/v1/models"],
    ["https://images.example/proxy/openai/v2/", "https://images.example/proxy/openai/v2/images/generations", "https://images.example/proxy/openai/v2/models"],
    ["https://images.example:8443/api", "https://images.example:8443/api/images/generations", "https://images.example:8443/api/models"],
    ["https://images.example/images/generations", "https://images.example/images/generations", "https://images.example/models"],
    ["https://images.example/api/custom/images/generations/", "https://images.example/api/custom/images/generations", "https://images.example/api/custom/models"],
  ]) {
    assert.equal(normalizeImageEndpoint(input), endpoint);
    assert.equal(normalizeImageEndpoint(endpoint), endpoint);
    assert.equal(imageModelsEndpoint(input), models);
  }
});

test("image provider config: persists a base URL as its canonical generation endpoint", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-base-config-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const saved = writeImageProviderConfig({
    endpoint: "https://images.example/proxy/v1/", api_key: "secret-value",
    model: "gpt-image-1", protocol: "openai-images",
  }, { home, env: {} });
  assert.equal(saved.config.endpoint, "https://images.example/proxy/v1/images/generations");
  assert.equal(readImageProviderConfig({ home, env: {}, strict: true }).endpoint, saved.config.endpoint);
  assert.equal(fs.statSync(saved.filePath).mode & 0o777, 0o600);
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

test("image provider inspection accepts a base URL without additional probes or generation parameters", async () => {
  const calls = [];
  const result = await inspectImageProvider({
    endpoint: "https://images.example/proxy/v1/",
    apiKey: "secret-value",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, method: init.method || "GET", body: init.body && JSON.parse(init.body) });
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "gpt-image-1" }] });
      return Response.json({ error: { message: "Missing required parameter: prompt" } }, { status: 400 });
    },
  });
  assert.equal(result.endpoint, "https://images.example/proxy/v1/images/generations");
  assert.equal(result.protocol, "openai-images");
  assert.deepEqual(calls, [
    { url: "https://images.example/proxy/v1/models", method: "GET", body: undefined },
    { url: "https://images.example/proxy/v1/images/generations", method: "POST", body: { model: "gpt-image-1" } },
  ]);
});

test("image provider inspection rejects another API operation before sending any requests", async () => {
  let calls = 0;
  await assert.rejects(inspectImageProvider({
    endpoint: "https://images.example/v1/images/edits", apiKey: "secret-value",
    fetchImpl: async () => { calls += 1; throw new Error("unexpected request"); },
  }), /must be a base URL/);
  assert.equal(calls, 0);
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

test("image provider inspection probes only the chosen model after reading its catalog", async () => {
  const calls = [];
  const result = await inspectImageProvider({
    endpoint: "https://images.example/v1/images/generations",
    apiKey: "secret-value",
    selectModel: async (models) => {
      assert.deepEqual(models, ["qwen-image-3.0-pro", "gpt-image-1"]);
      assert.deepEqual(calls.map(({ method }) => method), ["GET"]);
      return models[1];
    },
    fetchImpl: async (url, init = {}) => {
      calls.push({ method: init.method || "GET", body: init.body && JSON.parse(init.body) });
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "qwen-image-3.0-pro" }, { id: "gpt-image-1" }] });
      assert.deepEqual(JSON.parse(init.body), { model: "gpt-image-1" });
      return Response.json({ error: { message: "Missing required parameter: prompt" } }, { status: 400 });
    },
  });
  assert.equal(result.protocol, "openai-images");
  assert.equal(calls.length, 2);
});

test("image provider inspection does not probe a cancelled or invalid model choice", async () => {
  for (const selectModel of [async () => { throw new Error("selection cancelled"); }, async () => "absent-image-model"]) {
    let calls = 0;
    await assert.rejects(inspectImageProvider({
      endpoint: "https://images.example/v1/images/generations", apiKey: "secret-value", selectModel,
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ data: [{ id: "qwen-image-3.0-pro" }] });
      },
    }), /cancelled|selected image model/i);
    assert.equal(calls, 1);
  }
});
