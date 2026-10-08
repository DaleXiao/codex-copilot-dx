import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { clearResponseHistoryForTests } from "../src/response-history.mjs";
import { prepareResponsesRequest, rememberResponseHistory } from "../src/responses-request.mjs";
import { createStreamPerformanceMetrics } from "../src/stream-performance.mjs";
import { invokeAdapter } from "../test-support/adapter.mjs";

async function assertChatBridgeRejectsOversizedCurrentInput(stream) {
  let upstreamCalls = 0;
  const response = await invokeAdapter({
    responsesPayloadOptions: { maxBytes: 128, profiles: [] },
    chatCompletionsFn: async () => {
      upstreamCalls += 1;
      return new Response("{}", { status: 200 });
    },
  }, {
    body: {
      model: "gpt-4o",
      stream,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(1000) }] }],
    },
  });

  const error = JSON.parse(response.text).error;
  assert.equal(response.status, 413);
  assert.match(response.headers["Content-Type"], /^application\/json/);
  assert.equal(error.code, "ccdx_request_body_too_large");
  assert.equal(error.limit_bytes, 128);
  assert.ok(error.actual_bytes > error.limit_bytes);
  assert.equal(upstreamCalls, 0);
}

function jsonRequest(body, contentEncoding, headers = {}) {
  const req = Readable.from([body]);
  req.headers = { ...headers };
  if (contentEncoding) req.headers["content-encoding"] = contentEncoding;
  return req;
}

test("HTTP Chat fallback rejects unsupported content before upstream dispatch", async () => {
  let upstreamCalls = 0;
  const streamPerformanceMetrics = createStreamPerformanceMetrics();
  const response = await invokeAdapter({
    streamPerformanceMetrics,
    chatCompletionsFn: async () => { upstreamCalls += 1; throw new Error("unexpected Chat request"); },
  }, {
    body: {
      model: "gpt-4o",
      input: [{ type: "message", role: "user", content: [{ type: "input_audio", input_audio: { data: "YQ==", format: "wav" } }] }],
    },
  });
  assert.equal(response.status, 400);
  assert.equal(JSON.parse(response.text).error.code, "ccdx_responses_chat_incompatible");
  assert.equal(upstreamCalls, 0);
  const outcomes = streamPerformanceMetrics.snapshot().by_route.responses.terminal_outcomes;
  assert.equal(outcomes.totals.unknown, 1);
  assert.equal(outcomes.by_origin.client_validation.unknown, 1);
  assert.equal(outcomes.by_model["gpt-4o"].unknown, 1);
});

test("HTTP non-stream Responses conversion preserves upstream error status", async () => {
  const streamPerformanceMetrics = createStreamPerformanceMetrics();
  const response = await invokeAdapter({
    streamPerformanceMetrics,
    chatCompletionsFn: async () => new Response(JSON.stringify({ error: { message: "denied" } }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }),
  }, {
    body: { model: "gpt-4o", input: "hello", stream: false },
  });

  assert.equal(response.status, 403);
  assert.deepEqual(JSON.parse(response.text), { error: { message: "denied" } });
  const outcomes = streamPerformanceMetrics.snapshot().by_route.responses.terminal_outcomes;
  assert.equal(outcomes.totals.unknown, 1);
  assert.equal(outcomes.by_origin.upstream_http.unknown, 1);
  assert.equal(outcomes.by_model["gpt-4o"].unknown, 1);
});

test("HTTP non-stream Responses conversion returns text, tools, and usage", async () => {
  let upstreamBody;
  const previousDisableUsage = process.env.CCDX_DISABLE_USAGE;
  process.env.CCDX_DISABLE_USAGE = "1";
  let response;
  try {
    response = await invokeAdapter({
      chatCompletionsFn: async (body) => {
        upstreamBody = body;
        return new Response(JSON.stringify({
          id: "chatcmpl_ok",
          model: "gpt-4o",
          choices: [{
            message: {
              role: "assistant",
              content: "done",
              tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }],
            },
          }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    }, {
      body: { model: "gpt-4o", input: "hello", stream: false },
    });
  } finally {
    if (previousDisableUsage === undefined) delete process.env.CCDX_DISABLE_USAGE;
    else process.env.CCDX_DISABLE_USAGE = previousDisableUsage;
  }

  const data = JSON.parse(response.text);
  assert.equal(response.status, 200);
  assert.equal(upstreamBody.stream, false);
  assert.deepEqual(data.output.map((item) => item.type), ["message", "function_call"]);
  assert.deepEqual(data.usage, { input_tokens: 11, output_tokens: 7, total_tokens: 18 });
});

test("HTTP non-stream Chat length finish reason returns incomplete without dropping partial text", async () => {
  const streamPerformanceMetrics = createStreamPerformanceMetrics();
  const response = await invokeAdapter({
    streamPerformanceMetrics,
    chatCompletionsFn: async () => Response.json({
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "partial" }, finish_reason: "length" }],
    }),
  }, { body: { model: "gpt-4o", input: "continue", stream: false } });
  const data = JSON.parse(response.text);
  assert.equal(response.status, 200);
  assert.equal(data.status, "incomplete");
  assert.deepEqual(data.incomplete_details, { reason: "max_output_tokens" });
  assert.equal(data.output[0].content[0].text, "partial");
  assert.equal(data.output[0].status, "incomplete");
  const outcomes = streamPerformanceMetrics.snapshot().by_route.responses.terminal_outcomes;
  assert.equal(outcomes.totals.incomplete, 1);
  assert.equal(outcomes.by_model["gpt-4o"].incomplete, 1);
});

