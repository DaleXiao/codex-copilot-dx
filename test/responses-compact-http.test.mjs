import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  clearResponseHistoryForTests,
  configureResponseHistoryForTests,
  responseHistoryStats,
} from "../src/response-history.mjs";
import { prepareResponsesRequest, rememberResponseHistory } from "../src/responses-request.mjs";
import { responsesHistoricalImageStats } from "../src/responses-byte-budget.mjs";
import { readResponsesToolOutputParts } from "../src/responses-content.mjs";
import { createResponsesImagePressureController } from "../src/responses-image-pressure.mjs";
import { invokeAdapter } from "../test-support/adapter.mjs";

function jsonRequest(body, contentEncoding, headers = {}) {
  const req = Readable.from([body]);
  req.headers = { ...headers };
  if (contentEncoding) req.headers["content-encoding"] = contentEncoding;
  return req;
}

test("HTTP compact releases original and compatibility-retry tool caches after upstream opens", async () => {
  const output = JSON.stringify([{ type: "input_text", text: "cached compact output" }]);
  const originalParse = JSON.parse;
  let parses = 0;
  let attempts = 0;
  JSON.parse = function countedParse(value, ...args) {
    if (value === output) parses += 1;
    return originalParse.call(this, value, ...args);
  };

  try {
    const result = await invokeAdapter({
      responsesCompactFn: async (body) => {
        attempts += 1;
        if (attempts === 1) {
          assert.equal(parses, 1);
          return new Response(JSON.stringify({
            error: { message: "Encrypted content could not be verified because it could not be decrypted" },
          }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const toolOutput = body.input.find((item) => item?.type === "function_call_output");
        readResponsesToolOutputParts(toolOutput);
        assert.equal(parses, 2);
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: async () => {
            readResponsesToolOutputParts(toolOutput);
            assert.equal(parses, 3);
            return JSON.stringify({
              id: "resp_compact_cache_release",
              status: "completed",
              output: [{ type: "compaction", id: "cmp_cache_release", encrypted_content: "fresh-state" }],
            });
          },
        };
      },
    }, {
      url: "/v1/responses/compact",
      body: {
        model: "gpt-5.6-sol",
        input: [
          { type: "function_call_output", call_id: "call_cache", output },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "keep", encrypted_content: "stale" }],
          },
        ],
      },
    });

    assert.equal(result.status, 200);
    assert.equal(attempts, 2);
    assert.equal(parses, 3);
  } finally {
    JSON.parse = originalParse;
  }
});

test("HTTP compact response stores the upstream canonical output as a new replay root", async () => {
  clearResponseHistoryForTests();

  const original = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "old user context" });
  rememberResponseHistory(original, {
    id: "resp_before_compact",
    output: [{
      type: "message",
      id: "msg_old",
      role: "assistant",
      content: [{ type: "output_text", text: "old assistant context" }],
    }],
  });

  const compactOutput = [
    { type: "reasoning", id: "rs_compact", summary: [{ type: "summary_text", text: "retained summary" }] },
    {
      type: "message",
      id: "msg_retained",
      role: "assistant",
      content: [{ type: "output_text", text: "retained compact context" }],
    },
    { type: "compaction", id: "cmp_1", encrypted_content: "opaque-compact-state" },
  ];
  let compactBody;
  const result = await invokeAdapter({
    responsesCompactFn: async (body) => {
      compactBody = structuredClone(body);
      return new Response(JSON.stringify({
        id: "resp_after_compact",
        object: "response",
        status: "completed",
        output: compactOutput,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  }, {
    url: "/v1/responses/compact",
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_before_compact",
      input: "compact this conversation",
    },
  });

  assert.equal(result.status, 200);
  assert.equal(compactBody.stream, false);
  assert.equal(compactBody.input.filter((item) => item.type === "compaction_trigger").length, 1);
  assert.deepEqual(compactBody.input.at(-1), { type: "compaction_trigger" });
  const response = JSON.parse(result.text);
  assert.equal(response.object, "response.compaction");
  assert.deepEqual(response.output, compactOutput);
  const replay = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    previous_response_id: "resp_after_compact",
    input: "continue from compact",
  }).body.input;
  assert.deepEqual(replay.slice(0, -1), compactOutput);
  assert.equal(replay.at(-1).content[0].text, "continue from compact");
  assert.deepEqual(
    prepareResponsesRequest({
      model: "gpt-5.6-sol",
      previous_response_id: "resp_before_compact",
      input: "continue old branch",
    }).body.input.map((item) => item.id || item.content?.[0]?.text),
    ["old user context", "msg_old", "continue old branch"],
  );
  assert.equal(responseHistoryStats().entries, 2);
  clearResponseHistoryForTests();
});

