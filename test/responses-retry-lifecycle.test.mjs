import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  clearResponseHistoryForTests,
  createAdapterHandler,
  createRequestAdmission,
  prepareResponsesRequest,
  rememberResponseHistory,
} from "../src/adapter.mjs";
import { createResponseFailureDiagnostics } from "../src/response-failures.mjs";

function failureEvent() {
  return {
    type: "response.failed",
    response: {
      id: "resp_retry_failed",
      status: "failed",
      output: [],
      error: { message: "Encrypted function output content could not be decrypted or decoded." },
    },
  };
}

function completedEvent() {
  return {
    type: "response.completed",
    response: { id: "resp_retry_completed", status: "completed", output: [] },
  };
}

function eventResponse(event, beforeBody = async () => {}) {
  return new Response(new ReadableStream({
    async start(controller) {
      // Deliver the body after openCopilotResponse has received the headers.
      await new Promise((resolve) => setImmediate(resolve));
      await beforeBody();
      controller.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

async function invoke(options, body, onRequest = () => {}) {
  const wire = Buffer.from(JSON.stringify(body));
  const req = Readable.from([wire]);
  Object.assign(req, {
    method: "POST",
    url: "/v1/responses",
    headers: { "content-type": "application/json", "content-length": String(wire.length) },
    socket: { remoteAddress: "127.0.0.1" },
  });
  const chunks = [];
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    statusCode: 200,
  });
  res.writeHead = (statusCode) => {
    res.statusCode = statusCode;
    res.headersSent = true;
    return res;
  };
  res.write = (chunk) => { chunks.push(Buffer.from(chunk)); return true; };
  res.end = (chunk) => {
    if (chunk !== undefined) chunks.push(Buffer.from(chunk));
    res.writableEnded = true;
  };
  onRequest(req, res);
  const handler = createAdapterHandler(options);
  try {
    await handler(req, res);
    return { status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") };
  } finally {
    handler.cleanup?.();
  }
}

function rememberParent() {
  const parent = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "x".repeat(100_000) });
  rememberResponseHistory(parent, {
    id: "resp_retry_parent",
    status: "completed",
    output: [{ type: "reasoning", encrypted_content: "stale", summary: [] }],
  });
}

function continuation(stream = true) {
  return {
    model: "gpt-5.6-sol",
    stream,
    previous_response_id: "resp_retry_parent",
    input: "continue",
  };
}

test("stream failure recovery starts a fresh preparation phase after the original handshake deadline", async () => {
  clearResponseHistoryForTests();
  try {
    rememberParent();
    let now = 0;
    let calls = 0;
    const result = await invoke({
      now: () => now,
      responsesFn: async (_body, options) => {
        options.onUpstreamStart();
        calls += 1;
        return calls === 1
          ? eventResponse(failureEvent(), () => { now = 120_001; })
          : eventResponse(completedEvent());
      },
    }, continuation());
    assert.equal(calls, 2);
    assert.match(result.text, /response\.completed/);
    assert.doesNotMatch(result.text, /stream_handshake_timeout|response\.failed/);
  } finally {
    clearResponseHistoryForTests();
  }
});

for (const stream of [true, false]) {
  test(`HTTP 200 failure recovery reserves restored history and releases it after headers (stream=${stream})`, async () => {
    clearResponseHistoryForTests();
    try {
      rememberParent();
      const acquireRequest = createRequestAdmission({ maxBytes: 131_072 });
      let calls = 0;
      const result = await invoke({
        acquireRequest,
        responsesFn: async (body) => {
          calls += 1;
          assert.ok(Buffer.byteLength(JSON.stringify(body.input)) > 100_000);
          const diagnostics = acquireRequest.diagnostics();
          assert.equal(diagnostics.activeRequests, 1);
          assert.equal(diagnostics.responseHistoriesActive, 1);
          assert.ok(diagnostics.responseHistoryBytes > 100_000);
          const event = calls === 1 ? failureEvent() : completedEvent();
          const afterHeaders = () => {
            assert.equal(acquireRequest.diagnostics().activeRequests, 0);
            assert.equal(acquireRequest.diagnostics().responseHistoriesActive, 0);
          };
          if (stream) return eventResponse(event, afterHeaders);
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            text: async () => { afterHeaders(); return JSON.stringify(event.response); },
          };
        },
      }, continuation(stream));
      assert.equal(calls, 2);
      assert.match(result.text, /resp_retry_completed/);
      assert.equal(acquireRequest.diagnostics().activeRequests, 0);
      assert.equal(acquireRequest.diagnostics().responseHistoriesActive, 0);
    } finally {
      clearResponseHistoryForTests();
    }
  });
}

test("a repeated encrypted stream failure stops after one recovery attempt and releases reservations", async () => {
  clearResponseHistoryForTests();
  try {
    rememberParent();
    const acquireRequest = createRequestAdmission({ maxBytes: 131_072 });
    let calls = 0;
    const result = await invoke({
      acquireRequest,
      responsesFn: async () => { calls += 1; return eventResponse(failureEvent()); },
    }, continuation());
    assert.equal(calls, 2);
    assert.match(result.text, /response\.failed/);
    assert.equal(acquireRequest.diagnostics().activeRequests, 0);
    assert.equal(acquireRequest.diagnostics().responseHistoriesActive, 0);
  } finally {
    clearResponseHistoryForTests();
  }
});

test("the first upstream handshake still rejects headers received after its deadline", async () => {
  let now = 0;
  let calls = 0;
  const result = await invoke({
    now: () => now,
    responsesFn: async (_body, options) => {
      calls += 1;
      options.onUpstreamStart();
      now = 120_001;
      return eventResponse(completedEvent());
    },
  }, { model: "gpt-5.6-sol", input: "hello", stream: true });
  assert.equal(calls, 1);
  assert.equal(result.status, 504);
  assert.doesNotMatch(result.text, /response\.completed/);
});

test("cancelling a retry queued for history admission releases its request and preserves failure diagnostics", async () => {
  clearResponseHistoryForTests();
  let releaseBlocker = () => {};
  try {
    rememberParent();
    const gate = createRequestAdmission({ maxBytes: 131_072 });
    const responseFailures = createResponseFailureDiagnostics();
    let request;
    let acquisitions = 0;
    let calls = 0;
    let queuedAtAbort = 0;
    const result = await invoke({
      responseFailures,
      acquireRequest: async (req, options) => {
        const release = await gate(req, options);
        acquisitions += 1;
        if (acquisitions === 2) {
          const reserve = release.reserveResponseHistory;
          release.reserveResponseHistory = (bytes, reservationOptions) => {
            const pending = reserve(bytes, reservationOptions);
            queuedAtAbort = gate.diagnostics().responseHistoriesQueued;
            queueMicrotask(() => request.emit("aborted"));
            return pending;
          };
        }
        return release;
      },
      responsesFn: async () => {
        calls += 1;
        assert.equal(calls, 1, "cancelled retry must not dispatch upstream");
        return eventResponse(failureEvent(), async () => {
          releaseBlocker = await gate({ headers: { "content-length": "1" } });
          await releaseBlocker.reserveResponseHistory(131_072);
        });
      },
    }, continuation(), (req) => { request = req; });
    assert.equal(acquisitions, 2);
    assert.equal(queuedAtAbort, 1);
    assert.equal(calls, 1);
    assert.match(result.text, /client_aborted/);
    assert.equal(responseFailures.snapshot().recent[0].retry_skipped, "retry_preparation_failed");
    releaseBlocker();
    assert.equal(gate.diagnostics().activeRequests, 0);
    assert.equal(gate.diagnostics().responseHistoriesActive, 0);
    assert.equal(gate.diagnostics().responseHistoriesQueued, 0);
  } finally {
    releaseBlocker();
    clearResponseHistoryForTests();
  }
});

test("the new retry preparation phase remains bounded and releases admission on expiry", async () => {
  clearResponseHistoryForTests();
  try {
    rememberParent();
    const gate = createRequestAdmission({ maxBytes: 131_072 });
    let now = 0;
    let acquisitions = 0;
    let calls = 0;
    const result = await invoke({
      now: () => now,
      acquireRequest: async (req, options) => {
        const release = await gate(req, options);
        acquisitions += 1;
        if (acquisitions === 2) now += 120_001;
        return release;
      },
      responsesFn: async (_body, options) => {
        options.onUpstreamStart();
        calls += 1;
        return eventResponse(failureEvent(), () => { now = 120_001; });
      },
    }, continuation());
    assert.equal(acquisitions, 2);
    assert.equal(calls, 1);
    assert.match(result.text, /responses_prepare_timeout/);
    assert.equal(gate.diagnostics().activeRequests, 0);
    assert.equal(gate.diagnostics().responseHistoriesActive, 0);
  } finally {
    clearResponseHistoryForTests();
  }
});