test("HTTP Responses chat bridge applies q82, q75, and q65 before forwarding", async () => {
  const original = `data:image/png;base64,${Buffer.alloc(3000, 7).toString("base64")}`;
  const qualities = [];
  let upstreamBody;
  const response = await invokeAdapter({
    responsesPayloadOptions: {
      maxBytes: 1000,
      profiles: [
        { maxDim: 1600, quality: 75 },
        { maxDim: 1280, quality: 65 },
      ],
      optimizeImage: async (dataUrl, options) => {
        qualities.push(options.quality);
        const raw = Buffer.from(dataUrl.split(",", 2)[1], "base64");
        const ratio = options.quality === 82 ? 0.8 : options.quality === 75 ? 0.6 : 0.1;
        return `data:image/webp;base64,${Buffer.alloc(Math.floor(raw.length * ratio), 8).toString("base64")}`;
      },
    },
    chatCompletionsFn: async (body, { bodyText }) => {
      upstreamBody = body;
      assert.equal(bodyText, JSON.stringify(body));
      return new Response(JSON.stringify({
        id: "chatcmpl_budget_ok",
        model: "gpt-4o",
        choices: [{ message: { role: "assistant", content: "done" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  }, {
    body: {
      model: "gpt-4o",
      stream: false,
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: original }],
      }],
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(qualities, [82, 75, 65]);
  assert.ok(Buffer.byteLength(JSON.stringify(upstreamBody)) <= 1000);
  assert.match(upstreamBody.messages[0].content[0].image_url.url, /^data:image\/webp;base64,/);
});

test("HTTP streaming Responses chat bridge reuses the exact prepared body text", async () => {
  let upstreamCalls = 0;
  const response = await invokeAdapter({
    chatCompletionsFn: async (body, { bodyText }) => {
      upstreamCalls += 1;
      assert.equal(body.stream, true);
      assert.equal(body.stream_options.include_usage, true);
      assert.equal(bodyText, JSON.stringify(body));
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  }, {
    body: { model: "gpt-4o", stream: true, input: "hello stream" },
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamCalls, 1);
  assert.match(response.text, /response\.completed/);
});

test("HTTP Responses chat bridge trims historical tool output before forwarding", async () => {
  clearResponseHistoryForTests();
  const history = prepareResponsesRequest({
    model: "gpt-4o",
    input: [
      { type: "function_call", call_id: "call_large", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_large", output: "x".repeat(4000) },
    ],
  });
  rememberResponseHistory(history, { id: "resp_chat_budget_history", status: "completed", output: [] });

  let upstreamBody;
  const response = await invokeAdapter({
    responsesPayloadOptions: { maxBytes: 700, profiles: [] },
    chatCompletionsFn: async (body) => {
      upstreamBody = body;
      return new Response(JSON.stringify({
        id: "chatcmpl_trimmed_history",
        model: "gpt-4o",
        choices: [{ message: { role: "assistant", content: "done" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  }, {
    body: {
      model: "gpt-4o",
      stream: false,
      previous_response_id: "resp_chat_budget_history",
      input: "continue",
    },
  });

  assert.equal(response.status, 200);
  assert.ok(Buffer.byteLength(JSON.stringify(upstreamBody)) <= 700);
  assert.match(upstreamBody.messages.find((message) => message.role === "tool").content, /earlier tool output omitted/);
  clearResponseHistoryForTests();
});

test("HTTP Responses strips target-bound encrypted history before a streaming Chat route change", async () => {
  clearResponseHistoryForTests();
  try {
    const root = await invokeAdapter({
      responsesFn: async () => Response.json({
        id: "resp_http_affinity_root",
        status: "completed",
        output: [
          { type: "reasoning", id: "rs_http", encrypted_content: "http-cipher", summary: [] },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "visible history" }],
          },
        ],
      }),
    }, {
      body: { model: "gpt-5.6-sol", input: "start" },
    });
    assert.equal(root.status, 200);

    let chatRequest;
    const continuation = await invokeAdapter({
      chatCompletionsFn: async (body) => {
        chatRequest = structuredClone(body);
        return new Response([
          'data: {"model":"gpt-4o","choices":[{"delta":{"content":"continued"}}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"), { headers: { "Content-Type": "text/event-stream" } });
      },
    }, {
      body: {
        model: "gpt-4o",
        stream: true,
        previous_response_id: "resp_http_affinity_root",
        input: "continue",
      },
    });

    assert.equal(continuation.status, 200);
    assert.match(continuation.text, /response\.completed/);
    assert.equal(JSON.stringify(chatRequest).includes("encrypted_content"), false);
    assert.equal(JSON.stringify(chatRequest).includes("visible history"), true);
    assert.equal(JSON.stringify(chatRequest).includes("continue"), true);
  } finally {
    clearResponseHistoryForTests();
  }
});

test("HTTP non-stream Responses chat bridge rejects an irreducible oversized body locally", async () => {
  await assertChatBridgeRejectsOversizedCurrentInput(false);
});

test("HTTP streaming Responses chat bridge rejects an irreducible oversized body locally", async () => {
  await assertChatBridgeRejectsOversizedCurrentInput(true);
});
