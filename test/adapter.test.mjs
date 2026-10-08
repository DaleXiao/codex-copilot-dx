import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createCopilotClient } from "../src/copilot.mjs";
import { createAdapterHandler, requestPath } from "../src/adapter.mjs";
import {
  clearResponseHistoryForTests,
  configureResponseHistoryForTests,
  responseHistoryStats,
} from "../src/response-history.mjs";
import { prepareResponsesRequest, rememberResponseHistory } from "../src/responses-request.mjs";
import { createStreamPerformanceMetrics } from "../src/stream-performance.mjs";
import { invokeAdapterRequest, invokeAdapter } from "../test-support/adapter.mjs";

function jsonRequest(body, contentEncoding, headers = {}) {
  const req = Readable.from([body]);
  req.headers = { ...headers };
  if (contentEncoding) req.headers["content-encoding"] = contentEncoding;
  return req;
}

test("preparation metrics cover native, Chat fallback, and compact without altering payloads", async () => {
  const previousUsageDisabled = process.env.CCDX_DISABLE_USAGE;
  process.env.CCDX_DISABLE_USAGE = "1";
  try {
    for (const mode of ["native", "chat", "compact"]) {
      const metrics = createStreamPerformanceMetrics();
      const client = createCopilotClient({
        profile: "timing-test",
        allowTokenDiscovery: false,
        readGithubCredentials: async () => ({ token: "test-token", identity: { login: "test", id: 1 } }),
        tokenFetchImpl: async () => Response.json({ token: "test-service", expires_at: Date.now() / 1000 + 1800 }),
      });
      let sent;
      const fetchImpl = async (_url, options) => {
        sent = JSON.parse(options.body);
        return Response.json(mode === "chat"
          ? { id: "chat_timing", choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }
          : { id: `resp_timing_${mode}`, status: "completed", output: mode === "compact"
            ? [{ type: "compaction", id: "cmp_timing", encrypted_content: "opaque-test" }]
            : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }] });
      };
      const responses = (body, options) => client.responses(body, {
        ...options, fetchImpl, payloadOptions: { optimizeImage: async (url) => url },
      });
      const response = await invokeAdapter({
        streamPerformanceMetrics: metrics,
        responsesFn: responses,
        responsesCompactFn: responses,
        chatCompletionsFn: (body, options) => client.chatCompletions(body, { ...options, fetchImpl }),
      }, {
        url: mode === "compact" ? "/v1/responses/compact" : "/v1/responses",
        body: { model: mode === "chat" ? "gpt-4o" : "gpt-5.6-sol", input: "preserve this input", stream: false },
      });
      assert.equal(response.status, 200, response.text);
      assert.equal(sent.stream, false);
      assert.ok(JSON.stringify(sent).includes("preserve this input"));
      const route = metrics.snapshot().by_route[mode === "compact" ? "responses_compact" : "responses"];
      assert.equal(route.preparation_ms.admission.samples, 1);
      assert.equal(route.preparation_ms.body.samples, 1);
      assert.ok(route.preparation_ms.history.samples >= 1);
      assert.ok(route.preparation_ms.serialization.samples >= 1);
      assert.equal(route.request_ttft_ms.samples, 0);
      assert.equal(route.ttft_ms.samples, 0);
      const timeline = metrics.snapshot().recent_requests[0];
      assert.equal(timeline.request_id, response.headers["X-Request-Id"]);
      assert.equal(timeline.http_status, 200);
      assert.equal(timeline.outcome, "completed");
      assert.equal(timeline.upstream_attempts, 1);
      assert.ok(timeline.timings_ms.upstream_headers !== null);
      assert.equal(timeline.timings_ms.first_output, null);
      assert.doesNotMatch(JSON.stringify(timeline), /preserve this input|test-service|test-token/);
    }
  } finally {
    clearResponseHistoryForTests();
    if (previousUsageDisabled === undefined) delete process.env.CCDX_DISABLE_USAGE;
    else process.env.CCDX_DISABLE_USAGE = previousUsageDisabled;
  }
});

test("loopback cache control reports, resizes, and explicitly clears runtime history", async () => {
  clearResponseHistoryForTests();
  try {
    const context = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "cache fixture" });
    rememberResponseHistory(context, { id: "resp_cache_control", output: [], status: "completed" });
    const before = await invokeAdapter({}, { method: "GET", url: "/_ccdx/cache" });
    assert.equal(before.status, 200);
    assert.equal(JSON.parse(before.text).response_history.entries, 1);

    const resized = await invokeAdapter({}, {
      url: "/_ccdx/cache", body: { action: "set_limit", max_bytes: 128 * 1024 * 1024 },
    });
    assert.equal(resized.status, 200, resized.text);
    assert.equal(JSON.parse(resized.text).response_history.maxBytes, 128 * 1024 * 1024);

    const defaultClean = await invokeAdapter({}, {
      url: "/_ccdx/cache", body: { action: "clean", history: false },
    });
    assert.equal(defaultClean.status, 200);
    assert.equal(responseHistoryStats().entries, 1);

    const historyClean = await invokeAdapter({}, {
      url: "/_ccdx/cache", body: { action: "clean", history: true },
    });
    assert.equal(historyClean.status, 200);
    assert.equal(JSON.parse(historyClean.text).cleaned.response_history.entries, 1);
    assert.equal(responseHistoryStats().entries, 0);
  } finally { clearResponseHistoryForTests(); }
});

