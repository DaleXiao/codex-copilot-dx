import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { invokeAdapter, invokeAdapterRequest } from "../test-support/adapter.mjs";
import { Readable } from "node:stream";
import { createAdapterHandler } from "../src/adapter.mjs";
import { NATIVE_IMAGE_MODEL, nativeImageRequest } from "../src/native-images.mjs";
import { createCopilotClient } from "../src/copilot.mjs";
import { defaultAccessSettings, updateAccessSettings } from "../src/access-settings.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const png = (await sharp({ create: { width: 16, height: 16, channels: 3, background: "blue" } }).png().toBuffer()).toString("base64");
const request = { model: "gpt-image-2", prompt: "A blue circle", background: "opaque", quality: "auto", size: "auto" };
const result = { created: 1, background: "opaque", quality: "low", size: "1024x1024", data: [{ b64_json: png }], usage: { input_tokens: 2, output_tokens: 3 } };
function fixture(extra = {}) {
  const calls = [];
  return { calls, options: { imagesEnabled: () => true, imagesAllowed: () => true, imageModels: () => [{ id: NATIVE_IMAGE_MODEL, editing: true }],
    privacy: { close() {}, snapshot: () => ({}), wrap: fn => fn, close() {} },
    codexClient: { images: async (operation, body) => { calls.push({ operation, body });return Response.json(result); } }, ...extra } };
}

test("native generation and inline editing preserve Images API responses and map the requested model to Flare", async () => {
  const f = fixture();
  for (const operation of ["generations", "edits"]) {
    const body = { ...request, ...(operation === "edits" ? { images: [{ image_url: `data:image/png;base64,${png}` }] } : {}) };
    const r = await invokeAdapter(f.options, { url: `/v1/images/${operation}`, body });
    assert.equal(r.status, 200, r.text);assert.deepEqual(JSON.parse(r.text), result);
    assert.equal(r.headers["X-CCDX-Image-Model"], NATIVE_IMAGE_MODEL);
    assert.deepEqual(f.calls.at(-1), { operation, body: { ...body, model: NATIVE_IMAGE_MODEL, n: 1 } });
  }
});

