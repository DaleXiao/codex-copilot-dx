import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearResponseHistoryForTests,
  createAdapterHandler,
  prepareResponsesRequest,
  responseHistoryStats,
} from "../src/adapter.mjs";
import { ToolArgumentDeltaGuard } from "../src/stream-contract.mjs";
import { flushUsageWritesForTests, readUsageRecords } from "../src/usage.mjs";

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
  res.write = (chunk) => {
    chunks.push(Buffer.from(chunk));
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

  const pending = createAdapterHandler(options)(req, res);
  await Promise.all([pending, finished]);
  return {
    status: res.statusCode,
    headers: res.headers,
    text: Buffer.concat(chunks).toString("utf8"),
  };
}

function sseResponse(body) {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

test("native Responses turns upstream error frames into complete failures without waiting for EOF", async () => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    for (const typed of [false, true]) {
      let cancelled = false, timer;
      const created = { type: "response.created", sequence_number: 4, response: {
        id: "resp_fixture", object: "response", created_at: 1700000000, model: "upstream-model", status: "in_progress", output: [],
      } };
      const delta = { type: "response.output_text.delta", sequence_number: 5, output_index: 0, delta: "partial" };
      const error = typed ? { type: "error", code: "fixture_overload", message: "synthetic failure" }
        : { error: { code: "fixture_overload", message: "synthetic failure" } };
      const frame = value => `${value.type ? `event: ${value.type}${ending}` : ""}data: ${JSON.stringify(value)}${ending}${ending}`;
      const bytes = Buffer.from(frame(created) + frame(delta) + frame(error));
      const source = new ReadableStream({
        start(controller) {
          for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.subarray(at, at + 7));
          timer = setTimeout(() => controller.close(), 150);
        },
        cancel() { cancelled = true;clearTimeout(timer); },
      });
      const result = await invokeAdapter({ responsesFn: async () => new Response(source, { headers: { "Content-Type": "text/event-stream" } }) },
        { body: { model: "gpt-5.6-sol", stream: true, input: "synthetic" } });
      const events = result.text.split(/\r\n|\r|\n/).filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
      const failed = events.at(-1);
      assert.equal(cancelled, true);assert.match(result.text, /event: response\.failed/);
      assert.equal(failed.type, "response.failed");assert.equal(failed.sequence_number, 6);
      assert.equal(failed.response.id, "resp_fixture");assert.equal(failed.response.created_at, 1700000000);
      assert.equal(failed.response.model, "upstream-model");assert.equal(failed.response.object, "response");
      assert.equal(failed.response.status, "failed");assert.deepEqual(failed.response.output, []);
      assert.equal(failed.response.error.code, "fixture_overload");assert.equal(failed.response.error.message, "synthetic failure");
      assert.doesNotMatch(result.text, /upstream_stream_incomplete|response\.completed/);
    }
  }
});

test("a truncated Responses stream reports its actual failure with a valid terminal envelope", async () => {
  const created = { type: "response.created", sequence_number: 0, response: {
    id: "resp_partial", object: "response", created_at: 1700000000, model: "fixture-model", status: "in_progress", output: [],
  } };
  const delta = { type: "response.output_text.delta", sequence_number: 1, output_index: 0, delta: "partial" };
  const source = [created, delta].map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join("");
  const result = await invokeAdapter({ responsesFn: async () => sseResponse(source) },
    { body: { model: "gpt-5.6-sol", stream: true, input: "synthetic" } });
  const failed = result.text.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))).at(-1);
  assert.equal(failed.type, "response.failed");assert.equal(failed.sequence_number, 2);
  assert.equal(failed.response.id, "resp_partial");assert.equal(failed.response.created_at, 1700000000);
  assert.equal(failed.response.model, "fixture-model");assert.equal(failed.response.status, "failed");
  assert.equal(failed.response.error.code, "upstream_stream_incomplete");
  assert.match(failed.response.error.message, /upstream_stream_incomplete/);
});

