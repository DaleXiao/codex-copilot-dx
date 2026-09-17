import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runImageToolClient } from "../src/image-tool-client.mjs";

const IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const ENDPOINT = "http://127.0.0.1:2026/mcp/image";
const SOURCE_ID = "ccdx_img_5f204219-003e-4fca-9f31-25780acccabe";
const RESULT_ID = "ccdx_img_61b1f655-91d4-43aa-9784-cda9158dabcd";

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-tool-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const writes = [];
  const metadata = [];
  return { cwd, writes, metadata, output: { write: (value) => writes.push(value) }, metadataOutput: { write: (value) => metadata.push(value) } };
}

function serverFetch(requests, imageResult = { content: [{ type: "image", data: IMAGE, mimeType: "image/png" }] }) {
  return async (url, options) => {
    assert.equal(url, ENDPOINT);
    assert.equal(options.redirect, "error");
    const request = JSON.parse(options.body);
    requests.push(request);
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method === "initialize"
      ? { protocolVersion: "2025-06-18", serverInfo: { name: "ccdx-image", version: "1" } } : imageResult }), { headers: { "Content-Type": "application/json" } });
  };
}

test("image helper calls the configured local MCP once and saves its image with only a path on stdout", async (t) => {
  const context = fixture(t);
  const requests = [];
  const result = await runImageToolClient({
    ...context, endpoint: ENDPOINT, args: ["--prompt", "A cat's blue umbrella", "--size", "1536x1024"],
    fetchImpl: serverFetch(requests),
  });
  assert.deepEqual(requests.map(({ method }) => method), ["initialize", "notifications/initialized", "tools/call"]);
  assert.deepEqual(requests.at(-1).params, { name: "generate_image", arguments: { prompt: "A cat's blue umbrella", size: "1536x1024" }, _meta: { "ccdx/client_saves_image": true } });
  assert.deepEqual(fs.readFileSync(result), Buffer.from(IMAGE, "base64"));
  assert.equal(path.dirname(result), path.join(context.cwd, "output", "imagegen"));
  assert.equal(path.extname(result), ".png");
  assert.deepEqual(context.writes, [`${result}\n`]);
});

test("image helper rejects invalid inputs, remote endpoints and existing output without spending a generation", async (t) => {
  const context = fixture(t);
  const existing = path.join(context.cwd, "existing.png");
  fs.writeFileSync(existing, "keep");
  let calls = 0;
  const options = { ...context, endpoint: ENDPOINT, fetchImpl: async () => { calls += 1; throw new Error("unexpected network"); } };
  for (const args of [[], ["--prompt", "a", "--size", "1x1"], ["--prompt", "a", "--out"], ["--prompt", "a", "--prompt", "b"], ["--prompt", "a", "--out", existing],
    ["--prompt", "a", "--image-id", "../../source.png"], ["--prompt", "a", "--image-id", "ccdx_img_invalid"],
    ["--prompt", "a", "--image-id", SOURCE_ID, "--out", existing]]) {
    await assert.rejects(runImageToolClient({ ...options, args }));
  }
  await assert.rejects(runImageToolClient({ ...options, endpoint: "https://images.example/mcp/image", args: ["--prompt", "a"] }), /local/);
  assert.equal(await runImageToolClient({ ...options, args: ["--help"] }), null);
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(existing, "utf8"), "keep");
});

test("image helper edits the explicit source once, retains its size by omission and reports the new ID off stdout", async (t) => {
  const context = fixture(t);
  const requests = [];
  const source = path.join(context.cwd, "source.png");
  fs.writeFileSync(source, "original image");
  const result = await runImageToolClient({
    ...context, endpoint: ENDPOINT, args: ["--prompt", "Make the background blue; preserve the subject", "--image-id", SOURCE_ID],
    fetchImpl: serverFetch(requests, {
      content: [{ type: "image", data: IMAGE, mimeType: "image/png" }], _meta: { "ccdx/image_id": RESULT_ID },
    }),
  });
  assert.deepEqual(requests.filter(({ method }) => method === "tools/call").map(({ params }) => params), [{
    name: "edit_image", arguments: { prompt: "Make the background blue; preserve the subject", image_id: SOURCE_ID }, _meta: { "ccdx/client_saves_image": true },
  }]);
  assert.deepEqual(context.writes, [`${result}\n`]);
  assert.deepEqual(context.metadata, [`CCDX image_id: ${RESULT_ID}\n`]);
  assert.equal(fs.readFileSync(source, "utf8"), "original image");
  assert.deepEqual(fs.readFileSync(result), Buffer.from(IMAGE, "base64"));
});

test("image helper keeps square generation defaults and accepts an explicit editing size", async (t) => {
  const context = fixture(t);
  for (const [args, expected] of [
    [["--prompt", "A circle"], { name: "generate_image", arguments: { prompt: "A circle", size: "1024x1024" } }],
    [["--prompt", "A circle", "--image-id", SOURCE_ID, "--size", "1024x1536"], {
      name: "edit_image", arguments: { prompt: "A circle", size: "1024x1536", image_id: SOURCE_ID },
    }],
  ]) {
    const requests = [];
    await runImageToolClient({
      ...context, endpoint: ENDPOINT, args, fetchImpl: serverFetch(requests, {
        content: [{ type: "image", data: IMAGE, mimeType: "image/png" }], _meta: { "ccdx/image_id": "untrusted\nmetadata" },
      }),
    });
    assert.deepEqual(requests.at(-1).params, { ...expected, _meta: { "ccdx/client_saves_image": true } });
  }
  assert.deepEqual(context.metadata, []);
});

