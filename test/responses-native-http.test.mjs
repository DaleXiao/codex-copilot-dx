import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import path from "node:path";
import {
  createRequestAdmission,
  MAX_UPSTREAM_CHAT_SUCCESS_BODY_BYTES,
  MAX_UPSTREAM_RESPONSES_SUCCESS_BODY_BYTES,
} from "../src/http-transport.mjs";
import { clearResponseHistoryForTests, configureResponseHistoryForTests } from "../src/response-history.mjs";
import { prepareResponsesRequest, rememberResponseHistory } from "../src/responses-request.mjs";
import { createResponsesImagePressureController } from "../src/responses-image-pressure.mjs";
import { RUNTIME_DEFAULTS } from "../src/runtime-config.mjs";
import { createResponseFailureDiagnostics } from "../src/response-failures.mjs";
import { invokeAdapterRequest, invokeAdapter } from "../test-support/adapter.mjs";

function responsesSse(...events) {
  return new Response(events.map((event) => (
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  )).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "X-Request-Id": "upstream-stream-request" },
  });
}

function encryptedFailure(responseId = "resp_failed") {
  return {
    type: "response.failed",
    response: {
      id: responseId,
      object: "response",
      status: "failed",
      model: "gpt-5.6-sol",
      output: [],
      error: {
        code: "invalid_request_body",
        message: `The encrypted content ${"g".repeat(120)} could not be verified. Reason: Encrypted content could not be decrypted or parsed.`,
      },
    },
  };
}

function jsonRequest(body, contentEncoding, headers = {}) {
  const req = Readable.from([body]);
  req.headers = { ...headers };
  if (contentEncoding) req.headers["content-encoding"] = contentEncoding;
  return req;
}

test("HTTP 200 response.failed retries an exact encrypted continuation before downstream output", async () => {
  clearResponseHistoryForTests();
  try {
    const parent = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "remember this context" });
    rememberResponseHistory(parent, {
      id: "resp_parent_encrypted",
      status: "completed",
      output: [
        { type: "reasoning", id: "rs_stale", encrypted_content: "stale-encrypted-state", summary: [] },
        { type: "message", id: "msg_parent", role: "assistant", content: [{ type: "output_text", text: "parent answer" }] },
      ],
    });
    const failures = createResponseFailureDiagnostics({ now: () => "2026-09-14T00:00:00.000Z" });
    const bodies = [];
    const response = await invokeAdapter({
      responseFailures: failures,
      responsesFn: async (body) => {
        bodies.push(structuredClone(body));
        if (bodies.length === 1) {
          return responsesSse(
            { type: "response.created", response: { id: "resp_failed", object: "response", status: "in_progress", output: [] } },
            { type: "response.output_item.added", output_index: 0, item: { id: "rs_hidden", type: "reasoning", summary: [] } },
            encryptedFailure(),
          );
        }
        return responsesSse({
          type: "response.completed",
          response: { id: "resp_recovered", object: "response", status: "completed", model: "gpt-5.6-sol", output: [] },
        });
      },
    }, {
      body: {
        model: "gpt-5.6-sol",
        stream: true,
        previous_response_id: "resp_parent_encrypted",
        input: "continue",
      },
    });

    assert.equal(response.status, 200);
    assert.equal(bodies.length, 2);
    assert.equal(JSON.stringify(bodies[0]).includes("stale-encrypted-state"), true);
    assert.equal(JSON.stringify(bodies[1]).includes("encrypted_content"), false);
    assert.equal(JSON.stringify(bodies[1]).includes("remember this context"), true);
    assert.equal(JSON.stringify(bodies[1]).includes("parent answer"), true);
    assert.equal(JSON.stringify(bodies[1]).includes("continue"), true);
    assert.doesNotMatch(response.text, /resp_failed|response\.failed/);
    assert.match(response.text, /resp_recovered|response\.completed/);
    const snapshot = failures.snapshot();
    assert.equal(snapshot.total, 1);
    assert.equal(snapshot.retried, 1);
    assert.equal(snapshot.recent[0].retry_policy, "encrypted-replay-rejected");
    assert.doesNotMatch(snapshot.recent[0].message, /g{24}/);
    assert.equal(snapshot.recent[0].upstream_request_id, "upstream-stream-request");
  } finally {
    clearResponseHistoryForTests();
  }
});