test("an upstream error before response.created still produces a complete failed response", async () => {
  let cancelled = false;
  const source = new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('data: {"error":{"code":"overloaded","message":"synthetic overload"}}\n\n')); },
    cancel() { cancelled = true; },
  });
  const result = await invokeAdapter({ responsesFn: async () => new Response(source, { headers: { "Content-Type": "text/event-stream" } }) },
    { body: { model: "gpt-5.6-sol", stream: true, input: "synthetic" } });
  const failed = result.text.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))).at(-1);
  assert.equal(cancelled, true);assert.match(failed.response.id, /^resp_ccdx_/);
  assert.equal(failed.type, "response.failed");assert.equal(failed.sequence_number, 0);
  assert.equal(failed.response.model, "gpt-5.6-sol");assert.equal(failed.response.status, "failed");
  assert.ok(Number.isSafeInteger(failed.response.created_at));assert.equal(failed.response.error.message, "synthetic overload");
});

test("native Responses preserves LF, CRLF and CR frames across arbitrary chunks", async () => {
  const delta = { type: "response.output_text.delta", delta: "hello 你好", output_index: 0 };
  const done = { type: "response.completed", response: { id: "resp_line_endings", status: "completed", output: [] } };
  for (const ending of ["\n", "\r\n", "\r"]) {
    const body = [delta, done].map(event => `event: ${event.type}${ending}id: opaque${ending}: note${ending}data: ${JSON.stringify(event)}${ending}${ending}`).join("");
    const bytes = Buffer.from(body);
    for (const size of [1, 7, bytes.length]) {
      const source = () => new Response(new ReadableStream({ start(controller) {
        for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.subarray(at, at + size));
        controller.close();
      } }), { headers: { "Content-Type": "text/event-stream" } });
      const result = await invokeAdapter({ responsesFn: async () => source(), getCachedModelEndpointsFn: () => ["/responses"] },
        { body: { model: "gpt-5.6-sol", stream: true, input: "synthetic" } });
      assert.equal(result.status, 200);
      assert.equal(result.text, body, `${JSON.stringify(ending)} split into ${size}-byte chunks`);
    }
  }
});

test("native Responses recognizes mixed line endings without changing frame bytes", async () => {
  const delta = { type: "response.output_text.delta", delta: "mixed", output_index: 0 };
  const done = { type: "response.completed", response: { id: "resp_mixed", status: "completed", output: [] } };
  const body = `event: ${delta.type}\rdata: ${JSON.stringify(delta)}\r\r\n` + `event: ${done.type}\ndata: ${JSON.stringify(done)}\n\r`;
  const bytes = Buffer.from(body);
  const source = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));controller.close(); } }),
    { headers: { "Content-Type": "text/event-stream" } });
  const result = await invokeAdapter({ responsesFn: async () => source, getCachedModelEndpointsFn: () => ["/responses"] },
    { body: { model: "gpt-5.6-sol", stream: true, input: "synthetic" } });
  assert.equal(result.status, 200);assert.equal(result.text, body);
});

test("a CR-only Responses terminal completes without waiting for upstream socket EOF", async () => {
  let cancelled = false;
  const done = { type: "response.completed", response: { id: "resp_open_cr", status: "completed", output: [] } };
  const body = `event: ${done.type}\rdata: ${JSON.stringify(done)}\r\r`;
  const source = new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(body)); }, cancel() { cancelled = true; } }),
    { headers: { "Content-Type": "text/event-stream" } });
  const result = await invokeAdapter({ responsesFn: async () => source, getCachedModelEndpointsFn: () => ["/responses"] },
    { body: { model: "gpt-5.6-sol", stream: true, input: "synthetic" } });
  assert.equal(result.text, body);assert.equal(cancelled, true);
});