test("successful compact response without a compaction item fails closed and stores no history", async () => {
  clearResponseHistoryForTests();

  const original = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "old context" });
  rememberResponseHistory(original, { id: "resp_append_root", output: [] });
  const result = await invokeAdapter({
    responsesCompactFn: async () => new Response(JSON.stringify({
      id: "resp_not_compacted",
      status: "completed",
      output: [{
        type: "message",
        id: "msg_no_compaction",
        role: "assistant",
        content: [{ type: "output_text", text: "not compacted" }],
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  }, {
    url: "/v1/responses/compact",
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_append_root",
      input: "compact attempt",
    },
  });

  assert.equal(result.status, 502);
  assert.equal(JSON.parse(result.text).error.code, "ccdx_invalid_compaction_response");
  assert.throws(
    () => prepareResponsesRequest({
      model: "gpt-5.6-sol",
      previous_response_id: "resp_not_compacted",
      input: "next",
    }),
    /previous_response_id is not available/,
  );
  assert.deepEqual(
    prepareResponsesRequest({ model: "gpt-5.6-sol", previous_response_id: "resp_append_root", input: "next" })
      .body.input.map((item) => item.content?.[0]?.text),
    ["old context", "next"],
  );
  clearResponseHistoryForTests();
});

test("HTTP 200 non-completed compact responses fail closed and cannot replace existing history", async () => {
  for (const responseStatus of ["failed", "incomplete"]) {
    clearResponseHistoryForTests();
    const rootId = `resp_${responseStatus}_compact_root`;
    const compactId = `resp_${responseStatus}_compact`;
    const original = prepareResponsesRequest({ model: "gpt-5.6-sol", input: `${responseStatus} preserved context` });
    rememberResponseHistory(original, { id: rootId, status: "completed", output: [] });

    const result = await invokeAdapter({
      responsesCompactFn: async () => new Response(JSON.stringify({
        id: compactId,
        object: "response.compaction",
        status: responseStatus,
        output: [{ type: "compaction", id: `cmp_${responseStatus}`, encrypted_content: "partial-state" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    }, {
      url: "/v1/responses/compact",
      body: {
        model: "gpt-5.6-sol",
        previous_response_id: rootId,
        input: `${responseStatus} compact attempt`,
      },
    });

    assert.equal(result.status, 502);
    assert.throws(
      () => prepareResponsesRequest({
        model: "gpt-5.6-sol",
        previous_response_id: compactId,
        input: "continue",
      }),
      /previous_response_id is not available/,
    );
    assert.deepEqual(
      prepareResponsesRequest({ model: "gpt-5.6-sol", previous_response_id: rootId, input: "continue" })
        .body.input.map((item) => item.content?.[0]?.text),
      [`${responseStatus} preserved context`, "continue"],
    );
  }
  clearResponseHistoryForTests();
});

test("failed compact response cannot replace existing history", async () => {
  clearResponseHistoryForTests();

  const original = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "preserved context" });
  rememberResponseHistory(original, { id: "resp_failed_compact_root", output: [] });
  const result = await invokeAdapter({
    responsesCompactFn: async () => new Response(JSON.stringify({
      id: "resp_failed_compact",
      status: "failed",
      output: [{ type: "compaction", id: "cmp_failed", encrypted_content: "must-not-store" }],
    }), { status: 500, headers: { "Content-Type": "application/json" } }),
  }, {
    url: "/v1/responses/compact",
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_failed_compact_root",
      input: "failed compact attempt",
    },
  });

  assert.equal(result.status, 500);
  assert.throws(
    () => prepareResponsesRequest({
      model: "gpt-5.6-sol",
      previous_response_id: "resp_failed_compact",
      input: "must be unavailable",
    }),
    /previous_response_id is not available/,
  );
  assert.deepEqual(
    prepareResponsesRequest({
      model: "gpt-5.6-sol",
      previous_response_id: "resp_failed_compact_root",
      input: "old branch still works",
    }).body.input.map((item) => item.content?.[0]?.text),
    ["preserved context", "old branch still works"],
  );
  clearResponseHistoryForTests();
});

test("compact snapshots use the sanitized body that actually succeeded upstream", async () => {
  let attempts = 0;
  let successfulBody;
  const result = await invokeAdapter({
    responsesCompactFn: async (body) => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({
          error: { message: "Encrypted content could not be verified because it could not be decrypted" },
        }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      successfulBody = structuredClone(body);
      return new Response(JSON.stringify({
        id: "resp_sanitized_compact",
        status: "completed",
        output: [{ type: "compaction", id: "cmp_sanitized", encrypted_content: "fresh-state" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  }, {
    url: "/v1/responses/compact",
    body: {
      model: "gpt-5.6-sol",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "keep me", encrypted_content: "stale-secret" }],
      }],
    },
  });

  assert.equal(result.status, 200);
  assert.equal(attempts, 2);
  assert.equal(Object.hasOwn(successfulBody.input[0].content[0], "encrypted_content"), false);
  const response = JSON.parse(result.text);
  assert.deepEqual(response.output, [
    { type: "compaction", id: "cmp_sanitized", encrypted_content: "fresh-state" },
  ]);
});

test("compact route forces a requested stream into unary mode and stores the valid snapshot", async () => {
  clearResponseHistoryForTests();

  const original = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "stream old context" });
  rememberResponseHistory(original, { id: "resp_stream_root", output: [] });
  const compactOutput = [
    {
      type: "message",
      id: "msg_stream_retained",
      role: "assistant",
      content: [{ type: "output_text", text: "stream retained context" }],
    },
    { type: "compaction", id: "cmp_stream", encrypted_content: "opaque-stream-state" },
  ];
  let compactBody;
  const result = await invokeAdapter({
    responsesCompactFn: async (body) => {
      compactBody = body;
      return new Response(JSON.stringify({
        id: "resp_stream_compacted",
        object: "response",
        status: "completed",
        output: compactOutput,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  }, {
    url: "/v1/responses/compact",
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_stream_root",
      input: "stream compact attempt",
      stream: true,
    },
  });

  assert.equal(result.status, 200);
  assert.equal(compactBody.stream, false);
  assert.deepEqual(compactBody.input.at(-1), { type: "compaction_trigger" });
  assert.equal(JSON.parse(result.text).object, "response.compaction");
  const replay = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    previous_response_id: "resp_stream_compacted",
    input: "stream next",
  }).body.input;
  assert.deepEqual(replay.map((item) => item.type), ["message", "compaction", "message"]);
  assert.deepEqual(replay.slice(0, 2), compactOutput);
  assert.equal(replay.at(-1).content[0].text, "stream next");
  clearResponseHistoryForTests();
});

test("compact snapshot remains available when normal LRU eviction removes its older branch", async () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 1_000_000, maxEntries: 3 });

  const root = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "old root" });
  rememberResponseHistory(root, { id: "resp_lru_old_root", status: "completed", output: [] });
  const child = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    previous_response_id: "resp_lru_old_root",
    input: "old child",
  });
  rememberResponseHistory(child, { id: "resp_lru_old_child", status: "completed", output: [] });

  const result = await invokeAdapter({
    responsesCompactFn: async () => new Response(JSON.stringify({
      id: "resp_lru_compact",
      status: "completed",
      output: [{ type: "compaction", id: "cmp_lru", encrypted_content: "compact-state" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  }, {
    url: "/v1/responses/compact",
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_lru_old_child",
      input: "compact old branch",
    },
  });
  assert.equal(result.status, 200);
  assert.equal(responseHistoryStats().entries, 3);

  rememberResponseHistory(
    prepareResponsesRequest({ model: "gpt-5.6-sol", input: "new independent root" }),
    { id: "resp_lru_new_root", status: "completed", output: [] },
  );

  assert.throws(
    () => prepareResponsesRequest({ model: "gpt-5.6-sol", previous_response_id: "resp_lru_old_child", input: "evicted" }),
    /was evicted after reaching the local history limit/,
  );
  const replay = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    previous_response_id: "resp_lru_compact",
    input: "continue compact",
  }).body.input;
  assert.deepEqual(replay.map((item) => item.type), ["compaction", "message"]);
  assert.deepEqual(replay[0], { type: "compaction", id: "cmp_lru", encrypted_content: "compact-state" });
  clearResponseHistoryForTests();
});