test("HTTP 200 response.failed never retries after visible stream output", async () => {
  const failures = createResponseFailureDiagnostics();
  let calls = 0;
  const response = await invokeAdapter({
    responseFailures: failures,
    responsesFn: async () => {
      calls += 1;
      return responsesSse(
        { type: "response.created", response: { id: "resp_partial", object: "response", status: "in_progress", output: [] } },
        { type: "response.output_text.delta", output_index: 0, item_id: "msg_partial", delta: "partial output" },
        encryptedFailure("resp_partial"),
      );
    },
  }, {
    body: {
      model: "gpt-5.6-sol",
      stream: true,
      input: [
        { type: "reasoning", encrypted_content: "stale", summary: [] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    },
  });

  assert.equal(calls, 1);
  assert.match(response.text, /partial output/);
  assert.match(response.text, /response\.failed/);
  assert.equal(failures.snapshot().recent[0].retry_skipped, "output_started");
});

test("HTTP 200 unary failed response retries exact encrypted history once", async () => {
  const failures = createResponseFailureDiagnostics();
  const bodies = [];
  const response = await invokeAdapter({
    responseFailures: failures,
    responsesFn: async (body) => {
      bodies.push(structuredClone(body));
      if (bodies.length === 1) return Response.json(encryptedFailure("resp_unary_failed").response);
      return Response.json({ id: "resp_unary_recovered", object: "response", status: "completed", output: [] });
    },
  }, {
    body: {
      model: "gpt-5.6-sol",
      stream: false,
      input: [
        { type: "reasoning", encrypted_content: "stale", summary: [] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    },
  });

  assert.equal(bodies.length, 2);
  assert.equal(JSON.stringify(bodies[1]).includes("encrypted_content"), false);
  assert.equal(JSON.parse(response.text).id, "resp_unary_recovered");
  assert.equal(failures.snapshot().retried, 1);
});

test("HTTP 200 response.failed repairs an encrypted function output without leaving a schema shell", async () => {
  const bodies = [];
  const response = await invokeAdapter({
    responsesFn: async (body) => {
      bodies.push(structuredClone(body));
      if (bodies.length === 1) {
        return responsesSse({
          type: "response.failed",
          response: {
            id: "resp_function_failed",
            object: "response",
            status: "failed",
            output: [],
            error: {
              code: "invalid_request_body",
              message: "Encrypted function output content could not be decrypted or decoded.",
            },
          },
        });
      }
      return responsesSse({
        type: "response.completed",
        response: { id: "resp_function_recovered", object: "response", status: "completed", output: [] },
      });
    },
  }, {
    body: {
      model: "gpt-5.6-sol",
      stream: true,
      input: [
        { type: "function_call", id: "call_encrypted", call_id: "call_encrypted", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "call_encrypted", output: { type: "encrypted_content", encrypted_content: "opaque" } },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    },
  });

  assert.equal(bodies.length, 2);
  const output = bodies[1].input.find((item) => item.type === "function_call_output");
  assert.match(output.output, /encrypted tool output omitted/);
  assert.doesNotMatch(JSON.stringify(bodies[1]), /encrypted_content/);
  assert.match(response.text, /resp_function_recovered/);
});

test("HTTP responses body timeout aborts a stalled read and releases admission", async () => {
  const body = Buffer.from(JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }));
  const req = Readable.from((async function* slowBody() {
    yield body.subarray(0, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    yield body.subarray(1);
  })());
  req.headers = { "content-length": String(body.length), "content-type": "application/json" };
  req.method = "POST";
  req.url = "/v1/responses";
  req.socket = { remoteAddress: "127.0.0.1" };
  const destroyRequest = req.destroy.bind(req);
  let requestDestroyed = false;
  req.destroy = (...args) => {
    requestDestroyed = true;
    return destroyRequest(...args);
  };
  const admission = createRequestAdmission({ maxBytes: 1024, maxQueued: 2, waitTimeoutMs: 1000 });
  let upstreamCalled = false;

  const response = await invokeAdapterRequest({
    acquireRequest: admission,
    requestBodyTimeoutMs: 5,
    responsesFn: async () => {
      upstreamCalled = true;
      return Response.json({ id: "unexpected", output: [] });
    },
  }, req);

  assert.equal(response.status, 408);
  assert.equal(response.headers.Connection, "close");
  assert.equal(upstreamCalled, false);
  assert.equal(requestDestroyed, false);
  assert.equal(admission.diagnostics().activeRequests, 0);
});

test("HTTP proxy routes classify upstream network failures as Bad Gateway", async () => {
  const failure = async () => { throw new Error("upstream unavailable"); };
  const cases = [
    [{ responsesFn: failure }, { body: { model: "gpt-5.6-sol", input: "hello" } }],
    [{ responsesCompactFn: failure }, { url: "/v1/responses/compact", body: { model: "gpt-5.6-sol", input: "hello" } }],
  ];

  for (const [options, request] of cases) {
    const result = await invokeAdapter(options, request);
    assert.equal(result.status, 502);
    assert.deepEqual(JSON.parse(result.text), { error: "upstream unavailable" });
  }
});

test("HTTP native Responses releases request admission after upstream opens", async () => {
  clearResponseHistoryForTests();
  const history = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "earlier context" });
  rememberResponseHistory(history, { id: "resp_release_root", status: "completed", output: [] });
  let released = false;
  let observedContext;
  const result = await invokeAdapter({
    acquireRequest: async () => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        released = true;
      };
    },
    imagePressure: {
      apply(context) {
        observedContext = context;
        return { adapted: false, pressureEligible: false };
      },
    },
    responsesFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => {
        assert.equal(released, true);
        assert.equal(observedContext.body.input.length, 1);
        assert.equal(observedContext.currentInputStart, 0);
        return JSON.stringify({ id: "resp_release", output: [] });
      },
    }),
  }, {
    body: {
      model: "gpt-5.6-sol",
      stream: false,
      previous_response_id: "resp_release_root",
      input: "hello",
    },
  });

  assert.equal(result.status, 200);
  assert.equal(released, true);
  clearResponseHistoryForTests();
});

