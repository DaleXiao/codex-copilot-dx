import { test } from "node:test";
import assert from "node:assert/strict";
import { openCopilotResponse } from "../src/copilot-responses-compat.mjs";
import {
  applyCopilotResponsesRequestPolicies,
  sanitizeImageNamespaceCollisionRequest,
} from "../src/copilot-responses-policy.mjs";

test("collision cleanup removes a standard function choice only when its tool was removed", () => {
  const sanitized = sanitizeImageNamespaceCollisionRequest({
    body: {
      tools: [
        { type: "function", namespace: "image_gen.v2", name: "render" },
        { type: "function", name: "lookup" },
      ],
      tool_choice: { type: "function", name: "render" },
    },
  });

  assert.deepEqual(sanitized.body.tools, [{ type: "function", name: "lookup" }]);
  assert.equal(sanitized.body.tool_choice, "none");
});

test("initial Copilot policy removes public image tools without deleting same-named functions", () => {
  const body = {
    tools: [
      { type: "image_generation" },
      { type: "function", name: "image_generation" },
    ],
    tool_choice: { type: "function", name: "image_generation" },
  };

  assert.equal(applyCopilotResponsesRequestPolicies(body), true);
  assert.deepEqual(body.tools, [{ type: "function", name: "image_generation" }]);
  assert.deepEqual(body.tool_choice, { type: "function", name: "image_generation" });
});

test("Copilot policy filters positional declarations without moving items or widening selectors", () => {
  for (const type of ["additional_tools", "tool_search_output"]) {
    const safe = { type: "function", name: "lookup", parameters: { type: "object" } };
    const item = { type, id: "carrier-1", role: "developer", call_id: "search-1", execution: "client",
      tools: [{ type: "image_generation" }, safe] };
    const body = { input: [item], tool_choice: { type: "image_generation" } };
    assert.equal(applyCopilotResponsesRequestPolicies(body), true);
    assert.equal(body.input[0], item);
    assert.equal(item.tools[0], safe);
    assert.equal(item.id, "carrier-1");
    assert.equal(body.tools, undefined);
    assert.equal(body.tool_choice, "none");
    assert.equal(applyCopilotResponsesRequestPolicies(body), false);
  }
});

test("Copilot policy counts surviving declarations across carriers and preserves same-named client tools", () => {
  const body = { tools: [{ type: "image_generation", name: "image_generation" }],
    input: [{ type: "tool_search_output", tools: [{ type: "function", name: "image_generation" }] }],
    tool_choice: { type: "function", name: "image_generation" } };
  applyCopilotResponsesRequestPolicies(body);
  assert.equal(body.tools, undefined);
  assert.deepEqual(body.tool_choice, { type: "function", name: "image_generation" });
  body.tools = [{ type: "image_generation" }];
  body.tool_choice = "required";
  applyCopilotResponsesRequestPolicies(body);
  assert.equal(body.tool_choice, "required");
});

test("Copilot policy retains empty carrier arrays and filters only removed allowed-tools choices", () => {
  const body = { input: [{ type: "additional_tools", tools: [{ type: "image_generation" }] }],
    tools: [{ type: "function", name: "lookup" }],
    tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "image_generation" }, { type: "function", name: "lookup" }] } };
  applyCopilotResponsesRequestPolicies(body);
  assert.deepEqual(body.input[0].tools, []);
  assert.deepEqual(body.tool_choice, { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "lookup" }] });
  body.input[0].tools = [{ type: "image_generation" }];
  body.tool_choice.tools = [{ type: "image_generation" }];
  applyCopilotResponsesRequestPolicies(body);
  assert.equal(body.tool_choice, "none");
});

test("a no-op matching retry policy does not block a later applicable policy", async () => {
  const calls = [];
  const combinedError = JSON.stringify({
    error: {
      message: "Namespace image_gen collided. Encrypted function output content could not be decrypted or decoded.",
    },
  });
  const context = {
    body: {
      model: "gpt-5.6-sol",
      input: [
        { type: "reasoning", encrypted_content: "stale", summary: [] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    },
    currentInputStart: 0,
    historyInputItems: [],
    inputItems: [],
  };

  const opened = await openCopilotResponse(context, async (body) => {
    calls.push(structuredClone(body));
    return calls.length === 1
      ? new Response(combinedError, { status: 400 })
      : Response.json({ id: "resp_recovered", status: "completed", output: [] });
  });

  assert.equal(opened.resp.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(calls[1]).includes("encrypted_content"), false);
});

test("legacy responses-request deep imports retain the Copilot compatibility exports", async () => {
  const legacy = await import("../src/responses-request.mjs");
  for (const name of [
    "isEncryptedContentVerificationError",
    "isImageNamespaceCollisionError",
    "openCopilotResponse",
    "sanitizeImageNamespaceCollisionRequest",
  ]) {
    assert.equal(typeof legacy[name], "function", name);
  }
});