test("compact can replace a full pinned history pool with its replayable new root", async () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 1024 * 1024, maxEntries: 1 });
  try {
    const root = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "old root" });
    rememberResponseHistory(root, { id: "resp_compact_full_root", status: "completed", output: [] });

    const compact = await invokeAdapter({
      responsesCompactFn: async () => Response.json({
        id: "resp_compact_full_new",
        object: "response.compaction",
        status: "completed",
        output: [{ type: "compaction", id: "cmp_full", encrypted_content: "compact-state" }],
      }),
    }, {
      url: "/v1/responses/compact",
      body: {
        model: "gpt-5.6-sol",
        previous_response_id: "resp_compact_full_root",
        input: "compact",
      },
    });
    assert.equal(compact.status, 200);
    assert.equal(responseHistoryStats().entries, 1);

    const replay = await invokeAdapter({
      responsesFn: async () => Response.json({ id: "resp_compact_full_replay", status: "completed", output: [] }),
    }, {
      body: {
        model: "gpt-5.6-sol",
        previous_response_id: "resp_compact_full_new",
        input: "continue",
      },
    });
    assert.equal(replay.status, 200);
  } finally {
    clearResponseHistoryForTests();
  }
});

test("successful compaction clears visual-history recovery for the compacted tree", async () => {
  clearResponseHistoryForTests();
  const history = prepareResponsesRequest({ model: "gpt-5.6-sol", input: "before compaction" });
  rememberResponseHistory(history, { id: "resp_pressure_compact_root", status: "completed", output: [] });
  const imagePressure = createResponsesImagePressureController();
  imagePressure.markTimeout("resp_pressure_compact_root", { eligible: true });

  const result = await invokeAdapter({
    imagePressure,
    responsesCompactFn: async (_body, { onUpstreamStart }) => {
      onUpstreamStart();
      return Response.json({
        id: "resp_pressure_compacted",
        object: "response.compaction",
        status: "completed",
        output: [{ type: "compaction", id: "cmp_pressure", encrypted_content: "state" }],
      });
    },
  }, {
    url: "/v1/responses/compact",
    body: {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_pressure_compact_root",
      input: "compact",
    },
  });

  assert.equal(result.status, 200);
  assert.equal(imagePressure.snapshot().active_recovery_trees, 0);
  clearResponseHistoryForTests();
});