test("HTTP Responses does not start upstream after synchronous prepare work exceeds its deadline", async () => {
  clearResponseHistoryForTests();
  const history = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "visual history" });
  rememberResponseHistory(history, { id: "resp_prepare_deadline", status: "completed", output: [] });
  let clock = 0;
  let upstreamCalled = false;
  let timeoutMarked = false;
  let cooperativeCheckReceived = false;

  const result = await invokeAdapter({
    now: () => clock,
    upstreamTimeoutMs: 100,
    imagePressure: {
      apply(_context, { assertActive }) {
        cooperativeCheckReceived = typeof assertActive === "function";
        clock = 101;
        return { adapted: false, pressureEligible: true };
      },
      markTimeout(_rootId, { eligible }) {
        timeoutMarked = eligible;
        return eligible;
      },
    },
    responsesFn: async () => {
      upstreamCalled = true;
      return Response.json({ id: "unexpected", output: [] });
    },
  }, {
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_prepare_deadline",
      input: "continue",
    },
  });

  assert.equal(result.status, 504);
  assert.equal(JSON.parse(result.text).error.code, "ccdx_visual_history_timeout");
  assert.equal(upstreamCalled, false);
  assert.equal(timeoutMarked, true);
  assert.equal(cooperativeCheckReceived, true);
  clearResponseHistoryForTests();
});