test("image helper does not replace a failed or unsupported edit with a new generation", async (t) => {
  const context = fixture(t);
  const requests = [];
  await assert.rejects(runImageToolClient({
    ...context, endpoint: ENDPOINT, args: ["--prompt", "Change the background", "--image-id", SOURCE_ID],
    fetchImpl: serverFetch(requests, { isError: true, content: [{ type: "text", text: "Image editing is not supported by this provider" }] }),
  }), /not supported/);
  assert.deepEqual(requests.filter(({ method }) => method === "tools/call").map(({ params }) => params.name), ["edit_image"]);
  assert.deepEqual(context.writes, []);
  assert.deepEqual(context.metadata, []);
});

test("image helper never retries a disabled, failed or ambiguous generation", async (t) => {
  const context = fixture(t);
  const requests = [];
  await assert.rejects(runImageToolClient({
    ...context, endpoint: ENDPOINT, args: ["--prompt", "A circle"],
    fetchImpl: serverFetch(requests, { isError: true, content: [{ type: "text", text: "Image generation is disabled.\nRun ccdx enable-image first." }] }),
  }), /disabled.*enable-image/);
  assert.equal(requests.filter(({ method }) => method === "tools/call").length, 1);
  assert.deepEqual(fs.readdirSync(path.join(context.cwd, "output", "imagegen")), []);
  const ambiguous = [];
  const normalFetch = serverFetch(ambiguous);
  await assert.rejects(runImageToolClient({
    ...context, endpoint: ENDPOINT, args: ["--prompt", "A circle"],
    fetchImpl: async (url, options) => {
      if (JSON.parse(options.body).method === "tools/call") {
        ambiguous.push(JSON.parse(options.body));
        throw new Error("socket disconnected");
      }
      return normalFetch(url, options);
    },
  }), /socket disconnected/);
  assert.equal(ambiguous.filter(({ method }) => method === "tools/call").length, 1);
  assert.deepEqual(context.writes, []);
});

test("image helper distinguishes denied local setup from a dispatched generation", async (t) => {
  const context = fixture(t);
  let calls = 0;
  await assert.rejects(runImageToolClient({
    ...context, endpoint: ENDPOINT, args: ["--prompt", "A circle"],
    fetchImpl: async (_url, { body }) => {
      calls += 1;
      assert.equal(JSON.parse(body).method, "initialize");
      throw new TypeError("fetch failed", { cause: { code: "EPERM" } });
    },
  }), (error) => error.code === "CCDX_IMAGE_NOT_STARTED" && /not started.*permission/i.test(error.message));
  assert.equal(calls, 1);
});

test("image helper rejects malformed image responses and never overwrites a concurrently created file", async (t) => {
  const context = fixture(t);
  await assert.rejects(runImageToolClient({
    ...context, endpoint: ENDPOINT, args: ["--prompt", "A circle"],
    fetchImpl: serverFetch([], { content: [{ type: "image", data: "not base64", mimeType: "image/png" }] }),
  }), /invalid image/);
  const destination = path.join(context.cwd, "race.png");
  const normalFetch = serverFetch([]);
  await assert.rejects(runImageToolClient({
    ...context, endpoint: ENDPOINT, args: ["--prompt", "A circle", "--out", destination],
    fetchImpl: async (url, options) => {
      if (JSON.parse(options.body).method === "tools/call") fs.writeFileSync(destination, "other writer");
      return normalFetch(url, options);
    },
  }), { code: "EEXIST" });
  assert.equal(fs.readFileSync(destination, "utf8"), "other writer");
});

test("image helper caps declared response size before reading it", async (t) => {
  const context = fixture(t);
  let calls = 0;
  await assert.rejects(runImageToolClient({
    ...context, endpoint: ENDPOINT, args: ["--prompt", "A circle"],
    fetchImpl: async () => {
      calls += 1;
      return new Response("{}", { headers: { "content-length": String(49 * 1024 * 1024) } });
    },
  }), /size limit/);
  assert.equal(calls, 1);
});

test("image helper refuses a wrong local service or invalid JSON-RPC identity before generating", async (t) => {
  const context = fixture(t);
  for (const body of [
    { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "another-service" } } },
    { jsonrpc: "2.0", id: 9, result: { serverInfo: { name: "ccdx-image" } } },
    { id: 1, result: { serverInfo: { name: "ccdx-image" } } },
  ]) {
    let calls = 0;
    await assert.rejects(runImageToolClient({
      ...context, endpoint: ENDPOINT, args: ["--prompt", "A circle"],
      fetchImpl: async () => { calls += 1; return new Response(JSON.stringify(body)); },
    }), /not CCDX|invalid JSON-RPC/);
    assert.equal(calls, 1);
  }
});
