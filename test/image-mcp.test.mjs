import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { createAdapterHandler } from "../src/adapter.mjs";
import { createImageMcpHandler as createHandler } from "../src/image-mcp.mjs";
import { createImageReferenceStore } from "../src/image-references.mjs";

const imageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-chat-"));
after(() => fs.rmSync(imageDirectory, { recursive: true, force: true }));
const createImageMcpHandler = (options) => createHandler({ imageDirectory, ...options });
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

async function rpc(handler, id, method, params, headers = {}) {
  const request = Readable.from([Buffer.from(JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  }))]);
  request.method = "POST";
  request.url = "/mcp/image";
  request.headers = { "content-type": "application/json", ...headers };
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

test("image MCP rejects browser origins and non-JSON requests before reading credentials or dispatching", async () => {
  let configReads = 0;
  let calls = 0;
  const app = createAdapterHandler({ imageMcpHandler: createImageMcpHandler({
    configLoader: () => { configReads += 1; return { model: "test" }; },
    generateImageFn: async () => { calls += 1; throw new Error("must not generate"); },
  }) });
  const params = { name: "generate_image", arguments: { prompt: "test" } };
  for (const origin of ["https://untrusted.example", "null", "", "http://127.0.0.1:2026"]) {
    const result = await rpc(app, 1, "tools/call", params, { origin });
    assert.equal(result.status, 403);
    assert.match(result.body.error.message, /origin/i);
  }
  for (const type of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonx"]) {
    const result = await rpc(app, 1, "tools/call", params, { "content-type": type });
    assert.equal(result.status, 415);
    assert.match(result.body.error.message, /application\/json/);
  }
  assert.equal(configReads, 0);
  assert.equal(calls, 0);
});

test("image MCP retains native JSON clients including charset parameters and notifications", async () => {
  const handler = createImageMcpHandler({ configLoader: () => null });
  for (const type of ["application/json", "application/json; charset=utf-8", "Application/JSON; charset=UTF-8"]) {
    const headers = { "content-type": type };
    const initialized = await rpc(handler, 1, "initialize", { protocolVersion: "2025-06-18" }, headers);
    assert.equal(initialized.status, 200);
    assert.equal(initialized.body.result.serverInfo.name, "ccdx-image");
    assert.equal((await rpc(handler, undefined, "notifications/initialized", {}, headers)).status, 202);
  }
});

test("image MCP preserves loopback and explicit same-device sockets without widening LAN access", async () => {
  const handler = createImageMcpHandler({ configLoader: () => null });
  for (const [remoteAddress, localAddress, expected] of [
    ["::1", "::1", 200],
    ["::ffff:127.0.0.1", "::ffff:127.0.0.1", 200],
    ["192.168.1.10", "192.168.1.10", 200],
    ["::ffff:192.168.1.10", "192.168.1.10", 200],
    ["192.168.1.20", "192.168.1.10", 403],
  ]) {
    const result = await rpc((req, res) => {
      req.socket = { remoteAddress, localAddress };
      return handler(req, res);
    }, 1, "initialize", { protocolVersion: "2025-06-18" });
    assert.equal(result.status, expected);
  }
});

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
  assert.deepEqual(listed.body.result.tools.map(({ name }) => name), ["generate_image", "edit_image"]);
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
  assert.match(called.body.result._meta["ccdx/image_id"], /^ccdx_img_/);
  assert.equal(called.body.result.structuredContent, undefined);
});

