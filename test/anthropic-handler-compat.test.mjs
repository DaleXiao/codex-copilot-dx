import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createAdapterHandler } from "../src/adapter.mjs";
import { MAX_UPSTREAM_CHAT_SUCCESS_BODY_BYTES } from "../src/http-transport.mjs";

async function invokeMessages(chatCompletionsFn, { closeOnFirstWrite = false, stream = false } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify({
    model: "claude-sonnet-4.6",
    max_tokens: 64,
    stream,
    messages: [{ role: "user", content: "use the tool" }],
  }))]);
  req.headers = { "content-type": "application/json" };
  req.method = "POST";
  req.url = "/v1/messages";
  req.socket = { remoteAddress: "127.0.0.1" };

  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.headersSent = false;
  res.statusCode = 200;
  res.headers = {};
  const chunks = [];
  let writes = 0;
  res.writeHead = (statusCode, headers = {}) => {
    res.statusCode = statusCode;
    res.headers = { ...res.headers, ...headers };
    res.headersSent = true;
    return res;
  };
  res.write = (chunk) => {
    writes += 1;
    chunks.push(Buffer.from(chunk));
    if (closeOnFirstWrite && writes === 1) {
      queueMicrotask(() => {
        res.destroyed = true;
        res.emit("close");
        finish();
      });
      return false;
    }
    return true;
  };
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  res.end = (chunk) => {
    if (chunk !== undefined) chunks.push(Buffer.from(chunk));
    res.writableEnded = true;
    finish();
    return res;
  };

  const pending = createAdapterHandler({ chatCompletionsFn })(req, res);
  await Promise.all([pending, finished]);
  return { status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") };
}

test("HTTP Messages rejects malformed and non-object upstream tool arguments without leaking them", async () => {
  const cases = [
    "{\"private\":\"raw-invalid-secret\"",
    '"raw-scalar-secret"',
  ];

  for (const rawArguments of cases) {
    const result = await invokeMessages(async () => Response.json({
      model: "claude-sonnet-4.6",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [{
            id: "call_dangerous",
            type: "function",
            function: { name: "dangerous_tool", arguments: rawArguments },
          }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    }));

    assert.equal(result.status, 502);
    const payload = JSON.parse(result.text);
    assert.equal(payload.error.code, "upstream_tool_arguments_json_invalid");
    assert.equal(payload.error.type, "upstream_protocol_error");
    assert.doesNotMatch(result.text, /tool_use|"input"\s*:\s*\{\}/);
    assert.doesNotMatch(result.text, /raw-(?:invalid|scalar)-secret/);
    assert.equal(result.text.includes(rawArguments), false);
  }
});

test("HTTP Messages rewrites explicit context-window failures for Anthropic clients", async () => {
  const upstreamBodies = [
    { error: { code: "model_max_prompt_tokens_exceeded", message: "prompt token count exceeds the limit" } },
    { error: { message: "Your input exceeds the context window of this model. Please adjust your input." } },
  ];

  for (const [index, upstreamBody] of upstreamBodies.entries()) {
    const upstreamStatus = index === 0 ? 413 : 400;
    const result = await invokeMessages(async () => new Response(JSON.stringify(upstreamBody), {
      status: upstreamStatus,
      headers: {
        "content-type": "text/plain",
        "retry-after": "2",
        "x-request-id": `context-${index}`,
      },
    }), { stream: index === 1 });

    assert.equal(result.status, upstreamStatus);
    assert.equal(result.headers["Content-Type"], "application/json");
    assert.equal(result.headers["Retry-After"], "2");
    assert.equal(result.headers["X-Upstream-Request-Id"], `context-${index}`);
    assert.deepEqual(JSON.parse(result.text), {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "prompt is too long: your prompt is too long. Please reduce the number of messages or use a model with a larger context window.",
      },
    });
  }
});

test("HTTP Messages preserves unrelated upstream failures", async () => {
  const upstreamText = JSON.stringify({ error: { code: "rate_limit_exceeded", message: "context service busy" } });
  const result = await invokeMessages(async () => new Response(upstreamText, {
    status: 429,
    headers: {
      "content-type": "application/problem+json",
      "retry-after": "7",
      "x-request-id": "rate-limit-1",
    },
  }));

  assert.equal(result.status, 429);
  assert.equal(result.text, upstreamText);
  assert.equal(result.headers["Content-Type"], "application/problem+json");
  assert.equal(result.headers["Retry-After"], "7");
  assert.equal(result.headers["X-Upstream-Request-Id"], "rate-limit-1");
});

test("HTTP Messages bounds successful unary Chat bodies independently from error bodies", async () => {
  const result = await invokeMessages(async () => new Response(JSON.stringify({ choices: [] }), {
    headers: { "Content-Length": String(MAX_UPSTREAM_CHAT_SUCCESS_BODY_BYTES + 1) },
  }));

  assert.equal(result.status, 502);
  assert.equal(JSON.parse(result.text).error.code, "ccdx_upstream_response_too_large");
});

test("HTTP Messages cancels its upstream stream quietly when the downstream closes", async () => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(Buffer.from([
        'data: {"choices":[{"delta":{"content":"first"}}]}',
        'data: {"choices":[{"delta":{"content":"second"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n")));
    },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } });

  const result = await invokeMessages(async () => upstream, { stream: true, closeOnFirstWrite: true });

  assert.equal(cancelled, true);
  assert.equal(result.text.includes("message_stop"), false);
});