test("Chat fallback accepts CR-only streamed events", async () => {
  const source = `data: ${JSON.stringify({ choices: [{ delta: { content: "synthetic" }, finish_reason: null }] })}\r\r`
    + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\r\rdata: [DONE]\r\r`;
  const result = await invokeAdapter({ chatCompletionsFn: async () => sseResponse(source) },
    { body: { model: "gpt-4o", stream: true, input: "synthetic" } });
  assert.equal(result.status, 200);assert.match(result.text, /response\.output_text\.delta/);assert.match(result.text, /response\.completed/);
});

test("stream preflight rejects non-SSE 2xx bodies for native Responses and Chat fallback without leaking them", async () => {
  const secret = "must-not-leak-upstream-body";
  const cases = [
    {
      options: { responsesFn: async () => new Response(secret, { status: 200, headers: { "Content-Type": "application/json" } }) },
      request: { body: { model: "gpt-5.6-sol", stream: true, input: "hello" } },
    },
    {
      options: { chatCompletionsFn: async () => new Response(secret, { status: 200, headers: { "Content-Type": "text/plain" } }) },
      request: { body: { model: "gpt-4o", stream: true, input: "hello" } },
    },
  ];

  for (const { options, request } of cases) {
    const result = await invokeAdapter(options, request);
    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.text).error.code, "upstream_stream_content_type_invalid");
    assert.doesNotMatch(result.text, new RegExp(secret));
    assert.doesNotMatch(result.text, /response\.created/);
  }
});

test("stream preflight rejects a successful response without a body", async () => {
  const result = await invokeAdapter({
    responsesFn: async () => new Response(null, { status: 204, headers: { "Content-Type": "text/event-stream" } }),
  }, {
    body: { model: "gpt-5.6-sol", stream: true, input: "hello" },
  });

  assert.equal(result.status, 502);
  assert.equal(JSON.parse(result.text).error.code, "upstream_stream_body_missing");
});

test("unexpected EOF is a protocol-native error on Responses and Chat streams", async () => {
  clearResponseHistoryForTests();
  const cases = [
    {
      options: { responsesFn: async () => sseResponse('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n') },
      request: { body: { model: "gpt-5.6-sol", stream: true, input: "hello" } },
      forbidden: /event: response\.completed/,
    },
    {
      options: { chatCompletionsFn: async () => sseResponse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n') },
      request: { body: { model: "gpt-4o", stream: true, input: "hello" } },
      forbidden: /event: response\.completed/,
    },
  ];

  for (const { options, request, forbidden } of cases) {
    const result = await invokeAdapter(options, request);
    assert.equal(result.status, 200);
    assert.match(result.text, /event: response\.failed/);
    assert.match(result.text, /upstream_stream_incomplete/);
    assert.doesNotMatch(result.text, forbidden);
    const events = result.text.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
    const failed = events.at(-1), created = events.find(event => event.response?.status === "in_progress");
    assert.equal(failed.type, "response.failed");assert.equal(failed.response.status, "failed");
    assert.equal(failed.response.error.code, "upstream_stream_incomplete");assert.ok(Number.isSafeInteger(failed.response.created_at));
    if (created) assert.equal(failed.response.id, created.response.id);
  }
  assert.equal(responseHistoryStats().entries, 0);
  clearResponseHistoryForTests();
});

test("embedded Chat SSE errors cannot be converted into successful Responses terminal events", async () => {
  const stream = [
    `data: ${JSON.stringify({ error: { type: "server_error", message: "upstream failed" } })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  const cases = [
    {
      options: { chatCompletionsFn: async () => sseResponse(stream) },
      request: { body: { model: "gpt-4o", stream: true, input: "hello" } },
      forbidden: /response\.completed/,
    },
  ];

  for (const { options, request, forbidden } of cases) {
    const result = await invokeAdapter(options, request);
    assert.equal(result.status, 200);
    assert.match(result.text, /upstream_chat_stream_error/);
    assert.doesNotMatch(result.text, forbidden);
  }
});

test("malformed Chat SSE JSON fails closed on Responses conversion", async () => {
  const stream = "data: {not-json}\n\ndata: [DONE]\n\n";
  const cases = [
    {
      options: { chatCompletionsFn: async () => sseResponse(stream) },
      request: { body: { model: "gpt-4o", stream: true, input: "hello" } },
      forbidden: /response\.completed/,
    },
  ];

  for (const { options, request, forbidden } of cases) {
    const result = await invokeAdapter(options, request);
    assert.equal(result.status, 200);
    assert.match(result.text, /upstream_stream_json_invalid/);
    assert.doesNotMatch(result.text, forbidden);
  }
});

test("unexpected EOF does not persist partial stream usage", async () => {
  const usagePath = path.join(os.tmpdir(), `ccdx-incomplete-stream-${process.pid}-${Date.now()}.jsonl`);
  const previousPath = process.env.CCDX_USAGE_PATH;
  const previousDisabled = process.env.CCDX_DISABLE_USAGE;
  process.env.CCDX_USAGE_PATH = usagePath;
  delete process.env.CCDX_DISABLE_USAGE;
  try {
    const partial = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}',
      "",
    ].join("\n\n");
    const cases = [
      {
        options: { chatCompletionsFn: async () => sseResponse(partial) },
        request: { body: { model: "gpt-4o", stream: true, input: "hello" } },
      },
    ];
    for (const { options, request } of cases) await invokeAdapter(options, request);
    await flushUsageWritesForTests();
    assert.deepEqual(await readUsageRecords(usagePath), []);
  } finally {
    if (previousPath === undefined) delete process.env.CCDX_USAGE_PATH;
    else process.env.CCDX_USAGE_PATH = previousPath;
    if (previousDisabled === undefined) delete process.env.CCDX_DISABLE_USAGE;
    else process.env.CCDX_DISABLE_USAGE = previousDisabled;
    await rm(usagePath, { force: true });
  }
});

