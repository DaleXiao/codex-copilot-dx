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
  assert.equal(sanitized.body.tool_choice, undefined);
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
