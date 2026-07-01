import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claudeDesktopModelDefsFromCopilotModels,
  claudeDesktopModelIds,
  claudeDesktopModelsResponse,
  parseModelAliasEnv,
  resolveAnthropicModel,
} from "../src/models.mjs";

test("claudeDesktopModelIds: includes stable Claude Desktop aliases", () => {
  const ids = claudeDesktopModelIds({});
  assert.ok(ids.includes("claude-sonnet-5"));
  assert.ok(ids.includes("claude-sonnet-4.6"));
  assert.ok(ids.includes("claude-sonnet-4-6"));
});

test("claudeDesktopModelDefsFromCopilotModels: maps enabled Anthropic chat models", () => {
  const defs = claudeDesktopModelDefsFromCopilotModels({
    data: [
      {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        vendor: "Anthropic",
        model_picker_enabled: true,
        supported_endpoints: ["/v1/messages", "/chat/completions"],
        capabilities: { limits: { max_context_window_tokens: 1000000, max_output_tokens: 64000 } },
      },
      {
        id: "gemini-3.5-flash",
        name: "Gemini 3.5 Flash",
        vendor: "Google",
        model_picker_enabled: true,
        supported_endpoints: ["/chat/completions"],
      },
      {
        id: "claude-disabled",
        name: "Claude Disabled",
        vendor: "Anthropic",
        model_picker_enabled: false,
        supported_endpoints: ["/v1/messages"],
      },
    ],
  });

  assert.deepEqual(defs.map((model) => model.id), ["claude-sonnet-5"]);
  assert.equal(defs[0].displayName, "Claude Sonnet 5");
  assert.equal(defs[0].maxInputTokens, 1000000);
  assert.equal(defs[0].maxOutputTokens, 64000);
});

test("claudeDesktopModelDefsFromCopilotModels: keeps built-in dash aliases for available upstreams", () => {
  const defs = claudeDesktopModelDefsFromCopilotModels({
    data: [{
      id: "claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      vendor: "Anthropic",
      model_picker_enabled: true,
      supported_endpoints: ["/v1/messages"],
      capabilities: { limits: { max_context_window_tokens: 1000000, max_output_tokens: 64000 } },
    }],
  });

  assert.ok(defs.some((model) => model.id === "claude-sonnet-4-6"));
  assert.deepEqual(resolveAnthropicModel("claude-sonnet-4-6", {}, { modelDefs: defs }), {
    requestedModel: "claude-sonnet-4-6",
    upstreamModel: "claude-sonnet-4.6",
  });
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

test("claudeDesktopModelsResponse: supports runtime model defs", () => {
  const response = claudeDesktopModelsResponse({}, { modelDefs: [{
    id: "claude-sonnet-5",
    upstream: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    maxInputTokens: 1000000,
    maxOutputTokens: 64000,
  }] });

  assert.deepEqual(response.data.map((model) => model.id), ["claude-sonnet-5"]);
  assert.equal(response.data[0].display_name, "Claude Sonnet 5");
});
