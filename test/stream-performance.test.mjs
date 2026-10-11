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
  responsesTimingSource,
  measureRequestStage,
  measureRequestStageAsync,
} from "../src/stream-performance.mjs";

test("request timings include preparation without changing upstream TTFT and TPOT", async () => {
  let time = 0;
  const metrics = createStreamPerformanceMetrics({ now: () => time });
  const sample = metrics.begin("responses");
  await runWithRequestContext({ streamPerformance: sample }, async () => {
    await measureRequestStageAsync("admission", async () => { time += 10; });
    await measureRequestStageAsync("body", async () => { time += 25; });
    assert.equal(measureRequestStage("history", () => { time += 5; return 42; }), 42);
    await measureRequestStageAsync("images", async () => { time += 35; });
    measureRequestStage("serialization", () => { time += 5; });
    time = 100;
    sample.upstreamStarted();
    time = 350;
    sample.firstOutput();
    time = 400;
    sample.firstOutput();
    sample.setOutputTokens(6);
    time = 450;
    sample.finish();
    sample.finish();
  });
  const route = metrics.snapshot().by_route.responses;
  assert.equal(route.request_ttft_ms.avg, 350);
  assert.equal(route.request_ttft_ms.samples, 1);
  assert.equal(route.ttft_ms.avg, 250);
  assert.equal(route.tpot_us.avg, 20_000);
  assert.deepEqual(Object.fromEntries(Object.entries(route.preparation_ms).map(([stage, data]) => [stage, [data.samples, data.avg]])), {
    admission: [1, 10], body: [1, 25], history: [1, 5], images: [1, 35], serialization: [1, 5],
  });
});

test("timing evidence includes hidden reasoning and tools without changing output commitment", () => {
  for (const type of ["reasoning", "function_call", "custom_tool_call", "web_search_call", "multi_agent_call"]) {
    const event = { type: "response.output_item.added", item: { type, content: [], summary: [] } };
    assert.equal(responsesTimingSource(event), "announcement");
    assert.equal(isResponsesOutputEvent(event), false);
  }
  assert.equal(responsesTimingSource({ type: "response.output_item.added", item: { type: "message", content: [] } }), null);
  for (const type of ["function_call_output", "additional_tools", "compaction"]) {
    assert.equal(responsesTimingSource({ type: "response.output_item.added", item: { type, input: "not model output" } }), null);
  }
  assert.equal(responsesTimingSource({ type: "response.content_part.done", part: { text: "complete text" } }), "snapshot");
  assert.equal(responsesTimingSource({ type: "response.completed", response: { output: [{ type: "message", content: [{ text: "snapshot" }] }] } }), "snapshot");
  assert.equal(responsesTimingSource({ type: "response.output_item.added", item: { type: "program_output" } }), "runtime");
  assert.equal(responsesTimingSource({ type: "response.output_item.added", item: { type: "function_call", caller: { type: "program" } } }), "runtime");
  assert.equal(responsesTimingSource({ type: "response.output_text.delta", delta: "visible" }), "delta");
});

test("timing source is counted once and remains scalar metadata with isolated samples", () => {
  let now = 0;
  const metrics = createStreamPerformanceMetrics({ now: () => now });
  const tracker = metrics.begin("responses");
  tracker.upstreamStarted();
  now = 20; tracker.firstOutput("announcement");
  now = 30; tracker.firstOutput("delta");
  tracker.setOutputTokens(3); now = 40; tracker.finish();
  const state = metrics.snapshot();
  assert.equal(state.by_route.responses.ttft_ms.avg, 20);
  assert.deepEqual(state.by_route.responses.first_output_sources, { delta: 0, announcement: 1, snapshot: 0, runtime: 0 });
  assert.equal(state.by_route.responses.tpot_us.samples, 1);
  assert.equal(state.by_route.responses.tpot_estimated, true);
  assert.equal(state.recent_requests[0].first_output_source, "announcement");
});

test("preparation timings retain original failures, count retries, and isolate concurrent request contexts", async () => {
  let time = 0;
  const metrics = createStreamPerformanceMetrics({ now: () => time });
  const first = metrics.begin("responses");
  const second = metrics.begin("responses_compact");
  const failure = new Error("preparation aborted");
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  const pending = runWithRequestContext({ streamPerformance: first }, () => measureRequestStageAsync("images", async () => {
    await gate;
    time += 7;
    throw failure;
  }));
  await runWithRequestContext({ streamPerformance: second }, async () => {
    assert.throws(() => measureRequestStage("serialization", () => { time += 3; throw failure; }), (error) => error === failure);
    assert.equal(await measureRequestStageAsync("images", async () => { time += 5; return "ready"; }), "ready");
  });
  resume();
  await assert.rejects(pending, (error) => error === failure);
  runWithRequestContext({ streamPerformance: first }, () => measureRequestStage("images", () => { time += 2; }));
  first.finish({ failed: true });
  second.finish();
  const routes = metrics.snapshot().by_route;
  assert.equal(routes.responses.preparation_ms.images.samples, 2);
  assert.equal(routes.responses.preparation_ms.images.avg, 8.5);
  assert.equal(routes.responses.preparation_ms.serialization.samples, 0);
  assert.equal(routes.responses_compact.preparation_ms.images.avg, 5);
  assert.equal(routes.responses_compact.preparation_ms.serialization.avg, 3);
  assert.equal(routes.responses.request_ttft_ms.samples, 0);
  assert.equal(measureRequestStage("history", () => 42), 42);
  assert.equal(await measureRequestStageAsync("body", async () => 43), 43);
});

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