test("invalid image requests are refused before any upstream dispatch", async () => {
  const f = fixture();
  for (const patch of [{ model: "other" }, { prompt: " " }, { prompt: 12 }, { n: 2 }, { size: "4k" }, { quality: "unknown" }, { background: "unknown" }, { output_format: "gif" }, { images: [] }]) {
    assert.equal((await invokeAdapter(f.options, { url: "/v1/images/generations", body: { ...request, ...patch } })).status, 400);
  }
  for (const images of [[], [{ file_id: "file-remote" }], [{ image_url: "https://example.test/image.png" }], [{ image_url: "data:image/png;base64,Zm9v" }]]) {
    assert.equal((await invokeAdapter(f.options, { url: "/v1/images/edits", body: { ...request, images } })).status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test("native routes enforce pause, local access, content type and method; the MCP is permanently retired", async () => {
  for (const [extra, patch, status] of [[{ imagesEnabled: () => false }, {}, 503], [{ imagesAllowed: () => false }, {}, 403],
    [{}, { headers: { origin: "https://example.test" } }, 403], [{}, { headers: { host: "evil.test" } }, 403],
    [{}, { headers: { "content-type": "text/plain" } }, 415], [{}, { method: "GET" }, 405]]) {
    const f = fixture(extra), r = await invokeAdapter(f.options, { url: "/v1/images/generations", body: request, ...patch });
    assert.equal(r.status, status, r.text);assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  const old = await invokeAdapter(f.options, { url: "/mcp/image", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  assert.equal(old.status, 410);assert.match(old.text, /ccdx_image_mcp_retired/);assert.equal(f.calls.length, 0);
});

test("image errors and malformed upstream pixels do not become successful images or trigger retries", async () => {
  for (const response of [() => Response.json({ error: { message: "quota exhausted" } }, { status: 429 }),
    () => Response.json({ ...result, data: [{ b64_json: "Zm9v" }] }), () => new Response("broken")]) {
    let calls = 0;
    const f = fixture({ codexClient: { images: async () => { calls++;return response(); } } });
    const r = await invokeAdapter(f.options, { url: "/v1/images/generations", body: request });
    assert.ok([429, 502].includes(r.status), r.text);assert.equal(calls, 1);
  }
});

test("prompt privacy applies before image dispatch and failed checks prevent dispatch", async () => {
  const f = fixture({ privacy: { close() {}, snapshot: () => ({}), wrap: fn => async () => fn({ input: "MASKED" }) } });
  assert.equal((await invokeAdapter(f.options, { url: "/v1/images/generations", body: request })).status, 200);
  assert.equal(f.calls[0].body.prompt, "MASKED");
  const blocked = fixture({ privacy: { close() {}, snapshot: () => ({}), wrap: () => async () => { throw Object.assign(Error("Masking unavailable"), { statusCode: 503 }); } } });
  assert.equal((await invokeAdapter(blocked.options, { url: "/v1/images/generations", body: request })).status, 503);
  assert.equal(blocked.calls.length, 0);
});

test("image cancellation aborts the upstream signal and releases the two-operation limit", async () => {
  let signal;
  const f = fixture({ imageTimeoutMs: 20, codexClient: { images: async (_op, _body, options) => {
    signal = options.signal;return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } } });
  const r = await invokeAdapter(f.options, { url: "/v1/images/generations", body: request });
  assert.equal(r.status, 504);assert.equal(signal.aborted, true);
});

test("image routes honor GitHub source access independently of the selected text provider", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-native-image-access-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  updateAccessSettings(s => { s.providers.github = false;return s; }, { home, env: {} });
  const f = fixture({ imagesAllowed: undefined, dashboardOptions: { home }, env: {} });
  assert.equal((await invokeAdapter(f.options, { url: "/v1/images/generations", body: request })).status, 403);
  assert.equal(f.calls.length, 0);
});

test("GHC image transport reuses its token and advertised API host without inference retries or redirects", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-native-image-token-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const tokenPath = path.join(home, "github_token");fs.writeFileSync(tokenPath, "synthetic-github");let refreshes = 0, calls = 0;
  const client = createCopilotClient({ tokenPath, allowTokenDiscovery: false, readGithubIdentity: () => ({ id: "1", login: "fixture" }), tokenFetchImpl: async () => {
    refreshes++;return Response.json({ token: "synthetic-service", expires_at: Math.floor(Date.now() / 1000) + 3600, endpoints: { api: "https://ghc.example.test" } });
  } });
  const fetchImpl = async (url, init) => { calls++;assert.equal(url, "https://ghc.example.test/v1/images/generations");
    assert.equal(init.redirect, "error");assert.equal(init.headers.Authorization, "Bearer synthetic-service");return Response.json({}, { status: 503 }); };
  await client.images("generations", { ...request, model: NATIVE_IMAGE_MODEL }, { fetchImpl });
  await client.images("generations", { ...request, model: NATIVE_IMAGE_MODEL }, { fetchImpl });
  assert.equal(refreshes, 1);assert.equal(calls, 2);
});

test("image HTTP errors are safe JSON with metadata and release the vendor body", async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    let cancelled = 0, calls = 0;
    const response = new Response(new ReadableStream({ cancel() { cancelled++; } }), { status,
      headers: { 'Content-Type': 'text/html', 'Retry-After': '12', 'Set-Cookie': 'private=sensitive', 'x-request-id': 'image-fixture' } });
    const f = fixture({ codexClient: { images: async () => { calls++;return response; } } });
    const r = await invokeAdapter(f.options, { url: '/v1/images/generations', body: request });
    assert.equal(r.status, status);assert.equal(JSON.parse(r.text).error.code, `ccdx_images_http_${status}`);
    assert.equal(r.headers['Content-Type'], 'application/json');assert.equal(r.headers['Retry-After'], '12');
    assert.equal(r.headers['Set-Cookie'], undefined);assert.equal(cancelled, 1);assert.equal(calls, 1);
  }
});

test("image errors expose only allowlisted source codes and preserve HTTP metadata", async () => {
  for (const [status, upstream, expected] of [[429, "credit_balance_exhausted", "credit_balance_exhausted"],
    [422, "context_length_exceeded", "context_length_exceeded"], [502, "context_length_exceeded", null], [422, "unrecognized", null]]) {
    let calls = 0;const f = fixture({ codexClient: { images: async () => { calls++;
      return Response.json({ error: { code: upstream, message: "private prompt synthetic-secret" } }, { status, headers: { "Retry-After": "12" } });
    } } });
    const r = await invokeAdapter(f.options, { url: "/v1/images/generations", body: request });
    const error = JSON.parse(r.text).error;
    assert.equal(r.status, status);assert.equal(error.code, `ccdx_images_http_${status}`);assert.equal(error.upstream_code || null, expected);
    assert.equal(r.headers["Retry-After"], "12");assert.equal(calls, 1);assert.doesNotMatch(r.text, /private prompt|synthetic-secret/);
  }
});

test("the retained image failure contains the safe source code, not vendor text", async t => {
  const f = fixture({ codexClient: { images: async () => Response.json({ error: { code: "credit_balance_exhausted", message: "private-prompt fixture-secret" } }, { status: 429 }) } });
  const handler = createAdapterHandler(f.options);t.after(() => handler.cleanup?.());
  const bytes = Buffer.from(JSON.stringify(request)), req = Readable.from([bytes]);
  req.headers = { "content-type": "application/json", "content-length": String(bytes.length) };
  req.method = "POST";req.url = "/v1/images/generations";req.socket = { remoteAddress: "127.0.0.1" };
  const response = await invokeAdapterRequest({}, req, handler);assert.equal(response.status, 429);
  const issue = handler.snapshot().http_errors.actionable_recent.at(-1);
  assert.equal(issue.code, "ccdx_images_http_429");assert.equal(issue.upstream_code, "credit_balance_exhausted");
  assert.doesNotMatch(JSON.stringify(issue), /private-prompt|fixture-secret/);
});

test("slow upstream error bodies do not occupy the two image generation slots", async t => {
  let reading = 0, ready;const started = new Promise(resolve => { ready = resolve; });
  const f = fixture({ codexClient: { images: async (_operation, body) => {
    if (body.prompt === "success") return Response.json(result);
    return new Response(new ReadableStream({ pull() { if (++reading === 2) ready();return new Promise(() => {}); }, cancel() {} }), { status: 429 });
  } } });
  const handler = createAdapterHandler(f.options);t.after(() => handler.cleanup?.());
  const call = prompt => {
    const bytes = Buffer.from(JSON.stringify({ ...request, prompt })), req = Readable.from([bytes]);
    req.headers = { "content-type": "application/json", "content-length": String(bytes.length) };
    req.method = "POST";req.url = "/v1/images/generations";req.socket = { remoteAddress: "127.0.0.1" };
    return invokeAdapterRequest({}, req, handler);
  };
  const errors = Promise.all([call("one"), call("two")]);await started;await new Promise(setImmediate);
  const success = await call("success");assert.equal(success.status, 200);assert.equal(JSON.parse(success.text).data.length, 1);
  for (const result of await errors) assert.equal(result.status, 429);
});