test("image MCP chains explicit edits with new IDs and preserves both original pixels and source size", async () => {
  const calls = [];
  const config = { endpoint: "https://images.example/v1/images/generations", api_key: "secret", model: "qwen-image-3.0-pro", protocol: "qwen-messages" };
  const handler = createImageMcpHandler({ configLoader: () => config, generateImageFn: async (_config, args) => {
    calls.push(args);
    return { data: Buffer.from(`pixels-${calls.length}`).toString("base64"), mimeType: "image/png", size: args.size, model: config.model };
  } });
  const call = async (name, args) => (await rpc(handler, calls.length + 1, "tools/call", { name, arguments: args })).body.result;
  const first = await call("generate_image", { prompt: "A blue circle", size: "1536x1024", image: "must not forward arbitrary pixels" });
  const firstId = first._meta["ccdx/image_id"];
  assert.equal(calls[0].image, undefined);
  const second = await call("edit_image", { image_id: firstId, prompt: "Make it red" });
  const secondId = second._meta["ccdx/image_id"];
  assert.notEqual(firstId, secondId);
  assert.deepEqual(calls[1], { prompt: "Make it red", size: "1536x1024", image: `data:image/png;base64,${first.content[0].data}` });
  await call("edit_image", { image_id: secondId, prompt: "Make it green" });
  assert.equal(calls[2].image, `data:image/png;base64,${second.content[0].data}`);
  await call("edit_image", { image_id: firstId, prompt: "Edit the original instead" });
  assert.equal(calls[3].image, `data:image/png;base64,${first.content[0].data}`);
  const failure = await call("edit_image", { image_id: "missing", prompt: "change" });
  assert.equal(failure.isError, true);
  assert.equal(calls.length, 4);
});

test("image MCP fails edits before dispatch on provider changes, expiry or unsupported capability", async () => {
  let config = { endpoint: "https://images.example/v1/images/generations", api_key: "secret", model: "qwen-image-3.0-pro", protocol: "qwen-messages" };
  let calls = 0;
  const references = createImageReferenceStore();
  const handler = createImageMcpHandler({ configLoader: () => config, imageReferences: references, generateImageFn: async () => {
    calls += 1;
    return { data: "aW1hZ2U=", mimeType: "image/png", model: config.model };
  } });
  const generated = (await rpc(handler, 1, "tools/call", { name: "generate_image", arguments: { prompt: "test" } })).body.result;
  const imageId = generated._meta["ccdx/image_id"];
  config = { ...config, api_key: "new-credential" };
  const edit = () => rpc(handler, 2, "tools/call", { name: "edit_image", arguments: { image_id: imageId, prompt: "change" } });
  assert.equal((await edit()).body.result.isError, true);
  config = { ...config, api_key: "secret" };
  references.clear();
  assert.equal((await edit()).body.result.isError, true);
  config = { ...config, model: "gpt-image-1", protocol: "openai-images" };
  assert.deepEqual((await rpc(handler, 3, "tools/list")).body.result.tools.map((tool) => tool.name), ["generate_image"]);
  assert.equal((await edit()).body.result.isError, true);
  config = null;
  assert.equal((await edit()).body.result.isError, true);
  assert.equal(calls, 1);
});

test("image MCP still delivers generated images if reference retention is unavailable", async () => {
  const handler = createImageMcpHandler({
    configLoader: () => ({ model: "qwen-image-3.0-pro", protocol: "qwen-messages" }),
    imageReferences: createImageReferenceStore({ maxBytes: 1 }),
    generateImageFn: async () => ({ data: "aW1hZ2U=", mimeType: "image/png", model: "qwen-image-3.0-pro" }),
  });
  const result = (await rpc(handler, 1, "tools/call", { name: "generate_image", arguments: { prompt: "test" } })).body.result;
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].data, "aW1hZ2U=");
  assert.equal(result.structuredContent, undefined);
});

