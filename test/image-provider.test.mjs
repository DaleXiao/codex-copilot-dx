import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import https from "node:https";
import { test } from "node:test";
import { downloadPublicImage, generateImage, IMAGE_INPUT_MAX_BYTES, supportsImageEditing } from "../src/image-provider.mjs";

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

test("image provider: enables editing only for verified Qwen models and supported dialects", () => {
  for (const model of ["qwen-image-3.0-pro", "qwen-image-3.0"]) {
    for (const protocol of ["qwen-messages", "openai-images"]) {
      assert.equal(supportsImageEditing({ model, protocol }), true);
    }
  }
  for (const config of [undefined, {}, { model: "gpt-image-1", protocol: "openai-images" },
    { model: "qwen-image-3.0-pro-preview", protocol: "qwen-messages" },
    { model: "qwen-image-3.0-pro", protocol: "unknown" }]) {
    assert.equal(supportsImageEditing(config), false);
  }
});

test("image provider: sends one edit request with the source image in each supported dialect", async () => {
  const bytes = png();
  const image = `data:image/png;base64,${bytes.toString("base64")}`;
  for (const protocol of ["qwen-messages", "openai-images"]) {
    let calls = 0;
    const result = await generateImage({
      endpoint: "https://images.example/v1/images/generations",
      api_key: "secret-value",
      model: "qwen-image-3.0-pro",
      protocol,
    }, { prompt: "Make the circle red", size: "1024x1024", image }, {
      fetchImpl: async (url, init) => {
        calls += 1;
        assert.equal(url, "https://images.example/v1/images/generations");
        assert.equal(init.method, "POST");
        assert.deepEqual(JSON.parse(init.body), protocol === "qwen-messages" ? {
          model: "qwen-image-3.0-pro",
          input: { messages: [{ role: "user", content: [{ image }, { text: "Make the circle red" }] }] },
          parameters: { n: 1, size: "1024*1024", watermark: false },
        } : {
          model: "qwen-image-3.0-pro", prompt: "Make the circle red", n: 1, size: "1024x1024", image,
        });
        return Response.json({ data: [{ b64_json: bytes.toString("base64") }] });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.data, bytes.toString("base64"));
  }
});

test("image provider: accepts canonical JPEG and WebP edit input", async () => {
  const inputs = [
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
    ["image/webp", Buffer.from("RIFF\u0004\u0000\u0000\u0000WEBP", "binary")],
  ];
  for (const [mimeType, bytes] of inputs) {
    const image = `data:${mimeType};base64,${bytes.toString("base64")}`;
    let calls = 0;
    await generateImage({ model: "qwen-image-3.0", protocol: "qwen-messages" }, { prompt: "Change the background", image }, {
      fetchImpl: async (_url, init) => {
        calls += 1;
        assert.equal(JSON.parse(init.body).input.messages[0].content[0].image, image);
        return Response.json({ data: [{ b64_json: png().toString("base64") }] });
      },
    });
    assert.equal(calls, 1);
  }
});

test("image provider: rejects unsupported or invalid edit input before any request", async () => {
  let calls = 0;
  const options = { fetchImpl: async () => { calls += 1; throw new Error("must not fetch"); } };
  const config = { model: "qwen-image-3.0-pro", protocol: "qwen-messages" };
  const encoded = png().toString("base64");
  await assert.rejects(generateImage({ model: "gpt-image-1", protocol: "openai-images" }, {
    prompt: "Edit", image: `data:image/png;base64,${encoded}`,
  }, options), { code: "ccdx_image_edit_unsupported" });
  for (const image of [null, "", "https://images.example/input.png", `data:image/gif;base64,${encoded}`,
    `data:image/jpeg;base64,${encoded}`, `data:image/png;base64,${encoded}\n`,
    `data:image/png;base64,${encoded.replace(/=+$/, "")}`, "data:image/png;base64,A===",
    "data:image/png;base64,AAAA", "data:image/png;base64,AB=="]) {
    await assert.rejects(generateImage(config, { prompt: "Edit", image }, options), { code: "ccdx_image_input_invalid" });
  }
  const oversized = Buffer.alloc(IMAGE_INPUT_MAX_BYTES + 1).toString("base64");
  await assert.rejects(generateImage(config, { prompt: "Edit", image: `data:image/png;base64,${oversized}` }, options), {
    code: "ccdx_image_input_too_large",
  });
  await assert.rejects(generateImage(config, { prompt: "Edit", image: `data:image/png;base64,${oversized}AAAA` }, options), {
    code: "ccdx_image_input_too_large",
  });
  assert.equal(calls, 0);
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

test("image downloads apply their deadline during DNS and ignore late lookup results", async (t) => {
  let completeLookup;
  let connections = 0;
  t.mock.method(https, "get", () => { connections += 1; throw new Error("must not connect"); });
  const downloading = downloadPublicImage("https://cdn.example/result.png", {
    lookup: () => new Promise((resolve) => { completeLookup = resolve; }),
    timeoutMs: 10,
  }).then(() => null, (error) => error);
  const result = await Promise.race([downloading, new Promise((resolve) => setTimeout(() => resolve(null), 80))]);
  assert.equal(result?.code, "ccdx_image_timeout");
  completeLookup([{ address: "1.1.1.1", family: 4 }]);
  await new Promise(setImmediate);
  assert.equal(connections, 0);
});

test("image downloads cancel during DNS and do not look up an already cancelled request", async (t) => {
  let lookups = 0;
  let rejectLookup;
  let connections = 0;
  t.mock.method(https, "get", () => { connections += 1; throw new Error("must not connect"); });
  const controller = new AbortController();
  const cancelled = new Error("fixture cancellation");
  const options = {
    lookup: () => { lookups += 1; return new Promise((_resolve, reject) => { rejectLookup = reject; }); },
    timeoutMs: 1000,
    signal: controller.signal,
  };
  const downloading = downloadPublicImage("https://cdn.example/result.png", options).then(() => null, (error) => error);
  await new Promise(setImmediate);
  controller.abort(cancelled);
  const result = await Promise.race([downloading, new Promise((resolve) => setTimeout(() => resolve(null), 80))]);
  assert.equal(result, cancelled);
  rejectLookup(new Error("late DNS failure"));
  await new Promise(setImmediate);
  await assert.rejects(downloadPublicImage("https://cdn.example/result.png", options), (error) => error === cancelled);
  assert.equal(lookups, 1);
  assert.equal(connections, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("image downloads retain pinned DNS, bounded image bytes, and one transfer", async (t) => {
  const controller = new AbortController();
  const bytes = png();
  let lookups = 0;
  let connections = 0;
  const request = new EventEmitter();
  request.destroy = (error) => { queueMicrotask(() => request.emit("error", error)); };
  t.mock.method(https, "get", (url, options, callback) => {
    connections += 1;
    assert.equal(url.href, "https://cdn.example/result.png");
    assert.equal(options.headers.Authorization, undefined);
    options.lookup(url.hostname, {}, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, "1.1.1.1");
      assert.equal(family, 4);
    });
    setImmediate(() => {
      const response = new EventEmitter();
      Object.assign(response, { statusCode: 200, headers: { "content-length": String(bytes.length) } });
      callback(response);
      response.emit("data", bytes.subarray(0, 12));
      response.emit("data", bytes.subarray(12));
      response.emit("end");
    });
    return request;
  });
  const result = await downloadPublicImage("https://cdn.example/result.png", {
    lookup: async () => { lookups += 1; return [{ address: "1.1.1.1", family: 4 }]; },
    signal: controller.signal,
  });
  assert.deepEqual(result, bytes);
  assert.equal(lookups, 1);
  assert.equal(connections, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("image download cancellation destroys an active transfer without retrying", async (t) => {
  const controller = new AbortController();
  let connections = 0;
  let destroyed = 0;
  const request = new EventEmitter();
  request.destroy = (error) => { destroyed += 1; queueMicrotask(() => request.emit("error", error)); };
  t.mock.method(https, "get", () => { connections += 1; return request; });
  const downloading = downloadPublicImage("https://cdn.example/result.png", {
    lookup: async () => [{ address: "1.1.1.1", family: 4 }], signal: controller.signal,
  });
  await new Promise(setImmediate);
  controller.abort(new Error("cancel transfer"));
  await assert.rejects(downloading, /cancel transfer/);
  assert.equal(connections, 1);
  assert.equal(destroyed, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("image download failure closes the transfer and safely absorbs response errors", async (t) => {
  for (const [statusCode, headers, expected] of [
    [503, {}, /HTTP 503/],
    [200, { "content-length": "100" }, /size limit/],
  ]) {
    let destroyed = 0;
    const response = new EventEmitter();
    Object.assign(response, { statusCode, headers, resume() {}, destroy() {} });
    const request = new EventEmitter();
    request.destroy = (error) => {
      destroyed += 1;
      queueMicrotask(() => { response.emit("error", error); request.emit("error", error); });
    };
    const mocked = t.mock.method(https, "get", (_url, _options, callback) => {
      setImmediate(() => callback(response));
      return request;
    });
    await assert.rejects(downloadPublicImage("https://cdn.example/result.png", {
      lookup: async () => [{ address: "1.1.1.1", family: 4 }], maxBytes: 50,
    }), expected);
    assert.equal(mocked.mock.callCount(), 1);
    assert.equal(destroyed, 1);
    mocked.mock.restore();
  }
});