test("cache control rejects browser and non-loopback mutation before reading a body", async () => {
  for (const [remoteAddress, headers] of [
    ["192.168.1.5", { "content-type": "application/json" }],
    ["127.0.0.1", { "content-type": "application/json", origin: "https://untrusted.example" }],
  ]) {
    const req = jsonRequest(Buffer.from(JSON.stringify({ action: "clean", history: true })), undefined, headers);
    req.method = "POST";
    req.url = "/_ccdx/cache";
    req.socket = { remoteAddress };
    const response = await invokeAdapterRequest({}, req);
    assert.equal(response.status, 403);
  }
});

test("requestPath: ignores query strings on API routes", () => {
  assert.equal(requestPath("/v1/responses?stream=true"), "/v1/responses");
  assert.equal(requestPath("/v1/responses/compact?stream=true"), "/v1/responses/compact");
  assert.equal(requestPath("/v1/models?foo=bar"), "/v1/models");
});

test("createAdapterHandler rejects a malformed request target without throwing", async () => {
  const response = await invokeAdapter({}, { method: "GET", url: "http://[" });

  assert.equal(response.status, 400);
  assert.equal(response.headers.Connection, "close");
  assert.deepEqual(JSON.parse(response.text), { error: "Invalid request target" });
});

test("createAdapterHandler: tracks terminal activity for one request lifecycle", () => {
  let started = 0;
  let finished = 0;
  const terminalActivity = {
    beginRequest() {
      started += 1;
      return () => { finished += 1; };
    },
  };
  const req = Readable.from([]);
  req.method = "GET";
  req.url = "/missing";
  req.headers = {};

  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.writeHead = (statusCode) => { res.statusCode = statusCode; };
  res.end = () => {
    res.writableEnded = true;
    res.writableFinished = true;
    res.emit("finish");
    res.emit("close");
  };

  createAdapterHandler({ terminalActivity })(req, res);
  assert.equal(started, 1);
  assert.equal(finished, 1);
});

test("createAdapterHandler contains unexpected synchronous and asynchronous dispatch failures", async () => {
  for (const dispatchRequestForTests of [
    () => { throw new Error("secret synchronous detail"); },
    async () => { throw new Error("secret asynchronous detail"); },
  ]) {
    const response = await invokeAdapter({ dispatchRequestForTests }, { body: { input: "hello" } });
    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(response.text), {
      error: {
        message: "Internal adapter error",
        type: "server_error",
        code: "ccdx_internal_error",
      },
    });
    assert.equal(response.text.includes("secret"), false);
  }
});

test("createAdapterHandler contains non-Error rejection and metric completion failures", async () => {
  for (const rejection of [null, "secret rejection value"]) {
    const response = await invokeAdapter({
      dispatchRequestForTests: () => Promise.reject(rejection),
      requestMetrics: {
        begin() { return () => { throw new Error("metrics failure"); }; },
      },
    }, { body: { input: "hello" } });
    assert.equal(response.status, 500);
    assert.equal(JSON.parse(response.text).error.code, "ccdx_internal_error");
    assert.equal(response.text.includes("secret"), false);
  }
});

test("HTTP retired Claude routes return 410 without reading the body or contacting upstream", async () => {
  const upstreamCalls = [];
  const unexpectedCall = (name) => () => {
    upstreamCalls.push(name);
    throw new Error(`${name} should not be called`);
  };
  const options = {
    acquireRequest: unexpectedCall("request admission"),
    chatCompletionsFn: unexpectedCall("Chat Completions"),
    responsesFn: unexpectedCall("Responses"),
    responsesCompactFn: unexpectedCall("Responses compact"),
    listModelsFn: unexpectedCall("models"),
  };

  for (const url of ["/v1/messages?beta=true", "/v1/messages/count_tokens?beta=true"]) {
    let bodyRead = false;
    const req = new Readable({
      read() {
        bodyRead = true;
        this.push(Buffer.from("{not valid json"));
        this.push(null);
      },
    });
    req.method = "POST";
    req.url = url;
    req.headers = { "content-type": "application/json" };
    req.socket = { remoteAddress: "127.0.0.1" };

    const result = await invokeAdapterRequest(options, req);
    assert.equal(result.status, 410);
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.equal(JSON.parse(result.text).error.code, "ccdx_claude_retired");
    assert.equal(bodyRead, false);
  }
  assert.deepEqual(upstreamCalls, []);
});

