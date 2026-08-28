import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claudeDesktopModelDefsFromCopilotModels,
  claudeDesktopModelIds,
  claudeDesktopModelsResponse,
  codexAutoReviewModelStatus,
  gptModelIdsFromCopilotModels,
  parseModelAliasEnv,
  responsesModelIdsFromCopilotModels,
  resolveAnthropicModel,
  resolveCopilotPriorityTierModel,
  resolveOpenAIModel,
} from "../src/models.mjs";

test("claudeDesktopModelIds: includes only visible Claude Desktop models", () => {
  const ids = claudeDesktopModelIds({});
  assert.ok(ids.includes("claude-sonnet-5"));
  assert.ok(ids.includes("claude-sonnet-4.6"));
  assert.ok(!ids.includes("claude-sonnet-4-6"));
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

test("gptModelIdsFromCopilotModels: maps enabled GPT models", () => {
  const ids = gptModelIdsFromCopilotModels({
    data: [
      { id: "gpt-5.5", model_picker_enabled: true, supported_endpoints: ["/responses"] },
      { id: "gpt-5.4", model_picker_enabled: true, supported_endpoints: ["/chat/completions"] },
      { id: "gpt-disabled", model_picker_enabled: false, supported_endpoints: ["/responses"] },
      { id: "claude-sonnet-5", vendor: "Anthropic", model_picker_enabled: true, supported_endpoints: ["/v1/messages"] },
    ],
  });

  assert.deepEqual(ids, ["gpt-5.5", "gpt-5.4"]);
});

test("responsesModelIdsFromCopilotModels: exposes only selectable Responses targets", () => {
  assert.deepEqual(responsesModelIdsFromCopilotModels({ data: [
    { id: "gpt-5.5", supported_endpoints: ["/responses"] },
    { id: "gpt-5.6-sol", supported_endpoints: ["/v1/responses", "/chat/completions"] },
    { id: "gpt-chat", supported_endpoints: ["/chat/completions"] },
    { id: "hidden", model_picker_enabled: false, supported_endpoints: ["/responses"] },
    { id: "codex-auto-review", supported_endpoints: ["/responses"] },
    { id: "bad\u001bmodel", supported_endpoints: ["/responses"] },
  ] }), ["gpt-5.5", "gpt-5.6-sol"]);
});

test("resolveCopilotPriorityTierModel: maps only an explicitly enabled OpenAI Responses fast model", () => {
  const eligible = {
    id: "gpt-5.6-sol-fast",
    vendor: "OpenAI",
    policy: { state: "enabled" },
    model_picker_enabled: true,
    supported_endpoints: ["/responses", "ws:/responses"],
  };
  assert.equal(resolveCopilotPriorityTierModel("gpt-5.6-sol", "priority", { data: [eligible] }), "gpt-5.6-sol-fast");
  assert.equal(resolveCopilotPriorityTierModel("gpt-5.6-sol", "default", { data: [eligible] }), null);
  assert.equal(resolveCopilotPriorityTierModel("gpt-5.6-sol", "ultrafast", { data: [eligible] }), null);
  assert.equal(resolveCopilotPriorityTierModel("gpt-5.6-sol-fast", "priority", { data: [eligible] }), null);
  assert.equal(resolveCopilotPriorityTierModel("gpt-future", "priority", { data: [{ ...eligible, id: "gpt-future-fast" }] }), null);
  assert.equal(resolveCopilotPriorityTierModel("gpt-5.6-sol", "priority", { data: [] }), null);

  for (const ineligible of [
    { ...eligible, vendor: "Azure OpenAI" },
    { ...eligible, policy: { state: "disabled" } },
    { ...eligible, model_picker_enabled: false },
    { ...eligible, supported_endpoints: ["/responses", "/chat/completions"] },
  ]) {
    assert.equal(resolveCopilotPriorityTierModel("gpt-5.6-sol", "priority", [ineligible]), null);
  }
});

test("claudeDesktopModelDefsFromCopilotModels: does not expose dash aliases", () => {
  const defs = claudeDesktopModelDefsFromCopilotModels({
    data: [{
      id: "claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      vendor: "Anthropic",
      model_picker_enabled: true,
      supported_endpoints: ["/chat/completions"],
      capabilities: { limits: { max_context_window_tokens: 1000000, max_output_tokens: 64000 } },
    }],
  });

  assert.deepEqual(defs.map((model) => model.id), ["claude-sonnet-4.6"]);
});

test("resolveAnthropicModel: keeps dash aliases internal for runtime models", () => {
  const defs = [{
    id: "claude-sonnet-4.6",
    upstream: "claude-sonnet-4.6",
    displayName: "Claude Sonnet 4.6",
  }];

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

test("resolveOpenAIModel: maps only the Codex auto-review model", () => {
  assert.deepEqual(resolveOpenAIModel("codex-auto-review", {}), {
    requestedModel: "codex-auto-review",
    upstreamModel: "gpt-5.5",
  });
  assert.deepEqual(resolveOpenAIModel("codex-auto-review", { CCDX_AUTO_REVIEW_MODEL: " gpt-5.6-sol " }), {
    requestedModel: "codex-auto-review",
    upstreamModel: "gpt-5.6-sol",
  });
  assert.deepEqual(resolveOpenAIModel("codex-auto-review", {}, { autoReviewModel: "gpt-5.6-terra" }), {
    requestedModel: "codex-auto-review",
    upstreamModel: "gpt-5.6-terra",
  });
  assert.deepEqual(resolveOpenAIModel("codex-auto-review", { CCDX_AUTO_REVIEW_MODEL: "gpt-5.6-sol" }, { autoReviewModel: "gpt-5.6-terra" }), {
    requestedModel: "codex-auto-review",
    upstreamModel: "gpt-5.6-sol",
  });
  assert.deepEqual(resolveOpenAIModel("custom-model", { CCDX_AUTO_REVIEW_MODEL: "gpt-5.6-sol" }), {
    requestedModel: "custom-model",
    upstreamModel: "custom-model",
  });
});

test("codexAutoReviewModelStatus: validates the configured Responses target", () => {
  const models = { data: [
    { id: "gpt-5.5", supported_endpoints: ["/responses"] },
    { id: "gpt-chat", supported_endpoints: ["/chat/completions"] },
  ] };

  assert.deepEqual(codexAutoReviewModelStatus(models, {}), {
    available: true,
    upstreamModel: "gpt-5.5",
    reason: "",
  });
  assert.deepEqual(codexAutoReviewModelStatus(models, { CCDX_AUTO_REVIEW_MODEL: "gpt-chat" }), {
    available: false,
    upstreamModel: "gpt-chat",
    reason: "model does not advertise a Responses endpoint",
  });
  assert.deepEqual(codexAutoReviewModelStatus(models, { CCDX_AUTO_REVIEW_MODEL: "gpt-missing" }), {
    available: false,
    upstreamModel: "gpt-missing",
    reason: "model is not advertised",
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
