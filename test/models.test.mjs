import { test } from "node:test";
import assert from "node:assert/strict";
import {
  codexAutoReviewModelStatus,
  gptModelIdsFromCopilotModels,
  responsesModelIdsFromCopilotModels,
  resolveCopilotPriorityTierModel,
  resolveOpenAIModel,
} from "../src/models.mjs";

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