test("HTTP PM Studio namespace is not mounted", async () => {
  for (const [method, url] of [
    ["GET", "/pm-ccdx/models"],
    ["POST", "/pm-ccdx/chat/completions"],
    ["POST", "/pm-ccdx/responses"],
    ["POST", "/pm-ccdx/embeddings"],
  ]) {
    const result = await invokeAdapter({}, { method, url, body: { model: "gpt-5.6-sol" } });
    assert.equal(result.status, 404);
    assert.deepEqual(JSON.parse(result.text), { error: "Not found" });
  }
});

test("response history tree LRU preserves active image history for compaction", async () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 1_000_000, maxEntries: 4 });
  const imageUrl = "data:image/png;base64,aW1hZ2U=";

  const activeRoot = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: imageUrl }],
    }],
  });
  rememberResponseHistory(activeRoot, { id: "resp_active_root", output: [] });
  rememberResponseHistory(
    prepareResponsesRequest({ model: "gpt-5.6-sol", input: "idle" }),
    { id: "resp_idle", output: [] },
  );
  const activeChild = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    previous_response_id: "resp_active_root",
    input: "continue",
  });
  rememberResponseHistory(activeChild, { id: "resp_active_child", output: [] });
  rememberResponseHistory(
    prepareResponsesRequest({ model: "gpt-5.6-sol", input: "newer-a" }),
    { id: "resp_newer_a", output: [] },
  );
  rememberResponseHistory(
    prepareResponsesRequest({ model: "gpt-5.6-sol", input: "newer-b" }),
    { id: "resp_newer_b", output: [] },
  );

  let compactBody;
  const result = await invokeAdapter({
    responsesCompactFn: async (body) => {
      compactBody = body;
      return new Response(JSON.stringify({
        id: "resp_compacted",
        status: "completed",
        output: [{ type: "compaction", id: "cmp_image", encrypted_content: "image-state" }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  }, {
    url: "/v1/responses/compact",
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_active_child",
      input: "compact",
    },
  });

  assert.equal(result.status, 200);
  assert.equal(compactBody.input[0].content[0].image_url, imageUrl);
  assert.deepEqual(compactBody.input.at(-1), { type: "compaction_trigger" });
  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.6-sol", previous_response_id: "resp_idle", input: "next" }),
    /was evicted after reaching the local history limit/,
  );
  clearResponseHistoryForTests();
});

test("HTTP Codex routes preserve Responses fallback, compact, and model discovery", async () => {
  const calls = [];
  const codexClient = {
    getCachedModelEndpoints(model) {
      return model === "gpt-native" ? ["/responses"] : ["/chat/completions"];
    },
    async responses(body) {
      calls.push(["codex.responses", body.model]);
      return Response.json({ id: "resp_native", status: "completed", output: [] });
    },
    async responsesCompact(body) {
      calls.push(["codex.compact", body.model]);
      return Response.json({
        id: "resp_compact",
        status: "completed",
        output: [{ type: "compaction", encrypted_content: "snapshot" }],
      });
    },
    async chatCompletions(body) {
      calls.push(["codex.chat", body.model]);
      return Response.json({
        id: "chat_codex",
        model: body.model,
        choices: [{ message: { role: "assistant", content: "codex" } }],
      });
    },
    async listModels() {
      calls.push(["codex.models"]);
      return { status: 200, body: JSON.stringify({ data: [{ id: "gpt-native" }] }) };
    },
  };
  const options = {
    codexClient,
    codexModelRegistry: { models: { data: [{ id: "gpt-cached" }] } },
  };

  assert.equal((await invokeAdapter(options, {
    body: { model: "gpt-native", input: "native" },
  })).status, 200);
  assert.equal((await invokeAdapter(options, {
    body: { model: "gpt-chat", input: "fallback" },
  })).status, 200);
  assert.equal((await invokeAdapter(options, {
    url: "/v1/responses/compact",
    body: { model: "gpt-native", input: "compact" },
  })).status, 200);

  const codexModels = await invokeAdapter(options, { method: "GET", url: "/v1/models" });
  assert.deepEqual(JSON.parse(codexModels.text).data.map(({ id }) => id), ["gpt-native"]);

  assert.deepEqual(calls, [
    ["codex.responses", "gpt-native"],
    ["codex.chat", "gpt-chat"],
    ["codex.compact", "gpt-native"],
    ["codex.models"],
  ]);
});