test("a valid response.completed terminal stores history and closes the upstream stream", async () => {
  clearResponseHistoryForTests();
  const completed = {
    type: "response.completed",
    response: {
      id: "resp_stream_terminal",
      object: "response",
      status: "completed",
      output: [{
        type: "message",
        id: "msg_stream_terminal",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "done" }],
      }],
    },
  };
  let cancelled = false;
  const trailing = Array.from({ length: 21 }, () => (
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta: "\n",
    })}\n\n`
  )).join("");
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n${trailing}`));
    },
    cancel() { cancelled = true; },
  });
  const result = await invokeAdapter({
    responsesFn: async () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  }, {
    body: { model: "gpt-5.6-sol", stream: true, input: "hello" },
  });

  assert.equal(result.status, 200);
  assert.doesNotMatch(result.text, /event: error/);
  assert.equal(cancelled, true);
  assert.equal(responseHistoryStats().entries, 1);
  assert.deepEqual(
    prepareResponsesRequest({
      model: "gpt-5.6-sol",
      previous_response_id: "resp_stream_terminal",
      input: "next",
    }).body.input.map((item) => item.content?.[0]?.text),
    ["hello", "done", "next"],
  );
  clearResponseHistoryForTests();
});

test("native Responses rejects malformed terminals and premature DONE immediately", async () => {
  const cases = [
    {
      data: "data: [DONE]\n\n",
      code: "upstream_stream_terminal_missing",
    },
    {
      data: `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { status: "completed", output: [] },
      })}\n\n`,
      code: "upstream_stream_terminal_invalid",
    },
    {
      data: "event: response.output_text.delta\ndata: {not-json}\n\n",
      code: "upstream_stream_json_invalid",
    },
  ];

  for (const { data, code } of cases) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(data)); },
      cancel() { cancelled = true; },
    });
    const result = await invokeAdapter({
      responsesFn: async () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    }, {
      body: { model: "gpt-5.6-sol", stream: true, input: "hello" },
    });

    assert.equal(result.status, 200);
    assert.match(result.text, new RegExp(code));
    assert.equal(cancelled, true);
  }
});

