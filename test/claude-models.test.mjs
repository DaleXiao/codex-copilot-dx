import test from "node:test";
import assert from "node:assert/strict";
import { claudeClientModelId, claudeModelEntries, resolveClaudeModel } from "../src/claude-models.mjs";
import { modelReasoningEfforts, publicModelCatalog } from "../src/provider-metadata.mjs";

const model = (id, efforts) => ({ id, publisher: "Anthropic", supported_endpoints: ["/v1/messages"],
  capabilities: { supports: { reasoning_effort: efforts } } });

test("Claude identity mapping is exact and refuses ambiguous upstream catalogs", () => {
  const models = [model("claude-sonnet-123.42", ["low", "high"]), model("claude-haiku-99", undefined)];
  assert.equal(claudeClientModelId(models[0].id), "claude-sonnet-123-42");
  assert.equal(claudeClientModelId("custom-claude-sonnet-123.42"), "custom-claude-sonnet-123.42");
  assert.equal(resolveClaudeModel(models, "claude-sonnet-123-42"), models[0]);
  assert.equal(resolveClaudeModel(models, models[0].id), models[0]);
  assert.equal(resolveClaudeModel(models, "claude-opus-123-42"), undefined);
  assert.throws(() => claudeModelEntries([...models, model("claude-sonnet-123-42")]), { code: "claude_model_alias_collision" });
});

test("effort metadata remains model-bound and unknown values are not invented as caps", () => {
  for (const [efforts, cap] of [[["low", "high"], "high"], [["low", "medium"], "medium"], [["future"], undefined], [undefined, undefined]]) {
    const entry = claudeModelEntries([model("claude-opus-99.7", efforts)])[0];
    assert.equal(entry.maxEffort, cap);
  }
  assert.deepEqual(modelReasoningEfforts(model("claude-any", ["high", "future", "high", null, "bad\nvalue"])), ["high", "future"]);
  assert.equal(modelReasoningEfforts(model("claude-any", "high")), null);
  const raw = model("claude-any", ["future"]);raw.credential = "private";
  const exported = publicModelCatalog([raw]);
  assert.deepEqual(exported[0].reasoning_efforts, ["future"]);
  assert.doesNotMatch(JSON.stringify(exported), /credential|private/);
});
