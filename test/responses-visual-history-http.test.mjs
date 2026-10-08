import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { clearResponseHistoryForTests } from "../src/response-history.mjs";
import { prepareResponsesRequest, rememberResponseHistory } from "../src/responses-request.mjs";
import { responsesHistoricalImageStats } from "../src/responses-byte-budget.mjs";
import { createResponsesImagePressureController } from "../src/responses-image-pressure.mjs";
import { invokeAdapter } from "../test-support/adapter.mjs";

function jsonRequest(body, contentEncoding, headers = {}) {
  const req = Readable.from([body]);
  req.headers = { ...headers };
  if (contentEncoding) req.headers["content-encoding"] = contentEncoding;
  return req;
}

test("HTTP responses route preserves 0.4.23 image_gen compatibility", async () => {
  let upstreamBody;
  const response = await invokeAdapter({
    responsesFn: async (body) => {
      upstreamBody = body;
      return new Response(JSON.stringify({ id: "resp_img", status: "completed", output: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  }, {
    body: {
      model: "gpt-5.6-sol",
      input: "hello",
      tools: [
        { type: "image_generation", namespace: "image_gen" },
        { type: "function", name: "lookup", parameters: { type: "object" } },
      ],
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(upstreamBody.tools, [
    { type: "function", name: "lookup", parameters: { type: "object" } },
  ]);
});

test("HTTP responses route retries large visual history in recovery mode without replaying the timed-out POST", async () => {
  clearResponseHistoryForTests();
  const history = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    input: Array.from({ length: 36 }, (_, index) => ({
      type: "message",
      role: "user",
      content: [{
        type: "input_image",
        image_url: `data:image/png;base64,${Buffer.alloc(128, index + 1).toString("base64")}`,
      }],
    })),
  });
  rememberResponseHistory(history, { id: "resp_visual_root", status: "completed", output: [] });

  const imagePressure = createResponsesImagePressureController();
  const upstreamImageCounts = [];
  let upstreamCalls = 0;
  const responsesFn = async (body, { currentInputStart, onUpstreamStart, signal }) => {
    upstreamCalls += 1;
    upstreamImageCounts.push(responsesHistoricalImageStats(body.input, currentInputStart).historicalImages);
    onUpstreamStart();
    if (upstreamCalls === 1) {
      await new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    }
    const event = {
      type: "response.completed",
      response: {
        id: `resp_visual_${upstreamCalls}`,
        object: "response",
        status: "completed",
        model: body.model,
        output: [],
      },
    };
    return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  const options = {
    imagePressure,
    responsesFn,
    streamHandshakeTimeoutMs: 5,
    streamIdleTimeoutMs: 1000,
    upstreamTimeoutMs: 1000,
  };

  const first = await invokeAdapter(options, {
    body: {
      model: "gpt-5.6-sol",
      stream: true,
      previous_response_id: "resp_visual_root",
      input: "continue",
    },
  });
  assert.equal(first.status, 504);
  assert.equal(JSON.parse(first.text).error.code, "ccdx_visual_history_timeout");
  assert.equal(upstreamCalls, 1);
  assert.deepEqual(upstreamImageCounts, [16]);

  const second = await invokeAdapter(options, {
    body: {
      model: "gpt-5.6-sol",
      stream: true,
      previous_response_id: "resp_visual_root",
      input: "continue",
    },
  });
  assert.equal(second.status, 200);
  assert.equal(upstreamCalls, 2);
  assert.deepEqual(upstreamImageCounts, [16, 8]);
  assert.equal(imagePressure.snapshot().active_recovery_trees, 1);
  clearResponseHistoryForTests();
});

test("HTTP Responses activates stricter visual-history recovery after an upstream 408", async () => {
  clearResponseHistoryForTests();
  const history = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    input: Array.from({ length: 36 }, (_, index) => ({
      type: "message",
      role: "user",
      content: [{
        type: "input_image",
        image_url: `data:image/png;base64,${Buffer.alloc(128, index + 1).toString("base64")}`,
      }],
    })),
  });
  rememberResponseHistory(history, { id: "resp_http_408_root", status: "completed", output: [] });

  const imagePressure = createResponsesImagePressureController();
  const upstreamImageCounts = [];
  let upstreamCalls = 0;
  const responsesFn = async (body, { currentInputStart, onUpstreamStart }) => {
    upstreamCalls += 1;
    upstreamImageCounts.push(responsesHistoricalImageStats(body.input, currentInputStart).historicalImages);
    onUpstreamStart();
    if (upstreamCalls === 1) {
      return Response.json({ error: { message: "request timed out" } }, { status: 408 });
    }
    return Response.json({
      id: "resp_http_408_recovered",
      object: "response",
      status: "completed",
      model: body.model,
      output: [],
    });
  };
  const options = { imagePressure, responsesFn };

  const first = await invokeAdapter(options, {
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_http_408_root",
      input: "continue",
    },
  });
  assert.equal(first.status, 408);
  assert.deepEqual(upstreamImageCounts, [16]);
  assert.equal(imagePressure.snapshot().active_recovery_trees, 1);

  const second = await invokeAdapter(options, {
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_http_408_root",
      input: "continue",
    },
  });
  assert.equal(second.status, 200);
  assert.equal(upstreamCalls, 2);
  assert.deepEqual(upstreamImageCounts, [16, 8]);
  clearResponseHistoryForTests();
});
