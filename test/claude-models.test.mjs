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

test("Desktop compatibility routes are stable, opaque and retain real display identities", () => {
  const models = [model("deepseek-v4.1-flash-1017"), model("qwen/large"), model("claude-sonnet-4.6"), model("claude-3-7-sonnet-20250219")];
  const entries = claudeModelEntries(models, { desktopAliases: true });
  for (let index = 0; index < 2; index++) {
    assert.match(entries[index].name, /^ccdx\/claude-compatible-\d+$/);
    assert.equal(entries[index].labelOverride, models[index].id);
    assert.equal(resolveClaudeModel(models, entries[index].name, { desktopAliases: true }), models[index]);
    assert.equal(resolveClaudeModel(models, entries[index].name), undefined, "Code does not accept App-only aliases");
    assert.equal(resolveClaudeModel(models, models[index].id, { desktopAliases: true }), models[index]);
  }
  assert.deepEqual(entries.slice(2).map(entry => entry.name), ["claude-sonnet-4-6", "claude-3-7-sonnet-20250219"]);
  assert.equal(entries[2].labelOverride, undefined);
  assert.deepEqual(claudeModelEntries([model("new-model"), ...models.toReversed()], { desktopAliases: true }).slice(1).toReversed(), entries);
  assert.equal(resolveClaudeModel(models, "ccdx/claude-compatible-0", { desktopAliases: true }), undefined);
  assert.throws(() => claudeModelEntries([...models, model(entries[0].name)], { desktopAliases: true }), { code: "claude_model_alias_collision" });
});
