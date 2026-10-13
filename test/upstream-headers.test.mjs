import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createAdapterHandler } from "../src/adapter.mjs";
import { sendUpstreamError } from "../src/http-transport.mjs";
import { safeUpstreamResponseHeaders } from "../src/upstream-headers.mjs";

async function invokeAdapter(options, { url = "/v1/responses", body } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = { "content-type": "application/json" };
  req.method = "POST";
  req.url = url;
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.headersSent = false;
  res.statusCode = 200;
  res.headers = {};
  const chunks = [];
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.writeHead = (statusCode, headers = {}) => {
    res.statusCode = statusCode;
    res.headers = { ...res.headers, ...headers };
    res.headersSent = true;
    return res;
  };
  res.write = (chunk) => { chunks.push(Buffer.from(chunk)); return true; };
  res.end = (chunk) => {
    if (chunk !== undefined) chunks.push(Buffer.from(chunk));
    res.writableEnded = true;
    return res;
  };
  await createAdapterHandler(options)(req, res);
  return { status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") };
}

function upstreamResponse(body, requestId) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "retry-after": "3",
      "x-request-id": requestId,
      "set-cookie": "session=secret",
      "authorization": "Bearer secret",
      "content-length": "999",
    },
  });
}

test("safeUpstreamResponseHeaders keeps quota metadata and renames upstream request ids", () => {
  const headers = new Headers({
    "content-type": "application/json",
    "retry-after": "7",
    "x-ratelimit-remaining": "3",
    "x-request-id": "upstream-123",
    "set-cookie": "session=secret",
    "authorization": "Bearer secret",
    "content-length": "99",
  });

  assert.deepEqual(safeUpstreamResponseHeaders(headers), {
    "Content-Type": "application/json",
    "Retry-After": "7",
    "X-Ratelimit-Remaining": "3",
    "X-Upstream-Request-Id": "upstream-123",
  });
});

test("safeUpstreamResponseHeaders uses a default content type without inventing metadata", () => {
  assert.deepEqual(safeUpstreamResponseHeaders(new Headers(), {
    defaultContentType: "text/event-stream",
  }), {
    "Content-Type": "text/event-stream",
  });
});

test("only native Responses can preserve an explicit true reasoning declaration; false is never forwarded", () => {
  for (const value of ["true", "TRUE", " true "]) {
    const headers = new Headers({ "x-reasoning-included": value, "set-cookie": "secret" });
    assert.deepEqual(safeUpstreamResponseHeaders(headers), {});
    assert.deepEqual(safeUpstreamResponseHeaders(headers, { allowReasoningIncluded: true }), { "X-Reasoning-Included": "true" });
  }
  for (const value of ["false", "0", "1", "yes", "", "true, false"]) {
    assert.deepEqual(safeUpstreamResponseHeaders(new Headers({ "x-reasoning-included": value }), { allowReasoningIncluded: true }), {});
  }
  assert.deepEqual(safeUpstreamResponseHeaders(new Headers(), { allowReasoningIncluded: true }), {});
});

test("sendUpstreamError preserves safe retry metadata without forwarding secrets", () => {
  const result = { status: null, headers: null, body: null };
  const res = {
    headersSent: false,
    writeHead(status, headers) {
      result.status = status;
      result.headers = headers;
      this.headersSent = true;
    },
    end(body) { result.body = body; },
  };
  const response = new Response("rate limited", {
    status: 429,
    headers: {
      "content-type": "text/plain",
      "retry-after": "4",
      "x-request-id": "upstream-rate-limit",
      "set-cookie": "secret=1",
    },
  });

  sendUpstreamError(res, response, "rate limited");
  assert.equal(result.status, 429);
  assert.equal(result.headers["Retry-After"], "4");
  assert.equal(result.headers["X-Upstream-Request-Id"], "upstream-rate-limit");
  assert.equal(Object.hasOwn(result.headers, "Set-Cookie"), false);
  assert.equal(result.body, "rate limited");
});

test("successful native and converted Responses replies propagate only safe metadata", async () => {
  const cases = [
    {
      requestId: "native-upstream",
      options: { responsesFn: async () => upstreamResponse({ id: "resp_native", status: "completed", output: [] }, "native-upstream") },
      request: { body: { model: "gpt-5.6-sol", stream: false, input: "hello" } },
    },
    {
      requestId: "chat-upstream",
      options: { chatCompletionsFn: async () => upstreamResponse({ id: "chat_1", choices: [{ message: { role: "assistant", content: "ok" } }] }, "chat-upstream") },
      request: { body: { model: "gpt-4o", stream: false, input: "hello" } },
    },
  ];

  for (const { requestId, options, request } of cases) {
    const result = await invokeAdapter(options, request);
    assert.equal(result.status, 200);
    assert.equal(result.headers["Retry-After"], "3");
    assert.equal(result.headers["X-Upstream-Request-Id"], requestId);
    assert.notEqual(result.headers["X-Request-Id"], requestId);
    assert.equal(Object.hasOwn(result.headers, "Set-Cookie"), false);
    assert.equal(Object.hasOwn(result.headers, "Authorization"), false);
    assert.equal(Object.hasOwn(result.headers, "Content-Length"), false);
  }
});

test("native JSON/SSE preserve true without declaring it for errors or the Chat bridge", async (t) => {
  const original = process.env.CCDX_DISABLE_USAGE;
  process.env.CCDX_DISABLE_USAGE = "1";
  t.after(() => { if (original === undefined) delete process.env.CCDX_DISABLE_USAGE; else process.env.CCDX_DISABLE_USAGE = original; });
  const declared = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status, headers: { "content-type": typeof body === "string" ? "text/event-stream" : "application/json", "x-reasoning-included": "true" },
  });
  const response = { id: "resp_reasoning", model: "gpt-5.6-sol", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 7, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 17 } };
  for (const stream of [false, true]) {
    const result = await invokeAdapter({ responsesFn: async () => declared(stream ? `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n` : response) },
      { body: { model: "gpt-5.6-sol", stream, input: "test" } });
    assert.equal(result.headers["X-Reasoning-Included"], "true");
  }
  for (const [body, status] of [[{ error: { message: "denied" } }, 403], [{ ...response, status: "failed", error: { message: "failed" } }, 200]]) {
    const result = await invokeAdapter({ responsesFn: async () => declared(body, status) }, { body: { model: "gpt-5.6-sol", stream: false, input: "test" } });
    assert.equal(Object.hasOwn(result.headers, "X-Reasoning-Included"), false);
  }
  const converted = await invokeAdapter({ chatCompletionsFn: async () => declared({ id: "chat_1", choices: [{ message: { role: "assistant", content: "ok" } }] }) },
    { body: { model: "gpt-4o", stream: false, input: "test" } });
  assert.equal(Object.hasOwn(converted.headers, "X-Reasoning-Included"), false);
});
