import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cacheModelEndpoints, resetModelEndpointCacheForTests } from "../src/copilot.mjs";
import {
  clearResponseHistoryForTests,
  configureResponseHistoryForTests,
  responseHistoryStats,
} from "../src/response-history.mjs";
import { autoReviewModelPreference, autoReviewPreference, writeAutoReviewModel } from "../src/user-settings.mjs";
import { invokeAdapter } from "../test-support/adapter.mjs";

function jsonRequest(body, contentEncoding, headers = {}) {
  const req = Readable.from([body]);
  req.headers = { ...headers };
  if (contentEncoding) req.headers["content-encoding"] = contentEncoding;
  return req;
}

test("HTTP responses route maps Codex auto-review directly to Responses", async () => {
  let upstreamBody;
  let chatCalled = false;
  const response = await invokeAdapter({
    openAIModelEnv: {},
    responsesFn: async (body) => {
      upstreamBody = body;
      return new Response(JSON.stringify({ id: "resp_review", status: "completed", output: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    chatCompletionsFn: async () => {
      chatCalled = true;
      throw new Error("auto-review must not use Chat Completions");
    },
  }, {
    body: {
      model: "codex-auto-review",
      input: "Review this command",
      tools: [{ type: "function", name: "approve", parameters: { type: "object" } }],
      text: {
        format: {
          type: "json_schema",
          name: "review",
          schema: { type: "object", properties: { approved: { type: "boolean" } } },
        },
      },
    },
  });

  assert.equal(response.status, 200);
  assert.equal(chatCalled, false);
  assert.equal(upstreamBody.model, "gpt-6.1-sol");
  assert.deepEqual(upstreamBody.reasoning, { effort: "low" });
  assert.deepEqual(upstreamBody.tools, [
    { type: "function", name: "approve", parameters: { type: "object" } },
  ]);
  assert.equal(upstreamBody.text.format.name, "review");
});

test("native Responses preserve sealed main/subagent/reply items and Unicode across history continuation", async () => {
  clearResponseHistoryForTests();
  const sealed = (author, recipient) => ({ type: "agent_message", author, recipient, content: [
    { type: "input_text", text: "Message Type: FINAL_ANSWER\nPayload:\n" },
    { type: "encrypted_content", encrypted_content: "gAAAAAopaque==😀\ud800\u0000" },
  ] });
  const task = sealed("/root", "/root/worker");
  const reply = sealed("/root/worker", "/root");
  const sent = [];
  const options = { getCachedModelEndpointsFn: () => ["/responses"],
    responsesFn: async body => {
      sent.push(structuredClone(body));
      return Response.json({ id: `resp_sealed_${sent.length}`, status: "completed", output: [] });
    }, chatCompletionsFn: () => { throw Error("sealed items must not be lowered to Chat"); } };
  try {
    for (const body of [
      { model: "gpt-6.1-sol", input: "main starts" },
      { model: "gpt-6.1-sol", input: [task] },
      { model: "gpt-6.1-sol", previous_response_id: "resp_sealed_1", input: [reply] },
    ]) {
      const before = JSON.stringify(body);
      const result = await invokeAdapter(options, { body });
      assert.equal(result.status, 200, result.text);
      assert.equal(JSON.stringify(body), before);
    }
    assert.deepEqual(sent[1].input, [task]);
    assert.deepEqual(sent[2].input.at(-1), reply);
    assert.equal(sent.length, 3);
    assert.ok(JSON.stringify(sent[2]).includes("main starts"));
  } finally { clearResponseHistoryForTests(); }
});

test("positional tools stay native on a dual-endpoint model and remain isolated from image filtering", async () => {
  for (const type of ["additional_tools", "tool_search_output"]) {
    let sent;
    let calls = 0;
    const item = { type, id: "carrier-id", call_id: "search-id", role: "developer",
      tools: [{ type: "image_generation" }, { type: "function", name: "lookup", parameters: { type: "object" } }] };
    const response = await invokeAdapter({
      getCachedModelEndpointsFn: () => ["/responses", "/chat/completions"],
      responsesFn: async body => { calls += 1; sent = structuredClone(body); return Response.json({ id: "resp_carrier", status: "completed", output: [] }); },
      chatCompletionsFn: () => { throw Error("carrier must not be lowered to Chat"); },
    }, { body: { model: "gpt-6.1-sol", input: [item], tool_choice: { type: "image_generation" } } });
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    assert.equal(sent.input[0].id, "carrier-id");
    assert.deepEqual(sent.input[0].tools, [item.tools[1]]);
    assert.equal(sent.tool_choice, "none");
    const rejected = await invokeAdapter({ getCachedModelEndpointsFn: () => ["/chat/completions"],
      responsesFn: () => { throw Error("must not call"); }, chatCompletionsFn: () => { throw Error("must not call"); } },
    { body: { model: "gpt-chat-only", input: [item] } });
    assert.equal(rejected.status, 400);
  }
});

test("Auto Review defaults omitted reasoning to low without rewriting explicit efforts or foreground requests", async () => {
  for (const mode of ["json", "sse", "compact"]) {
    for (const model of ["codex-auto-review", "gpt-6.1-sol"]) {
      for (const reasoning of [undefined, { summary: "auto" }, { effort: "low", summary: "auto" }, { effort: "high", summary: "auto" }]) {
        let upstreamBody;
        let upstreamCalls = 0;
        const upstream = async (body) => {
          upstreamCalls += 1;
          upstreamBody = structuredClone(body);
          const completed = {
            id: "resp_review_effort", status: "completed",
            output: mode === "compact"
              ? [{ type: "compaction", id: "cmp_review_effort", encrypted_content: "review-state" }]
              : [],
          };
          return mode === "sse"
            ? new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`, {
              headers: { "Content-Type": "text/event-stream" },
            })
            : Response.json(completed);
        };
        const response = await invokeAdapter({
          openAIModelEnv: {},
          getCachedModelEndpointsFn: () => ["/responses"],
          responsesFn: upstream,
          responsesCompactFn: upstream,
          chatCompletionsFn: async () => { throw new Error("review must remain native Responses"); },
        }, {
          url: mode === "compact" ? "/v1/responses/compact" : "/v1/responses",
          body: { model, input: "review this command", stream: mode === "sse", ...(reasoning ? { reasoning } : {}) },
        });
        assert.equal(response.status, 200, `${mode} ${model} ${JSON.stringify(reasoning)}`);
        assert.equal(upstreamCalls, 1);
        assert.equal(upstreamBody.model, "gpt-6.1-sol");
        const expected = model === "codex-auto-review" && reasoning?.effort === undefined
          ? { ...reasoning, effort: "low" }
          : reasoning;
        assert.deepEqual(upstreamBody.reasoning, expected);
        if (mode === "sse") assert.match(response.text, /response.completed/);
      }
    }
  }
});

test("Auto Review saved effort is model-bound, hot-reloaded and isolated from foreground JSON/SSE/compact", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-review-effort-handler-"));
  const settings = { env: {}, home };
  try {
    for (const mode of ["json", "sse", "compact"]) {
      const sent = [];
      let env = {};
      let resolverCalls = 0;
      const upstream = async (body) => {
        sent.push(structuredClone(body));
        const completed = { id: "resp_review_effort_saved", status: "completed", output: mode === "compact"
          ? [{ type: "compaction", id: "cmp_review_effort_saved", encrypted_content: "review-state" }] : [] };
        return mode === "sse" ? new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        }) : Response.json(completed);
      };
      const options = {
        openAIModelEnv: env,
        getCachedModelEndpointsFn: () => ["/responses"],
        autoReviewModelResolver: () => { resolverCalls += 1; return autoReviewPreference({ env, home }); },
        responsesFn: upstream, responsesCompactFn: upstream,
      };
      const invoke = async (model = "codex-auto-review", effort = "low") => {
        const before = sent.length;
        const response = await invokeAdapter({ ...options, openAIModelEnv: env }, {
          url: mode === "compact" ? "/v1/responses/compact" : "/v1/responses",
          body: { model, input: "review", stream: mode === "sse", service_tier: "priority", reasoning: { effort, summary: "auto" } },
        });
        assert.equal(response.status, 200, response.text);
        assert.equal(sent.length, before + 1);
        return sent.at(-1);
      };
      writeAutoReviewModel("", { ...settings, reasoningEffort: "medium" });
      assert.deepEqual((await invoke()).reasoning, { effort: "medium", summary: "auto" });
      writeAutoReviewModel("", { ...settings, reasoningEffort: "high" });
      const high = await invoke();
      assert.equal(high.model, "gpt-6.1-sol");
      assert.deepEqual(high.reasoning, { effort: "high", summary: "auto" });
      assert.equal(Object.hasOwn(high, "service_tier"), false);
      const reads = resolverCalls;
      const foreground = await invoke("gpt-6.1-sol", "low");
      assert.deepEqual(foreground.reasoning, { effort: "low", summary: "auto" });
      assert.equal(resolverCalls, reads);
      env = { CCDX_AUTO_REVIEW_MODEL: "gpt-5.5" };
      const changedModel = await invoke();
      assert.equal(changedModel.model, "gpt-5.5");
      assert.equal(changedModel.reasoning.effort, "low");
      env = {};
      writeAutoReviewModel("", { ...settings, reasoningEffort: null });
      assert.equal((await invoke("codex-auto-review", "high")).reasoning.effort, "high");
      writeAutoReviewModel("gpt-5.5", { ...settings, reasoningEffort: "none" });
      assert.equal((await invoke()).reasoning.effort, "none");
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("HTTP Responses maps Codex App priority tier to a catalog-approved fast model for JSON and SSE", async () => {
  const codexModelRegistry = { models: { data: [{
    id: "gpt-5.6-sol-fast",
    vendor: "OpenAI",
    policy: { state: "enabled" },
    model_picker_enabled: true,
    supported_endpoints: ["/responses", "ws:/responses"],
  }] } };

  for (const stream of [false, true]) {
    let upstreamBody;
    const response = await invokeAdapter({
      codexModelRegistry,
      responsesFn: async (body) => {
        upstreamBody = structuredClone(body);
        const completed = {
          id: `resp_fast_${stream}`,
          object: "response",
          status: "completed",
          model: "gpt-5.6-sol",
          output: [],
        };
        if (!stream) return Response.json(completed);
        const event = { type: "response.completed", response: completed };
        return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    }, {
      body: { model: "gpt-5.6-sol", service_tier: "priority", stream, input: "hello" },
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamBody.model, "gpt-5.6-sol-fast");
    assert.equal(Object.hasOwn(upstreamBody, "service_tier"), false);
  }
});

test("HTTP Responses preserves service tiers when a fast mapping is not explicitly eligible", async () => {
  for (const { serviceTier, modelRegistry } of [
    { serviceTier: "default", modelRegistry: { models: { data: [] } } },
    { serviceTier: "ultrafast", modelRegistry: { models: { data: [] } } },
    { serviceTier: "priority", modelRegistry: { models: { data: [] } } },
  ]) {
    let upstreamBody;
    const response = await invokeAdapter({
      codexModelRegistry: modelRegistry,
      responsesFn: async (body) => {
        upstreamBody = structuredClone(body);
        return Response.json({ id: `resp_${serviceTier}`, status: "completed", output: [] });
      },
    }, {
      body: { model: "gpt-5.6-sol", service_tier: serviceTier, input: "hello" },
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamBody.model, "gpt-5.6-sol");
    assert.equal(upstreamBody.service_tier, serviceTier);
  }
});

test("GPT-6 drops unsupported inherited priority tiers without changing other requests", async () => {
  for (const model of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) for (const { compact, stream } of [
    { compact: false, stream: false }, { compact: false, stream: true }, { compact: true, stream: false },
  ]) {
    let upstreamBody;
    const upstream = async (body) => {
      upstreamBody = structuredClone(body);
      if (compact) {
        return Response.json({
          id: "resp_gpt6_compact",
          object: "response.compaction",
          status: "completed",
          output: [{ type: "compaction", id: "cmp_gpt6", encrypted_content: "gpt6-state" }],
        });
      }
      const completed = { id: "resp_gpt6", object: "response", status: "completed", output: [] };
      if (!stream) return Response.json(completed);
      return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    const response = await invokeAdapter({
      getCachedModelEndpointsFn: () => ["/responses"],
      ...(compact ? { responsesCompactFn: upstream } : { responsesFn: upstream }),
    }, {
      url: compact ? "/v1/responses/compact" : "/v1/responses",
      body: { model, service_tier: "priority", stream, input: "hello" },
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamBody.model, model);
    assert.equal(Object.hasOwn(upstreamBody, "service_tier"), false);
  }

  let defaultTierBody;
  await invokeAdapter({
    getCachedModelEndpointsFn: () => ["/responses"],
    responsesFn: async (body) => {
      defaultTierBody = structuredClone(body);
      return Response.json({ id: "resp_gpt6_default", status: "completed", output: [] });
    },
  }, {
    body: { model: "gpt-6-astra", service_tier: "default", input: "hello" },
  });
  assert.equal(defaultTierBody.service_tier, "default");
});

test("GPT-6 priority tier uses an exact eligible fast model when advertised", async () => {
  let upstreamBody;
  const response = await invokeAdapter({
    codexModelRegistry: { models: { data: [{
      id: "gpt-6-sol-fast", vendor: "OpenAI", policy: { state: "enabled" },
      model_picker_enabled: true, supported_endpoints: ["/responses"],
    }] } },
    getCachedModelEndpointsFn: () => ["/responses"],
    responsesFn: async (body) => {
      upstreamBody = structuredClone(body);
      return Response.json({ id: "resp_gpt6_fast", status: "completed", output: [] });
    },
  }, { body: { model: "gpt-6-sol", service_tier: "priority", input: "hello" } });
  assert.equal(response.status, 200);
  assert.equal(upstreamBody.model, "gpt-6-sol-fast");
  assert.equal(Object.hasOwn(upstreamBody, "service_tier"), false);
});

test("direct fast requests are not rewritten by the priority-tier resolver", async () => {
  const eligibleRegistry = { models: { data: [{
    id: "gpt-5.6-sol-fast",
    vendor: "OpenAI",
    policy: { state: "enabled" },
    model_picker_enabled: true,
    supported_endpoints: ["/responses", "ws:/responses"],
  }] } };
  let upstreamBody;
  const response = await invokeAdapter({
    codexModelRegistry: eligibleRegistry,
    getCachedModelEndpointsFn: () => ["/responses"],
    responsesFn: async (body) => {
      upstreamBody = structuredClone(body);
      return Response.json({ id: "resp_direct_fast", status: "completed", output: [] });
    },
  }, {
    body: { model: "gpt-5.6-sol-fast", service_tier: "priority", input: "hello" },
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamBody.model, "gpt-5.6-sol-fast");
  assert.equal(upstreamBody.service_tier, "priority");
});

test("Auto Review drops inherited priority tiers without applying the Fast model mapping", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-adapter-auto-review-tier-"));
  const savedEnv = {};
  writeAutoReviewModel("gpt-5.6-sol", { env: savedEnv, home });
  const eligibleRegistry = { models: { data: [{
    id: "gpt-5.6-sol-fast",
    vendor: "OpenAI",
    policy: { state: "enabled" },
    model_picker_enabled: true,
    supported_endpoints: ["/responses", "ws:/responses"],
  }] } };
  const modelCases = [
    { name: "default", options: { openAIModelEnv: {} }, expectedModel: "gpt-6.1-sol" },
    {
      name: "saved",
      options: {
        openAIModelEnv: savedEnv,
        autoReviewModelResolver: () => autoReviewModelPreference({ env: savedEnv, home }).model,
      },
      expectedModel: "gpt-5.6-sol",
    },
    {
      name: "environment",
      options: { openAIModelEnv: { CCDX_AUTO_REVIEW_MODEL: "gpt-5.6-sol" } },
      expectedModel: "gpt-5.6-sol",
    },
  ];

  for (const { name, options, expectedModel } of modelCases) {
    for (const compact of [false, true]) {
      let upstreamBody;
      const upstream = async (body) => {
        upstreamBody = structuredClone(body);
        if (!compact) return Response.json({ id: `resp_review_${name}`, status: "completed", output: [] });
        return Response.json({
          id: `resp_review_${name}_compact`,
          object: "response.compaction",
          status: "completed",
          output: [{ type: "compaction", id: `cmp_review_${name}`, encrypted_content: "review-state" }],
        });
      };
      const response = await invokeAdapter({
        ...options,
        codexModelRegistry: eligibleRegistry,
        ...(compact ? { responsesCompactFn: upstream } : { responsesFn: upstream }),
      }, {
        url: compact ? "/v1/responses/compact" : "/v1/responses",
        body: { model: "codex-auto-review", service_tier: "priority", input: "review" },
      });

      assert.equal(response.status, 200, `${name} ${compact ? "compact" : "responses"}`);
      assert.equal(upstreamBody.model, expectedModel, `${name} ${compact ? "compact" : "responses"}`);
      assert.equal(Object.hasOwn(upstreamBody, "service_tier"), false, `${name} ${compact ? "compact" : "responses"}`);
      assert.deepEqual(upstreamBody.reasoning, { effort: "low" });
    }
  }
});

test("priority-tier model mapping sanitizes encrypted history across the effective model boundary", async () => {
  clearResponseHistoryForTests();
  configureResponseHistoryForTests({ maxBytes: 1024 * 1024, maxEntries: 1 });
  const codexModelRegistry = { models: { data: [{
    id: "gpt-5.6-sol-fast",
    vendor: "OpenAI",
    policy: { state: "enabled" },
    model_picker_enabled: true,
    supported_endpoints: ["/responses", "ws:/responses"],
  }] } };
  try {
    const root = await invokeAdapter({
      codexModelRegistry,
      responsesFn: async () => Response.json({
        id: "resp_fast_affinity_root",
        status: "completed",
        output: [
          { type: "reasoning", id: "rs_fast", encrypted_content: "standard-cipher", summary: [] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible standard history" }] },
        ],
      }),
    }, {
      body: { model: "gpt-5.6-sol", input: "start" },
    });
    assert.equal(root.status, 200);

    let upstreamBody;
    const continuation = await invokeAdapter({
      codexModelRegistry,
      responsesFn: async (body) => {
        upstreamBody = structuredClone(body);
        return Response.json({ id: "resp_fast_affinity_child", status: "completed", output: [] });
      },
    }, {
      body: {
        model: "gpt-5.6-sol",
        service_tier: "priority",
        previous_response_id: "resp_fast_affinity_root",
        input: "continue fast",
      },
    });

    assert.equal(continuation.status, 200);
    assert.equal(upstreamBody.model, "gpt-5.6-sol-fast");
    assert.equal(JSON.stringify(upstreamBody).includes("encrypted_content"), false);
    assert.equal(JSON.stringify(upstreamBody).includes("visible standard history"), true);
    assert.equal(JSON.stringify(upstreamBody).includes("continue fast"), true);
    assert.equal(responseHistoryStats().entries, 1);

    const replay = await invokeAdapter({
      codexModelRegistry,
      responsesFn: async () => Response.json({ id: "resp_fast_affinity_replay", status: "completed", output: [] }),
    }, {
      body: {
        model: "gpt-5.6-sol",
        service_tier: "priority",
        previous_response_id: "resp_fast_affinity_child",
        input: "replay fast",
      },
    });
    assert.equal(replay.status, 200);
  } finally {
    clearResponseHistoryForTests();
  }
});

test("same priority tier preserves fast encrypted history while switching back to default sanitizes it", async () => {
  clearResponseHistoryForTests();
  const codexModelRegistry = { models: { data: [{
    id: "gpt-5.6-sol-fast",
    vendor: "OpenAI",
    policy: { state: "enabled" },
    model_picker_enabled: true,
    supported_endpoints: ["/responses", "ws:/responses"],
  }] } };
  try {
    const root = await invokeAdapter({
      codexModelRegistry,
      responsesFn: async () => Response.json({
        id: "resp_fast_same_root",
        status: "completed",
        model: "gpt-5.6-sol",
        output: [
          { type: "reasoning", id: "rs_fast_same", encrypted_content: "fast-cipher", summary: [] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible fast history" }] },
        ],
      }),
    }, {
      body: { model: "gpt-5.6-sol", service_tier: "priority", input: "start fast" },
    });
    assert.equal(root.status, 200);

    let sameTierBody;
    const sameTier = await invokeAdapter({
      codexModelRegistry,
      responsesFn: async (body) => {
        sameTierBody = structuredClone(body);
        return Response.json({ id: "resp_fast_same_child", status: "completed", output: [] });
      },
    }, {
      body: {
        model: "gpt-5.6-sol",
        service_tier: "priority",
        previous_response_id: "resp_fast_same_root",
        input: "continue fast",
      },
    });
    assert.equal(sameTier.status, 200);
    assert.equal(JSON.stringify(sameTierBody).includes("fast-cipher"), true);

    let defaultTierBody;
    const defaultTier = await invokeAdapter({
      codexModelRegistry,
      responsesFn: async (body) => {
        defaultTierBody = structuredClone(body);
        return Response.json({ id: "resp_fast_default_child", status: "completed", output: [] });
      },
    }, {
      body: {
        model: "gpt-5.6-sol",
        service_tier: "default",
        previous_response_id: "resp_fast_same_root",
        input: "continue default",
      },
    });
    assert.equal(defaultTier.status, 200);
    assert.equal(JSON.stringify(defaultTierBody).includes("encrypted_content"), false);
    assert.equal(JSON.stringify(defaultTierBody).includes("visible fast history"), true);
    assert.equal(JSON.stringify(defaultTierBody).includes("continue default"), true);
  } finally {
    clearResponseHistoryForTests();
  }
});

test("HTTP responses route resolves saved Auto Review model on every request", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-adapter-auto-review-"));
  const env = {};
  writeAutoReviewModel("gpt-5.6-luna", { env, home });
  const upstreamModels = [];
  const options = {
    openAIModelEnv: env,
    autoReviewModelResolver: () => autoReviewModelPreference({ env, home }).model,
    responsesFn: async (body) => {
      upstreamModels.push(body.model);
      return new Response(JSON.stringify({ id: "resp_review_dynamic", status: "completed", output: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };

  await invokeAdapter(options, { body: { model: "codex-auto-review", input: "first" } });
  writeAutoReviewModel("gpt-5.6-terra", { env, home });
  await invokeAdapter(options, { body: { model: "codex-auto-review", input: "second" } });

  assert.deepEqual(upstreamModels, ["gpt-5.6-luna", "gpt-5.6-terra"]);
});

test("HTTP Responses routes custom tool protocol to native Responses when endpoint metadata allows it", async () => {
  resetModelEndpointCacheForTests();
  cacheModelEndpoints({
    data: [{ id: "gpt-dual-custom", supported_endpoints: ["/responses", "/chat/completions"] }],
  });
  let upstreamBody;
  let chatCalls = 0;
  let response;
  try {
    response = await invokeAdapter({
      responsesFn: async (body) => {
        upstreamBody = body;
        return new Response(JSON.stringify({ id: "resp_custom_native", status: "completed", output: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      chatCompletionsFn: async () => {
        chatCalls += 1;
        throw new Error("custom tools must not use Chat Completions");
      },
    }, {
      body: {
        model: "gpt-dual-custom",
        stream: false,
        tools: [{ type: "custom", name: "shell", description: "Run shell input" }],
        input: [
          { type: "custom_tool_call", call_id: "call_custom", name: "shell", input: "pwd" },
          ...Array.from({ length: 3 }, (_, index) => ({
            type: "custom_tool_call_output",
            call_id: `call_custom_${index}`,
            output: "x".repeat(2000),
          })),
          { type: "function_call_output", call_id: "call_function", output: "y".repeat(2000) },
        ],
      },
    });
  } finally {
    resetModelEndpointCacheForTests();
  }

  assert.equal(response.status, 200);
  assert.equal(chatCalls, 0);
  assert.deepEqual(upstreamBody.input.map((item) => item.type), [
    "custom_tool_call",
    "custom_tool_call_output",
    "custom_tool_call_output",
    "custom_tool_call_output",
    "function_call_output",
  ]);
  assert.equal(upstreamBody.tools[0].type, "custom");
});

test("HTTP Responses rejects custom tool protocol before upstream when Responses support is unconfirmed", async () => {
  resetModelEndpointCacheForTests();
  cacheModelEndpoints({
    data: [{ id: "gpt-chat-custom", supported_endpoints: ["/chat/completions"] }],
  });
  let upstreamCalls = 0;
  let response;
  try {
    response = await invokeAdapter({
      responsesFn: async () => {
        upstreamCalls += 1;
        return new Response("{}", { status: 200 });
      },
      chatCompletionsFn: async () => {
        upstreamCalls += 1;
        return new Response("{}", { status: 200 });
      },
    }, {
      body: {
        model: "gpt-chat-custom",
        input: [{ type: "custom_tool_call_output", call_id: "call_custom", output: "/tmp" }],
      },
    });
  } finally {
    resetModelEndpointCacheForTests();
  }

  const error = JSON.parse(response.text).error;
  assert.equal(response.status, 400);
  assert.equal(error.code, "ccdx_custom_tools_require_responses");
  assert.equal(error.model, "gpt-chat-custom");
  assert.equal(upstreamCalls, 0);
});
