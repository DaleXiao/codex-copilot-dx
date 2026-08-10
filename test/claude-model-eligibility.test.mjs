import { test } from "node:test";
import assert from "node:assert/strict";
import { selectableCopilotModels } from "../src/cli-models.mjs";
import { selectCompatibilityModels } from "../src/doctor.mjs";
import {
  claudeDesktopModelDefsFromCopilotModels,
  isClaudeCopilotCatalogEntry,
  isClaudeCopilotModel,
} from "../src/models.mjs";
import { createPmStudioModelRouter } from "../src/profile-routing.mjs";

const cases = [
  {
    name: "enabled chat model",
    eligible: true,
    model: {
      id: "claude-enabled",
      vendor: "Anthropic",
      model_picker_enabled: true,
      policy: { state: "enabled" },
      supported_endpoints: ["/chat/completions", "/v1/messages"],
    },
  },
  {
    name: "picker and policy metadata omitted",
    eligible: true,
    model: {
      id: "claude-metadata-omitted",
      vendor: "Anthropic",
      supported_endpoints: ["/chat/completions"],
    },
  },
  {
    name: "Anthropic owned_by model with a non-Claude id",
    eligible: true,
    model: {
      id: "anthropic-catalog-id",
      owned_by: "Anthropic",
      supported_endpoints: ["/chat/completions"],
    },
  },
  {
    name: "Claude id with a conflicting explicit vendor",
    eligible: false,
    model: {
      id: "claude-conflicting-vendor",
      vendor: "OpenAI",
      supported_endpoints: ["/chat/completions"],
    },
  },
  {
    name: "picker explicitly disabled",
    eligible: false,
    model: {
      id: "claude-picker-disabled",
      vendor: "Anthropic",
      model_picker_enabled: false,
      supported_endpoints: ["/chat/completions"],
    },
  },
  {
    name: "policy explicitly disabled",
    eligible: false,
    model: {
      id: "claude-policy-disabled",
      vendor: "Anthropic",
      policy: { state: "disabled" },
      supported_endpoints: ["/chat/completions"],
    },
  },
  {
    name: "policy not enabled",
    eligible: false,
    model: {
      id: "claude-policy-unconfigured",
      vendor: "Anthropic",
      policy: { state: "unconfigured" },
      supported_endpoints: ["/chat/completions"],
    },
  },
  {
    name: "messages-only model",
    eligible: false,
    model: {
      id: "claude-messages-only",
      vendor: "Anthropic",
      supported_endpoints: ["/v1/messages"],
    },
  },
  {
    name: "non-Claude chat model",
    eligible: false,
    model: {
      id: "gpt-chat",
      vendor: "OpenAI",
      model_picker_enabled: true,
      policy: { state: "enabled" },
      supported_endpoints: ["/chat/completions"],
    },
  },
];

test("Claude Copilot eligibility has one cross-component decision matrix", () => {
  for (const entry of cases) {
    assert.equal(isClaudeCopilotModel(entry.model), entry.eligible, entry.name);
  }

  const catalog = { data: cases.map((entry) => entry.model) };
  const expectedIds = cases.filter((entry) => entry.eligible).map((entry) => entry.model.id);
  assert.deepEqual(
    claudeDesktopModelDefsFromCopilotModels(catalog).map((model) => model.id),
    expectedIds,
  );

  const router = createPmStudioModelRouter({
    getCatalog: () => catalog,
    isClaudeEnabled: () => true,
  });
  for (const entry of cases) {
    const expected = entry.eligible
      ? "claude"
      : (isClaudeCopilotCatalogEntry(entry.model) ? "unsupported_claude" : "enterprise");
    assert.equal(router.classify(entry.model.id), expected, entry.name);
  }

  const liveClaudeIds = selectableCopilotModels(catalog).models
    .filter(isClaudeCopilotCatalogEntry)
    .map((model) => model.id)
    .sort();
  assert.deepEqual(liveClaudeIds, [...expectedIds].sort());

  for (const entry of cases) {
    const selected = selectCompatibilityModels(
      { data: [{ id: "gpt-responses", model_picker_enabled: true, supported_endpoints: ["/responses"] }] },
      { claudeModels: { data: [entry.model] } },
    );
    assert.equal(selected.claudeModel, entry.eligible ? entry.model.id : "", entry.name);
  }
});
