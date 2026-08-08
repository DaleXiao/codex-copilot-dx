import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPmStudioModelRouter,
  profileRouting,
} from "../src/profile-routing.mjs";

function claudeModel(id = "claude-personal") {
  return {
    id,
    vendor: "Anthropic",
    model_picker_enabled: true,
    supported_endpoints: ["/chat/completions"],
  };
}

test("profileRouting preserves fail-closed dual-account routing", () => {
  assert.deepEqual(profileRouting(), { responses: "codex", messages: "codex" });
  assert.deepEqual(profileRouting({ claudeMode: "isolated" }), { responses: "codex", messages: "claude" });
  assert.deepEqual(profileRouting({ claudeConfigured: true }), { responses: "codex", messages: "claude" });
});

test("PM Studio model router memoizes catalog classification and invalidates on refresh", () => {
  let catalog = { data: [claudeModel(), { id: "gpt-enterprise" }] };
  let enabled = true;
  let catalogReads = 0;
  const router = createPmStudioModelRouter({
    getCatalog: () => {
      catalogReads += 1;
      return catalog;
    },
    isClaudeEnabled: () => enabled,
  });

  for (let index = 0; index < 1000; index += 1) {
    assert.equal(router.classify("claude-personal"), "claude");
  }
  assert.equal(router.classify("gpt-enterprise"), "enterprise");
  assert.deepEqual(router.allowedModels().map((model) => model.id), ["claude-personal"]);
  assert.equal(router.diagnostics().rebuilds, 1);
  assert.equal(catalogReads, 1002);

  enabled = false;
  assert.equal(router.classify("claude-personal"), "unsupported_claude");
  assert.equal(router.diagnostics().rebuilds, 2);

  enabled = true;
  catalog = { data: [claudeModel("claude-refreshed")] };
  assert.equal(router.classify("claude-refreshed"), "claude");
  assert.equal(router.classify("claude-personal"), "unsupported_claude");
  assert.equal(router.diagnostics().rebuilds, 3);
});