test("native Responses accepts incomplete, failed, and error terminals without inventing EOF errors", async () => {
  clearResponseHistoryForTests();
  const terminals = [
    {
      type: "response.incomplete",
      response: { id: "resp_incomplete_terminal", status: "incomplete", output: [] },
    },
    {
      type: "response.failed",
      response: { id: "resp_failed_terminal", status: "failed", output: [], error: { code: "server_error", message: "failed" } },
    },
    { type: "error", code: "server_error", message: "failed" },
  ];

  for (const terminal of terminals) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: ${terminal.type}\ndata: ${JSON.stringify(terminal)}\n\n`));
      },
      cancel() { cancelled = true; },
    });
    const result = await invokeAdapter({
      responsesFn: async () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    }, {
      body: { model: "gpt-5.6-sol", stream: true, input: "hello" },
    });

    assert.equal(result.status, 200);
    const expected = terminal.type === "error" ? "response.failed" : terminal.type;
    assert.match(result.text, new RegExp(`event: ${expected.replaceAll(".", "\\.")}`));
    assert.doesNotMatch(result.text, /upstream_stream_incomplete/);
    assert.equal(cancelled, true);
  }
  assert.equal(responseHistoryStats().entries, 0);
  clearResponseHistoryForTests();
});

test("tool argument guard counts line-break and tab characters independently per call", () => {
  const guard = new ToolArgumentDeltaGuard();
  for (let i = 0; i < 20; i += 1) {
    guard.observe(0, "\n");
    guard.observe(1, "\t");
  }
  guard.observe(0, "   {");
  guard.observe(1, "   ");
  for (let i = 0; i < 20; i += 1) guard.observe(0, "\r");
  assert.throws(() => guard.observe(1, "\n"), (error) => error.code === "upstream_tool_arguments_stalled");
  guard.observe(0, "}");
  assert.doesNotThrow(() => guard.observe(0, "\n"));
});

test("blank tool argument fuse cancels the stream and emits a protocol-native error", async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 21; i += 1) {
        const event = { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\n" } }] } }] };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
    },
    cancel() { cancelled = true; },
  });
  const result = await invokeAdapter({
    chatCompletionsFn: async () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  }, {
    body: { model: "gpt-4o", stream: true, input: "hello" },
  });

  assert.equal(result.status, 200);
  assert.match(result.text, /upstream_tool_arguments_stalled/);
  assert.doesNotMatch(result.text, /response\.completed/);
  assert.equal(cancelled, true);
});

test("blank ordinary text deltas do not activate the tool argument fuse", async () => {
  const chunks = Array.from({ length: 25 }, () => 'data: {"choices":[{"delta":{"content":" "}}]}\n\n').join("");
  const result = await invokeAdapter({
    chatCompletionsFn: async () => sseResponse(`${chunks}data: [DONE]\n\n`),
  }, {
    body: { model: "gpt-4o", stream: true, input: "hello" },
  });

  assert.equal(result.status, 200);
  assert.match(result.text, /response\.completed/);
  assert.doesNotMatch(result.text, /upstream_tool_arguments_stalled/);
});

test("native Responses function and custom tool inputs use the same blank-delta fuse", async () => {
  const responseEvent = (type) => `event: ${type}\ndata: ${JSON.stringify({ type, output_index: 0, delta: "\n" })}\n\n`;
  const responseEvents = Array.from({ length: 21 }, () => responseEvent("response.function_call_arguments.delta")).join("");
  const customEvents = Array.from({ length: 21 }, () => responseEvent("response.custom_tool_call_input.delta")).join("");
  const cases = [
    {
      options: { responsesFn: async () => sseResponse(responseEvents) },
      request: { body: { model: "gpt-5.6-sol", stream: true, input: "hello" } },
    },
    {
      options: { responsesFn: async () => sseResponse(customEvents) },
      request: { body: { model: "gpt-5.6-sol", stream: true, input: "hello" } },
    },
  ];

  for (const { options, request } of cases) {
    const result = await invokeAdapter(options, request);
    assert.equal(result.status, 200);
    assert.match(result.text, /event: response\.failed/);
    assert.match(result.text, /upstream_tool_arguments_stalled/);
    assert.doesNotMatch(result.text, /response\.completed/);
  }
});