test("stream performance separates model terminal outcomes from HTTP status", () => {
  const metrics = createStreamPerformanceMetrics({ now: () => 10 });
  const incomplete = metrics.begin("responses");
  incomplete.upstreamStarted();
  incomplete.firstOutput();
  incomplete.terminal("incomplete", { model: "gpt-5.6-sol", origin: "upstream_response", reason: "max_output_tokens" });
  incomplete.finish({ statusCode: 200 });

  const upstreamFailed = metrics.begin("responses");
  upstreamFailed.upstreamStarted();
  upstreamFailed.terminal("failed", { model: "gpt-6-astra", origin: "upstream_event" });
  upstreamFailed.finish({ statusCode: 200 });

  const cancelled = metrics.begin("responses");
  cancelled.upstreamStarted();
  cancelled.finish({ aborted: true });

  const invalid = metrics.begin("responses");
  invalid.setModel("gpt-4o");
  invalid.setErrorOrigin("client_validation");
  invalid.finish({ failed: true, statusCode: 400 });

  const route = metrics.snapshot().by_route.responses;
  assert.equal(route.errors_with_output, 1);
  assert.equal(route.success_with_output, 0);
  assert.deepEqual(route.terminal_outcomes.totals, {
    completed: 0, incomplete: 1, failed: 1, cancelled: 1, unknown: 1,
  });
  assert.equal(route.terminal_outcomes.by_model["gpt-5.6-sol"].incomplete, 1);
  assert.equal(route.terminal_outcomes.by_model["gpt-4o"].unknown, 1);
  assert.equal(route.terminal_outcomes.by_origin.upstream_response.incomplete, 1);
  assert.equal(route.terminal_outcomes.by_origin.upstream_event.failed, 1);
  assert.equal(route.terminal_outcomes.incomplete_reasons.max_output_tokens, 1);
  assert.equal(route.terminal_outcomes.by_origin.client_validation.unknown, 1);
  assert.equal(route.terminal_outcomes.by_origin.client_disconnect.cancelled, 1);
});

test("model outcome labels remain bounded for arbitrary request models", () => {
  const metrics = createStreamPerformanceMetrics();
  for (let index = 0; index < 40; index += 1) {
    const request = metrics.begin("responses");
    request.terminal("completed", { model: `gpt-fixture-${index}`, origin: "upstream_response" });
    request.finish();
  }
  const models = metrics.snapshot().by_route.responses.terminal_outcomes.by_model;
  assert.ok(Object.keys(models).length <= 33);
  assert.ok(models.other.completed > 0);
});

test("request timeline records stages, retry attempts and activity without changing TTFT", () => {
  let time = 0;
  const metrics = createStreamPerformanceMetrics({ now: () => time, wallNow: () => "2026-10-05T00:00:00Z" });
  const request = metrics.begin("responses", { requestId: "request-1", prompt: "private-prompt" });
  const admission = request.beginStage("admission");
  time = 5; admission(); admission();
  request.setModel("gpt-6-astra");
  time = 10; request.upstreamStarted();
  time = 20; request.upstreamHeaders();
  time = 30; request.upstreamActivity();
  time = 40; request.upstreamStarted();
  time = 45; request.upstreamHeaders();
  time = 50; request.firstOutput();
  time = 80; request.upstreamActivity();
  time = 90; request.terminal("completed", { origin: "upstream_response" });
  time = 95; request.finish({ statusCode: 200 }); request.finish();
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.by_route.responses.ttft_ms.avg, 40);
  assert.equal(snapshot.recent_requests.length, 1);
  assert.deepEqual(snapshot.recent_requests[0], {
    request_id: "request-1", at: "2026-10-05T00:00:00Z", route: "responses", model: "gpt-6-astra",
    outcome: "completed", origin: "upstream_response", phase: "upstream_stream", failed: false,
    http_status: 200, upstream_attempts: 2, first_output_source: "delta", timings_ms: { admission: 5, body: 0, history: 0,
      images: 0, serialization: 0, upstream_start: 10, upstream_headers: 45, first_output: 50,
      last_activity: 80, terminal: 90, finished: 95 },
    context: { payload_bytes: null, images: null, input_tokens: null, context_window_tokens: null },
  });
  snapshot.recent_requests[0].timings_ms.finished = 12345;
  assert.equal(metrics.snapshot().recent_requests[0].timings_ms.finished, 95);
  assert.doesNotMatch(JSON.stringify(metrics.snapshot()), /private-prompt/);
});

