import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createAdapterHandler } from "../src/adapter.mjs";
import { createImageMcpHandler } from "../src/image-mcp.mjs";

async function rpc(handler, id, method, params) {
  const request = Readable.from([Buffer.from(JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  }))]);
  request.method = "POST";
  request.url = "/mcp/image";
  request.socket = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" };

  const response = new EventEmitter();
  response.headers = {};
  response.destroyed = false;
  response.writableEnded = false;
  response.writableFinished = false;
  response.statusCode = 200;
  response.setHeader = (name, value) => { response.headers[name] = value; };
  response.writeHead = (status, headers = {}) => {
    response.statusCode = status;
    Object.assign(response.headers, headers);
  };
  const completed = new Promise((resolve) => {
    response.end = (body = "") => {
      response.writableEnded = true;
      response.writableFinished = true;
      response.body = String(body || "");
      response.emit("finish");
      resolve();
    };
  });
  await handler(request, response);
  await completed;
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null };
}

test("image MCP: advertises no tool by default and returns the configured image as MCP content", async () => {
  let config = null;
  let generated;
  const imageHandler = createImageMcpHandler({
    configLoader: () => config,
    generateImageFn: async (loaded, args) => {
      generated = { loaded, args };
      return {
        data: Buffer.from("image").toString("base64"),
        mimeType: "image/png",
        width: 1024,
        height: 1024,
        model: loaded.model,
        size: args.size,
      };
    },
  });
  const app = createAdapterHandler({ imageMcpHandler: imageHandler, terminalActivity: null });

  const initialized = await rpc(app, 1, "initialize", { protocolVersion: "2025-06-18" });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.body.result.protocolVersion, "2025-06-18");
  assert.deepEqual((await rpc(app, 2, "tools/list")).body.result.tools, []);

  config = {
    endpoint: "https://images.example/v1/images/generations",
    api_key: "secret-value",
    model: "qwen-image-3.0-pro",
    protocol: "qwen-messages",
  };
  const listed = await rpc(app, 3, "tools/list");
  assert.deepEqual(listed.body.result.tools.map(({ name }) => name), ["generate_image"]);
  const called = await rpc(app, 4, "tools/call", {
    name: "generate_image",
    arguments: { prompt: "A blue circle", size: "1024x1024" },
  });
  assert.equal(called.body.result.isError, undefined);
  assert.equal(called.body.result.content[0].type, "image");
  assert.equal(called.body.result.content[0].mimeType, "image/png");
  assert.equal(called.body.result.content[0].data, Buffer.from("image").toString("base64"));
  assert.equal(generated.loaded.api_key, "secret-value");
  assert.deepEqual(generated.args, { prompt: "A blue circle", size: "1024x1024" });
});

test("image MCP: stale calls fail closed when the provider is disabled", async () => {
  const app = createImageMcpHandler({ configLoader: () => null });
  const called = await rpc(app, 1, "tools/call", { name: "generate_image", arguments: { prompt: "hello" } });
  assert.equal(called.body.result.isError, true);
  assert.match(called.body.result.content[0].text, /disabled/);
});

test("image MCP: never returns a provider API key embedded in an upstream error", async () => {
  const config = {
    endpoint: "https://images.example/v1/images/generations",
    api_key: "secret-value",
    model: "gpt-image-1",
    protocol: "openai-images",
  };
  const app = createImageMcpHandler({
    configLoader: () => config,
    generateImageFn: async () => { throw new Error("upstream echoed secret-value\nretry"); },
  });
  const called = await rpc(app, 1, "tools/call", { name: "generate_image", arguments: { prompt: "hello" } });
  const text = called.body.result.content[0].text;
  assert.equal(called.body.result.isError, true);
  assert.doesNotMatch(text, /secret-value/);
  assert.match(text, /\[redacted\]/);
  assert.doesNotMatch(text, /\n/);
});