test("HTTP Responses records visual timeout against the original root after an encrypted route rebase", async () => {
  clearResponseHistoryForTests();
  try {
    const imagePressure = createResponsesImagePressureController();
    const historicalInput = Array.from({ length: 36 }, (_, index) => ({
      type: "message",
      role: "user",
      content: [{
        type: "input_image",
        image_url: `data:image/png;base64,${Buffer.alloc(128, index + 1).toString("base64")}`,
      }],
    }));
    let upstreamCalls = 0;
    const responsesFn = async (_body, { onUpstreamStart, signal }) => {
      upstreamCalls += 1;
      onUpstreamStart();
      if (upstreamCalls === 1) {
        return Response.json({
          id: "resp_rebase_timeout_root",
          status: "completed",
          output: [{ type: "reasoning", encrypted_content: "route-bound-state", summary: [] }],
        });
      }
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason || new DOMException("This operation was aborted", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    };
    // Keep the wall deadline above CI scheduling jitter so this exercises the
    // upstream-timeout rebase path instead of expiring during preparation.
    const options = { imagePressure, responsesFn, upstreamTimeoutMs: 100 };

    const root = await invokeAdapter(options, {
      body: { model: "gpt-5.5", input: historicalInput },
    });
    assert.equal(root.status, 200);

    const rebased = await invokeAdapter(options, {
      body: {
        model: "gpt-5.6-sol",
        previous_response_id: "resp_rebase_timeout_root",
        input: "continue on the new route",
      },
    });
    assert.equal(rebased.status, 504);
    assert.equal(JSON.parse(rebased.text).error.code, "ccdx_visual_history_timeout");
    assert.equal(imagePressure.snapshot().timeouts_recorded, 1);
    assert.equal(imagePressure.snapshot().active_recovery_trees, 1);
  } finally {
    clearResponseHistoryForTests();
  }
});

test("HTTP Responses does not start a compatibility retry after the upstream wall deadline", async () => {
  let clock = 0;
  let attempts = 0;
  const result = await invokeAdapter({
    now: () => clock,
    upstreamTimeoutMs: 100,
    imagePressure: {
      apply() {
        return { adapted: false, pressureEligible: true };
      },
      markTimeout() {
        return true;
      },
    },
    responsesFn: async (_body, requestOptions) => {
      attempts += 1;
      requestOptions.onUpstreamStart();
      if (attempts === 1) {
        clock = 101;
        return new Response(JSON.stringify({
          error: { message: "Encrypted content could not be verified because it could not be decrypted" },
        }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      return Response.json({ id: "unexpected_retry", status: "completed", output: [] });
    },
  }, {
    body: {
      model: "gpt-5.6-sol",
      input: [{ type: "reasoning", encrypted_content: "stale", summary: [] }],
    },
  });

  assert.equal(result.status, 504);
  assert.equal(JSON.parse(result.text).error.code, "ccdx_visual_history_timeout");
  assert.equal(attempts, 1);
});

test("HTTP streaming responses time out while waiting for upstream headers", async () => {
  const result = await invokeAdapter({
    streamHandshakeTimeoutMs: 5,
    chatCompletionsFn: (_body, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")), { once: true });
    }),
  }, {
    body: { model: "gpt-4o", stream: true, input: "hello" },
  });

  assert.equal(result.status, 504);
  assert.match(result.text, /aborted/i);
});

test("HTTP streaming responses time out when the upstream body becomes idle", async () => {
  const result = await invokeAdapter({
    streamIdleTimeoutMs: 5,
    chatCompletionsFn: (_body, { signal }) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"));
          signal.addEventListener("abort", () => controller.error(new DOMException("This operation was aborted", "AbortError")), { once: true });
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    },
  }, {
    body: { model: "gpt-4o", stream: true, input: "hello" },
  });

  assert.equal(result.status, 200);
  assert.match(result.text, /response\.output_text\.delta/);
  assert.match(result.text, /event: error\ndata: \{"type":"error"/);
  assert.match(result.text, /stream_idle_timeout/);
});

test("HTTP native Responses stream emits a valid SSE error after headers", async () => {
  const result = await invokeAdapter({
    streamIdleTimeoutMs: 5,
    responsesFn: (_body, { signal }) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n"));
          signal.addEventListener("abort", () => controller.error(new DOMException("This operation was aborted", "AbortError")), { once: true });
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    },
  }, {
    body: { model: "gpt-5.6-sol", stream: true, input: "hello" },
  });

  assert.equal(result.status, 200);
  assert.match(result.text, /response\.output_text\.delta/);
  assert.match(result.text, /event: error\ndata: \{"type":"error"/);
  assert.match(result.text, /stream_idle_timeout/);
});

test("HTTP native Responses stream stops at a terminal event within the same upstream chunk", async () => {
  const completed = {
    type: "response.completed",
    response: { id: "resp_terminal", status: "completed", output: [] },
  };
  const trailing = {
    type: "response.output_text.delta",
    delta: "must-not-leak",
  };
  const upstreamBody = [
    `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify(trailing)}\n\n`,
  ].join("");

  const result = await invokeAdapter({
    responsesFn: async () => new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  }, {
    body: { model: "gpt-5.6-sol", stream: true, input: "hello" },
  });

  assert.equal(result.status, 200);
  assert.match(result.text, /response\.completed/);
  assert.doesNotMatch(result.text, /must-not-leak/);
  assert.doesNotMatch(result.text, /response\.output_text\.delta/);
});

test("HTTP native Responses stream scans an 8 MiB fragmented event linearly across CRLF boundaries", async () => {
  const maxEventBytes = RUNTIME_DEFAULTS.maxSseBufferBytes;
  const eventPrefix = Buffer.from('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"');
  const eventSuffix = Buffer.from('"}');
  const eventBody = Buffer.concat([
    eventPrefix,
    Buffer.alloc(maxEventBytes - eventPrefix.byteLength - eventSuffix.byteLength, 0x78),
    eventSuffix,
  ]);
  const event = Buffer.concat([eventBody, Buffer.from("\r\n\r\n")]);
  const completed = JSON.stringify({
    type: "response.completed",
    response: { id: "resp_fragmented", status: "completed", output: [] },
  });
  const terminalPrefix = Buffer.from(`event: response.completed\r\ndata: ${completed}\r\n\r`);
  const terminalSuffix = Buffer.from("\nevent: response.output_text.delta\ndata: must-not-leak\n\n");
  const chunks = [];
  for (let offset = 0; offset < event.byteLength; offset += 16 * 1024) {
    chunks.push(event.subarray(offset, Math.min(offset + 16 * 1024, event.byteLength)));
  }
  chunks.push(terminalPrefix, terminalSuffix);
  let chunkIndex = 0;
  const upstreamBody = new ReadableStream({
    pull(controller) {
      if (chunkIndex >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[chunkIndex]);
      chunkIndex += 1;
    },
  }, { highWaterMark: 0 });

  const originalByteLength = Buffer.byteLength;
  let scannedBytes = 0;
  Buffer.byteLength = function trackedByteLength(value, ...args) {
    const bytes = originalByteLength(value, ...args);
    scannedBytes += bytes;
    return bytes;
  };
  let result;
  try {
    result = await invokeAdapter({
      responsesFn: async () => new Response(upstreamBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    }, {
      body: { model: "gpt-5.6-sol", stream: true, input: "hello" },
    });
  } finally {
    Buffer.byteLength = originalByteLength;
  }

  assert.equal(result.status, 200);
  assert.equal(eventBody.byteLength, maxEventBytes);
  assert.ok(scannedBytes < maxEventBytes * 2, `rescanned ${scannedBytes} bytes`);
  assert.match(result.text, /response\.completed/);
  assert.doesNotMatch(result.text, /must-not-leak/);
});

test("HTTP native Responses stream rejects an event above the configured byte limit", async () => {
  const oversized = Buffer.concat([
    Buffer.alloc(RUNTIME_DEFAULTS.maxSseBufferBytes + 1, 0x78),
    Buffer.from("\n\n"),
  ]);
  const result = await invokeAdapter({
    responsesFn: async () => new Response(oversized, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  }, {
    body: { model: "gpt-5.6-sol", stream: true, input: "hello" },
  });

  assert.equal(result.status, 200);
  assert.match(result.text, /SSE buffer exceeds 8388608 bytes/);
  assert.match(result.text, /event: error/);
});

test("HTTP native unary Responses validates a successful envelope before forwarding", async () => {
  for (const upstreamBody of ["not-json", JSON.stringify({ output: [] })]) {
    const result = await invokeAdapter({
      responsesFn: async () => new Response(upstreamBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    }, {
      body: { model: "gpt-5.6-sol", input: "hello" },
    });

    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.text).error.code, "ccdx_invalid_responses_response");
    assert.doesNotMatch(result.text, /not-json/);
  }
});

test("HTTP native unary Responses preserves valid HTTP 200 incomplete and failed resources", async () => {
  for (const status of ["incomplete", "failed"]) {
    const upstream = {
      id: `resp_${status}`,
      object: "response",
      status,
      output: [],
    };
    const result = await invokeAdapter({
      responsesFn: async () => Response.json(upstream),
    }, {
      body: { model: "gpt-5.6-sol", input: "hello" },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.text), upstream);
  }
});

test("HTTP native unary Responses keeps successful bodies above the error-body limit byte-equivalent", async () => {
  const upstreamText = JSON.stringify({
    id: "resp_large_success",
    status: "completed",
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "x".repeat((1024 * 1024) + 1) }],
    }],
  });
  const response = await invokeAdapter({
    responsesFn: async () => new Response(upstreamText, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  }, {
    body: { model: "gpt-5.6-sol", input: "large success" },
  });

  assert.equal(response.status, 200);
  assert.equal(response.text, upstreamText);
});

test("HTTP unary Responses applies separate high success-body budgets to native and Chat routes", async () => {
  const native = await invokeAdapter({
    responsesFn: async () => new Response(JSON.stringify({ id: "resp_native_limit", output: [] }), {
      headers: { "Content-Length": String(MAX_UPSTREAM_RESPONSES_SUCCESS_BODY_BYTES + 1) },
    }),
  }, {
    body: { model: "gpt-5.6-sol", input: "native limit" },
  });
  assert.equal(native.status, 502);
  assert.equal(JSON.parse(native.text).error.code, "ccdx_upstream_response_too_large");

  const chat = await invokeAdapter({
    chatCompletionsFn: async () => new Response(JSON.stringify({ choices: [] }), {
      headers: { "Content-Length": String(MAX_UPSTREAM_CHAT_SUCCESS_BODY_BYTES + 1) },
    }),
  }, {
    body: { model: "gpt-4o", input: "chat limit" },
  });
  assert.equal(chat.status, 502);
  assert.equal(JSON.parse(chat.text).error.code, "ccdx_upstream_response_too_large");
});

test("HTTP native unary Responses cancels an oversized upstream error body", async () => {
  let cancelled = false;
  const response = await invokeAdapter({
    responsesFn: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.alloc((1024 * 1024) + 1, 0x78));
      },
      cancel() { cancelled = true; },
    }), { status: 500 }),
  }, {
    body: { model: "gpt-5.6-sol", input: "oversized error" },
  });

  assert.equal(response.status, 502);
  assert.equal(JSON.parse(response.text).error.code, "ccdx_upstream_response_too_large");
  assert.equal(cancelled, true);
});

