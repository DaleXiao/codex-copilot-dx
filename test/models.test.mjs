import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claudeDesktopModelIds,
  claudeDesktopModelsResponse,
  parseModelAliasEnv,
  resolveAnthropicModel,
} from "../src/models.mjs";

test("claudeDesktopModelIds: includes stable Claude Desktop aliases", () => {
  const ids = claudeDesktopModelIds({});
  assert.ok(ids.includes("claude-sonnet-4.6"));
  assert.ok(ids.includes("claude-sonnet-4-6"));
});

test("resolveAnthropicModel: maps dash alias to upstream dot model", () => {
  assert.deepEqual(resolveAnthropicModel("claude-sonnet-4-6", {}), {
    requestedModel: "claude-sonnet-4-6",
    upstreamModel: "claude-sonnet-4.6",
  });
  assert.deepEqual(resolveAnthropicModel("custom-model", {}), {
    requestedModel: "custom-model",
    upstreamModel: "custom-model",
  });
});

test("parseModelAliasEnv: supports comma-separated alias mappings", () => {
  assert.deepEqual(parseModelAliasEnv("desk-a=up-a, desk-b = up-b").map((entry) => [entry.id, entry.upstream]), [
    ["desk-a", "up-a"],
    ["desk-b", "up-b"],
  ]);
});

test("claudeDesktopModelsResponse: returns Anthropic-style model objects", () => {
  const response = claudeDesktopModelsResponse({ CCDX_CLAUDE_MODEL_ALIASES: "desk=upstream" });
  assert.deepEqual(response.data.map((model) => model.id), ["desk"]);
  assert.equal(response.data[0].type, "model");
  assert.equal(typeof response.data[0].display_name, "string");
  assert.equal(typeof response.data[0].max_input_tokens, "number");
});