test("compact preserves its first visual request and applies recovery only after timeout", async () => {
  clearResponseHistoryForTests();
  try {
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
    rememberResponseHistory(history, { id: "resp_compact_pressure_root", status: "completed", output: [] });
    const imagePressure = createResponsesImagePressureController();
    const historicalCounts = [];
    let upstreamCalls = 0;
    const responsesCompactFn = async (body, { currentInputStart, onUpstreamStart, signal }) => {
      upstreamCalls += 1;
      historicalCounts.push(responsesHistoricalImageStats(body.input, currentInputStart).historicalImages);
      onUpstreamStart();
      if (upstreamCalls === 1) {
        await new Promise((resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      }
      return Response.json({
        id: "resp_compact_pressure_recovered",
        object: "response.compaction",
        status: "completed",
        output: [{ type: "compaction", id: "cmp_pressure_recovered", encrypted_content: "state" }],
      });
    };
    const options = {
      imagePressure,
      responsesCompactFn,
      upstreamTimeoutMs: 5,
    };
    const request = {
      url: "/v1/responses/compact",
      body: {
        model: "gpt-5.6-sol",
        previous_response_id: "resp_compact_pressure_root",
        input: "compact",
      },
    };

    const first = await invokeAdapter(options, request);
    assert.equal(first.status, 504);
    assert.equal(upstreamCalls, 1);
    assert.equal(imagePressure.snapshot().active_recovery_trees, 1);

    const second = await invokeAdapter({ ...options, upstreamTimeoutMs: 1000 }, request);
    assert.equal(second.status, 200);
    assert.deepEqual(historicalCounts, [36, 8]);
    assert.equal(imagePressure.snapshot().active_recovery_trees, 0);
  } finally {
    clearResponseHistoryForTests();
  }
});

test("compact preserves an upstream 408 and applies visual recovery on the next request", async () => {
  clearResponseHistoryForTests();
  try {
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
    rememberResponseHistory(history, { id: "resp_compact_408_root", status: "completed", output: [] });
    const imagePressure = createResponsesImagePressureController();
    const historicalCounts = [];
    let upstreamCalls = 0;
    const responsesCompactFn = async (body, { currentInputStart }) => {
      upstreamCalls += 1;
      historicalCounts.push(responsesHistoricalImageStats(body.input, currentInputStart).historicalImages);
      if (upstreamCalls === 1) {
        return new Response(JSON.stringify({ error: { code: "user_request_timeout" } }), {
          status: 408,
          headers: { "Content-Type": "application/json" },
        });
      }
      return Response.json({
        id: "resp_compact_408_recovered",
        object: "response.compaction",
        status: "completed",
        output: [{ type: "compaction", id: "cmp_408_recovered", encrypted_content: "state" }],
      });
    };
    const options = { imagePressure, responsesCompactFn };
    const request = {
      url: "/v1/responses/compact",
      body: {
        model: "gpt-5.6-sol",
        previous_response_id: "resp_compact_408_root",
        input: "compact",
      },
    };

    const first = await invokeAdapter(options, request);
    assert.equal(first.status, 408);
    assert.deepEqual(JSON.parse(first.text), { error: { code: "user_request_timeout" } });
    assert.equal(imagePressure.snapshot().active_recovery_trees, 1);

    const second = await invokeAdapter(options, request);
    assert.equal(second.status, 200);
    assert.deepEqual(historicalCounts, [36, 8]);
  } finally {
    clearResponseHistoryForTests();
  }
});

test("HTTP compact maps a catalog-approved priority tier before the upstream request", async () => {
  let upstreamBody;
  const response = await invokeAdapter({
    codexModelRegistry: { models: { data: [{
      id: "gpt-5.6-sol-fast",
      vendor: "OpenAI",
      policy: { state: "enabled" },
      model_picker_enabled: true,
      supported_endpoints: ["/responses", "ws:/responses"],
    }] } },
    responsesCompactFn: async (body) => {
      upstreamBody = structuredClone(body);
      return Response.json({
        id: "resp_fast_compact",
        object: "response.compaction",
        status: "completed",
        output: [{ type: "compaction", id: "cmp_fast", encrypted_content: "fast-state" }],
      });
    },
  }, {
    url: "/v1/responses/compact",
    body: { model: "gpt-5.6-sol", service_tier: "priority", input: "compact" },
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamBody.model, "gpt-5.6-sol-fast");
  assert.equal(Object.hasOwn(upstreamBody, "service_tier"), false);
});

test("HTTP compact route honors the Codex auto-review model override", async () => {
  let upstreamBody;
  const response = await invokeAdapter({
    openAIModelEnv: { CCDX_AUTO_REVIEW_MODEL: "gpt-5.6-sol" },
    responsesCompactFn: async (body) => {
      upstreamBody = body;
      return new Response(JSON.stringify({
        id: "resp_compact",
        status: "completed",
        output: [{ type: "compaction", id: "cmp_review", encrypted_content: "review-state" }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  }, {
    url: "/v1/responses/compact",
    body: { model: "codex-auto-review", input: "compact review context" },
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamBody.model, "gpt-5.6-sol");
  assert.equal(upstreamBody.stream, false);
  assert.deepEqual(upstreamBody.input.at(-1), { type: "compaction_trigger" });
});