test("request context retains only bounded numeric observations and isolated snapshots", () => {
  const metrics = createStreamPerformanceMetrics();
  const tracker = metrics.begin("responses");
  tracker.observeContext({ payload_bytes: 2048, images: 2, input_tokens: 100, context_window_tokens: 1000,
    prompt: "private-prompt", image: "private-image", token: "secret" });
  tracker.observeContext({ payload_bytes: NaN, images: -1, input_tokens: null, context_window_tokens: 0 });
  tracker.finish({ statusCode: 200 });
  const first = metrics.snapshot();
  assert.deepEqual(first.recent_requests[0].context, { payload_bytes: 2048, images: 2, input_tokens: 100, context_window_tokens: 1000 });
  first.recent_requests[0].context.input_tokens = 999;
  assert.equal(metrics.snapshot().recent_requests[0].context.input_tokens, 100);
  assert.doesNotMatch(JSON.stringify(metrics.snapshot()), /private-prompt|private-image|secret/);
});

test("timeline bounds retention and covers JSON, validation, disconnect and partial stream failures", () => {
  const metrics = createStreamPerformanceMetrics({ now: () => 1 });
  assert.equal(metrics.begin("models"), null);
  const json = metrics.begin("responses", { requestId: "json" });
  json.upstreamStarted(false); json.upstreamHeaders();
  json.terminal("completed", { origin: "upstream_response" }); json.finish({ statusCode: 200 });
  assert.equal(metrics.snapshot().by_route.responses.ttft_ms.samples, 0);
  assert.equal(metrics.snapshot().recent_requests[0].upstream_attempts, 1);
  for (let index = 0; index < 25; index += 1) {
    const request = metrics.begin("responses", { requestId: `request-${index}` });
    request.beginStage("body")();
    request.setErrorOrigin("client_validation");
    request.finish({ statusCode: 400, failed: true });
  }
  const partial = metrics.begin("responses", { requestId: "partial" });
  partial.upstreamStarted(); partial.upstreamHeaders(); partial.firstOutput(); partial.upstreamActivity();
  partial.setErrorOrigin("transport"); partial.fail(); partial.finish({ statusCode: 200 });
  const cancelled = metrics.begin("responses_compact", { requestId: "cancelled" });
  cancelled.finish({ aborted: true });
  const recent = metrics.snapshot().recent_requests;
  assert.equal(recent.length, 20);
  assert.equal(recent[0].request_id, "request-7");
  assert.equal(recent.at(-2).outcome, "unknown");
  assert.equal(recent.at(-2).phase, "upstream_stream");
  assert.equal(recent.at(-2).origin, "transport");
  assert.equal(recent.at(-2).failed, true);
  assert.equal(recent.at(-1).outcome, "cancelled");
  assert.equal(recent.at(-1).origin, "client_disconnect");
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

test("native response.incomplete is not a successful stream despite HTTP 200 and partial output", async () => {
  const metrics = createStreamPerformanceMetrics();
  const tracker = metrics.begin("responses");
  const res = {
    destroyed: false, headersSent: false, writableEnded: false, statusCode: 200,
    writeHead(statusCode) { this.statusCode = statusCode; this.headersSent = true; },
    write() { return true; },
    end() { this.writableEnded = true; },
  };
  const events = [
    { type: "response.output_text.delta", output_index: 0, delta: "partial" },
    { type: "response.incomplete", response: { id: "resp_partial", status: "incomplete", model: "gpt-5.6-sol", incomplete_details: { reason: "max_output_tokens" }, output: [] } },
  ];
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const result = await runWithRequestContext({ streamPerformance: tracker }, async () => {
    tracker.upstreamStarted();
    const value = await proxyCopilotResponses({
      body: { model: "gpt-5.6-sol", stream: true, input: [] }, surface: "responses",
    }, {}, res, async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    tracker.finish({ statusCode: res.statusCode });
    return value;
  });
  const route = metrics.snapshot().by_route.responses;
  assert.equal(res.statusCode, 200);
  assert.deepEqual(result, { successful: false, compacted: false });
  assert.equal(route.errors_with_output, 1);
  assert.equal(route.success_with_output, 0);
  assert.equal(route.terminal_outcomes.totals.incomplete, 1);
  assert.equal(route.terminal_outcomes.by_model["gpt-5.6-sol"].incomplete, 1);
  assert.equal(route.terminal_outcomes.incomplete_reasons.max_output_tokens, 1);
});
