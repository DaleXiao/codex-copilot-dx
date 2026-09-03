import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { githubTokenPath } from "../src/auth.mjs";
import { chatCompletions, getCopilotToken, resetCopilotTokenForTests } from "../src/copilot.mjs";
import { forwardToChat } from "../src/responses-bridge.mjs";
import { proxyCopilotResponses } from "../src/responses-proxy.mjs";
import { runWithRequestContext } from "../src/request-context.mjs";
import {
  createStreamPerformanceMetrics,
  isChatOutputDelta,
  isResponsesOutputEvent,
} from "../src/stream-performance.mjs";

function trackerSpy() {
  const calls = { firstOutput: 0, outputTokens: [], upstreamStarted: 0 };
  return {
    calls,
    tracker: {
      fail() {},
      firstOutput() { calls.firstOutput += 1; },
      setOutputTokens(value) { calls.outputTokens.push(value); },
      upstreamStarted() { calls.upstreamStarted += 1; },
    },
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("stream performance records exact aggregate TTFT and TPOT without retaining samples", () => {
  let time = 100;
  const metrics = createStreamPerformanceMetrics({ now: () => time });
  const sample = metrics.begin("responses");
  sample.upstreamStarted();
  time = 350;
  sample.firstOutput();
  sample.setOutputTokens(6);
  time = 450;
  sample.finish();

  const route = metrics.snapshot().by_route.responses;
  assert.equal(route.success_with_output, 1);
  assert.equal(route.ttft_ms.samples, 1);
  assert.equal(route.ttft_ms.avg, 250);
  assert.equal(route.tpot_us.avg, 20_000);
  assert.equal(route.tpot_us.samples, 1);
  assert.deepEqual(route.ttft_ms.buckets.at(-1), { lower: 300_000, upper: null, count: 0 });
  assert.equal(route.tpot_us.buckets[0].upper, 500);
});

test("first-output classifiers include generated content and exclude envelope frames", () => {
  assert.equal(isResponsesOutputEvent({ type: "response.reasoning_summary_text.delta", delta: "thinking" }), true);
  assert.equal(isResponsesOutputEvent({ type: "response.output_item.added", delta: "not output" }), false);
  assert.equal(isResponsesOutputEvent({ delta: "refused" }, "response.refusal.delta"), true);
  assert.equal(isChatOutputDelta({ reasoning_content: "thinking" }), true);
  assert.equal(isChatOutputDelta({ refusal: "no" }), true);
  assert.equal(isChatOutputDelta({ tool_calls: [{}] }), true);
  assert.equal(isChatOutputDelta({ role: "assistant", content: "" }), false);
});

test("stream performance distinguishes neutral, zero-output, and partial-output failures", () => {
  let time = 0;
  const metrics = createStreamPerformanceMetrics({ now: () => time });

  metrics.begin("responses").finish();
  metrics.begin("responses").finish({ failed: true });
  const zero = metrics.begin("responses");
  zero.upstreamStarted();
  zero.finish({ failed: true });
  const partial = metrics.begin("responses");
  partial.upstreamStarted();
  time = 25;
  partial.firstOutput();
  partial.fail();
  partial.finish();

  const route = metrics.snapshot().by_route.responses;
  assert.equal(route.neutral, 2);
  assert.equal(route.zero_output_errors, 1);
  assert.equal(route.errors_with_output, 1);
  assert.equal(route.ttft_ms.samples, 1);
  assert.equal(route.tpot_us.samples, 0);
});

test("Copilot transport starts TTFT immediately before a streaming upstream request", async () => {
  resetCopilotTokenForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-stream-performance-"));
  const tokenPath = githubTokenPath(home);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, "ghu_test");
  const originalLog = console.log;
  console.log = () => {};
  try {
    await getCopilotToken({
      home,
      fetchImpl: async () => jsonResponse(200, {
        token: "copilot_test",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });
    const { calls, tracker } = trackerSpy();
    await runWithRequestContext({ streamPerformance: tracker }, () => chatCompletions({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }, {
      fetchImpl: async (_url, options) => {
        assert.equal(JSON.parse(options.body).stream_options.include_usage, true);
        return new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    }));
    assert.equal(calls.upstreamStarted, 1);
  } finally {
    console.log = originalLog;
    resetCopilotTokenForTests();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Chat fallback and native Responses streams record first output once and capture final output tokens", async () => {
  const chat = trackerSpy();
  const chatBody = [
    'data: {"choices":[{"delta":{"content":"a"}}]}',
    'data: {"choices":[{"delta":{"content":"b"}}]}',
    'data: {"choices":[],"usage":{"completion_tokens":4}}',
    "data: [DONE]",
    "",
  ].join("\n\n");
  await runWithRequestContext({ streamPerformance: chat.tracker }, () => forwardToChat(
    { model: "gpt-4o", messages: [], stream: true },
    async () => {},
    () => {},
    () => assert.fail("valid Chat stream should not fail"),
    { chatCompletionsFn: async () => new Response(chatBody, { headers: { "Content-Type": "text/event-stream" } }) },
  ));
  assert.equal(chat.calls.firstOutput, 1);
  assert.deepEqual(chat.calls.outputTokens, [4]);

  const native = trackerSpy();
  const nativeBody = [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"a"}',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"b"}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_metrics","status":"completed","output":[]},"usage":{"output_tokens":6}}',
    "",
  ].join("\n\n");
  const res = {
    destroyed: false,
    headersSent: false,
    writableEnded: false,
    writeHead() { this.headersSent = true; },
    write() { return true; },
    end() { this.writableEnded = true; },
  };
  await runWithRequestContext({ streamPerformance: native.tracker }, () => proxyCopilotResponses({
    body: { model: "gpt-5.6-sol", stream: true, input: [] },
    historyInputItems: [],
    inputItems: [],
    surface: "responses",
  }, {}, res, async () => new Response(nativeBody, {
    headers: { "Content-Type": "text/event-stream" },
  })));
  assert.equal(native.calls.firstOutput, 1);
  assert.deepEqual(native.calls.outputTokens, [6]);
});