test("HTTP response history remains replayable when unrelated roots arrive during admission", async () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 1024 * 1024, maxEntries: 2 });
  try {
    const rootContext = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "root input" });
    rememberResponseHistory(rootContext, {
      id: "resp_admission_pinned_root",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "root output" }] }],
    });

    let injected = false;
    const acquireRequest = async () => {
      const release = () => {};
      release.reserveResponseHistory = async () => {
        if (injected) return () => {};
        injected = true;
        for (const id of ["resp_unrelated_a", "resp_unrelated_b"]) {
          const context = prepareResponsesRequest({ model: "gpt-5.6-sol", input: id });
          rememberResponseHistory(context, { id, status: "completed", output: [] });
        }
        return () => {};
      };
      return release;
    };

    const child = await invokeAdapter({
      acquireRequest,
      responsesFn: async () => Response.json({
        id: "resp_admission_pinned_child",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "child output" }] }],
      }),
    }, {
      body: {
        model: "gpt-5.6-sol",
        previous_response_id: "resp_admission_pinned_root",
        input: "child input",
      },
    });
    assert.equal(child.status, 200);

    let replayBody;
    const replay = await invokeAdapter({
      acquireRequest,
      responsesFn: async (body) => {
        replayBody = structuredClone(body);
        return Response.json({ id: "resp_admission_replayed", status: "completed", output: [] });
      },
    }, {
      body: {
        model: "gpt-5.6-sol",
        previous_response_id: "resp_admission_pinned_child",
        input: "continue",
      },
    });

    assert.equal(replay.status, 200);
    const serialized = JSON.stringify(replayBody);
    assert.equal(serialized.includes("root output"), true);
    assert.equal(serialized.includes("child output"), true);
    assert.equal(serialized.includes("continue"), true);
  } finally {
    clearResponseHistoryForTests();
  }
});