test("image MCP shares concurrency across generation and editing and keeps a source after failure", async () => {
  const config = { endpoint: "https://images.example/v1/images/generations", api_key: "secret", model: "qwen-image-3.0-pro", protocol: "qwen-messages" };
  const sourcePixels = "aW1hZ2U=";
  let calls = 0;
  let waiting = false;
  let failEdit = false;
  const waitingCalls = [];
  const handler = createImageMcpHandler({ configLoader: () => config, generateImageFn: async (_config, args) => {
    calls += 1;
    if (args.image) assert.equal(args.image, `data:image/png;base64,${sourcePixels}`);
    if (failEdit && args.image) throw new Error("fixture upstream rejection");
    if (waiting) await new Promise((resolve) => waitingCalls.push(resolve));
    return { data: sourcePixels, mimeType: "image/png", model: config.model };
  } });
  const first = (await rpc(handler, 1, "tools/call", { name: "generate_image", arguments: { prompt: "test" } })).body.result;
  const editArgs = { name: "edit_image", arguments: { image_id: first._meta["ccdx/image_id"], prompt: "change" } };
  failEdit = true;
  assert.equal((await rpc(handler, 2, "tools/call", editArgs)).body.result.isError, true);
  failEdit = false;
  waiting = true;
  const editing = rpc(handler, 3, "tools/call", editArgs);
  const generating = rpc(handler, 4, "tools/call", { name: "generate_image", arguments: { prompt: "new" } });
  await new Promise(setImmediate);
  assert.equal(waitingCalls.length, 2);
  assert.match((await rpc(handler, 5, "tools/call", editArgs)).body.result.content[0].text, /busy/);
  assert.equal(calls, 4);
  waiting = false;
  waitingCalls.forEach((resolve) => resolve());
  for (const result of await Promise.all([editing, generating])) assert.equal(result.body.result.isError, undefined);
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

test("image MCP delivers immutable local images and safe final-chat Markdown without extra provider calls", async () => {
  const directory = path.join(imageDirectory, "chat # [preview] (中文)");
  const config = { model: "qwen-image-3.0-pro", protocol: "qwen-messages", api_key: "secret" };
  let calls = 0;
  const handler = createImageMcpHandler({
    imageDirectory: directory, configLoader: () => config,
    generateImageFn: async () => { calls += 1; return { data: PNG, mimeType: "image/png", model: config.model }; },
  });
  const first = (await rpc(handler, 1, "tools/call", { name: "generate_image", arguments: { prompt: "A circle" } })).body.result;
  const firstPath = first._meta["ccdx/image_path"];
  assert.equal(calls, 1);
  assert.ok(path.isAbsolute(firstPath));
  assert.equal(path.dirname(firstPath), fs.realpathSync(directory));
  assert.deepEqual(fs.readFileSync(firstPath), Buffer.from(PNG, "base64"));
  const markdown = first.content[1].text.match(/!\[Generated image\]\(<([^>]+)>\)/);
  assert.ok(markdown);
  assert.equal(decodeURIComponent(markdown[1]), firstPath.replaceAll("\\", "/"));
  for (const encoded of ["%20", "%23", "%5B", "%5D", "%28", "%29"]) assert.ok(markdown[1].includes(encoded));
  assert.match(first.content[1].text, /final chat reply/);
  assert.match(first.content[1].text, /do not call generate_image or edit_image/);
  assert.equal(first.content[0].data, PNG);
  assert.equal(first.structuredContent, undefined);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(firstPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
  const edited = (await rpc(handler, 2, "tools/call", {
    name: "edit_image", arguments: { image_id: first._meta["ccdx/image_id"], prompt: "Make it red" },
  })).body.result;
  assert.equal(calls, 2);
  assert.notEqual(edited._meta["ccdx/image_path"], firstPath);
  assert.notEqual(edited._meta["ccdx/image_id"], first._meta["ccdx/image_id"]);
  assert.deepEqual(fs.readFileSync(firstPath), Buffer.from(PNG, "base64"));
  assert.deepEqual(fs.readFileSync(edited._meta["ccdx/image_path"]), Buffer.from(PNG, "base64"));
  // Redisplaying the returned Markdown reads the saved original, without an image operation.
  assert.deepEqual(fs.readFileSync(decodeURIComponent(markdown[1])), Buffer.from(PNG, "base64"));
  assert.equal(calls, 2);
});

test("image MCP saves chat thumbnails for generation-only providers without adding editing capability", async () => {
  const handler = createImageMcpHandler({ configLoader: () => ({ model: "gpt-image-1", protocol: "openai-images" }),
    generateImageFn: async () => ({ data: PNG, mimeType: "image/png", model: "gpt-image-1" }),
  });
  assert.deepEqual((await rpc(handler, 1, "tools/list")).body.result.tools.map(t => t.name), ["generate_image"]);
  const generated = (await rpc(handler, 2, "tools/call", { name: "generate_image", arguments: { prompt: "test" } })).body.result;
  assert.equal(generated._meta["ccdx/image_id"], undefined);
  assert.deepEqual(fs.readFileSync(generated._meta["ccdx/image_path"]), Buffer.from(PNG, "base64"));
  assert.equal(generated.content[0].type, "image");
});

test("image MCP retains generated content if chat saving fails, without inventing a path or retrying", async () => {
  const blocked = path.join(imageDirectory, "not-a-directory");
  fs.writeFileSync(blocked, "keep");
  let calls = 0;
  const handler = createImageMcpHandler({ imageDirectory: blocked,
    configLoader: () => ({ model: "qwen-image-3.0-pro", protocol: "qwen-messages" }),
    generateImageFn: async () => { calls += 1; return { data: PNG, mimeType: "image/png", model: "qwen-image-3.0-pro" }; },
  });
  const result = (await rpc(handler, 1, "tools/call", { name: "generate_image", arguments: { prompt: "test" } })).body.result;
  assert.equal(calls, 1);
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].data, PNG);
  assert.match(result._meta["ccdx/image_id"], /^ccdx_img_/);
  assert.equal(result._meta["ccdx/image_path"], undefined);
  assert.match(result.content[1].text, /chat-preview file could not be saved/);
  assert.doesNotMatch(result.content[1].text, /!\[/);
  assert.equal(fs.readFileSync(blocked, "utf8"), "keep");
});

test("image MCP does not follow a chat-output directory symlink", async () => {
  const target = path.join(imageDirectory, "unrelated");
  const link = path.join(imageDirectory, "linked-output");
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, "dir");
  const handler = createImageMcpHandler({ imageDirectory: link,
    configLoader: () => ({ model: "gpt-image-1", protocol: "openai-images" }),
    generateImageFn: async () => ({ data: PNG, mimeType: "image/png", model: "gpt-image-1" }),
  });
  const result = (await rpc(handler, 1, "tools/call", { name: "generate_image", arguments: { prompt: "test" } })).body.result;
  assert.equal(result.isError, undefined);
  assert.equal(result._meta?.["ccdx/image_path"], undefined);
  assert.deepEqual(fs.readdirSync(target), []);
});

test("image MCP leaves the bundled helper's single output write to the client", async () => {
  const directory = path.join(imageDirectory, "helper-must-not-create");
  let calls = 0;
  const handler = createImageMcpHandler({ imageDirectory: directory,
    configLoader: () => ({ model: "gpt-image-1", protocol: "openai-images" }),
    generateImageFn: async () => { calls += 1; return { data: PNG, mimeType: "image/png", model: "gpt-image-1" }; },
  });
  const result = (await rpc(handler, 1, "tools/call", { name: "generate_image", arguments: { prompt: "test" }, _meta: { "ccdx/client_saves_image": true } })).body.result;
  assert.equal(calls, 1);
  assert.equal(result.content[0].data, PNG);
  assert.equal(result._meta?.["ccdx/image_path"], undefined);
  assert.equal(fs.existsSync(directory), false);
});

test("image MCP preserves JPEG and WebP bytes and uses their matching file extensions", async () => {
  const { default: sharp } = await import("sharp");
  for (const [format, mimeType, extension] of [["jpeg", "image/jpeg", ".jpg"], ["webp", "image/webp", ".webp"]]) {
    const pixels = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).toFormat(format).toBuffer();
    const handler = createImageMcpHandler({ configLoader: () => ({ model: "test", protocol: "openai-images" }),
      generateImageFn: async () => ({ data: pixels.toString("base64"), mimeType, model: "test" }),
    });
    const result = (await rpc(handler, 1, "tools/call", { name: "generate_image", arguments: { prompt: "test" } })).body.result;
    const output = result._meta["ccdx/image_path"];
    assert.equal(path.extname(output), extension);
    assert.deepEqual(fs.readFileSync(output), pixels);
    assert.equal((await sharp(output).metadata()).format, format);
  }
});

test("image MCP does not save a cancelled delivery or dispatch another image request", async () => {
  const directory = path.join(imageDirectory, "cancelled-must-not-create");
  let calls = 0;
  let cancel;
  const handler = createImageMcpHandler({ imageDirectory: directory,
    configLoader: () => ({ model: "test", protocol: "openai-images" }),
    generateImageFn: async () => { calls += 1; cancel(); return { data: PNG, mimeType: "image/png", model: "test" }; },
  });
  const result = await rpc((req, res) => { cancel = () => req.emit("aborted"); return handler(req, res); }, 1, "tools/call", { name: "generate_image", arguments: { prompt: "test" } });
  assert.equal(calls, 1);
  assert.equal(result.body.result._meta?.["ccdx/image_path"], undefined);
  assert.equal(fs.existsSync(directory), false);
});
