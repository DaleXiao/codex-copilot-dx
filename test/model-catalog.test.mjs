import test from "node:test";
import assert from "node:assert/strict";
import { normalizeModelList, uniqueModelEntries } from "../src/model-catalog.mjs";
import { publicModelCatalog } from "../src/provider-metadata.mjs";
import { publicCopilotModelCatalog, selectableCopilotModels } from "../src/live-models.mjs";

test("single-source catalogs keep first order, fill missing nested metadata and preserve explicit values", () => {
  const list = { object: "list", data: [
    { id: "gpt-one", name: "", model_picker_enabled: false, supported_endpoints: ["/responses"], capabilities: { supports: { reasoning_effort: [], vision: false }, limits: { max_output_tokens: 100 } } },
    { id: "gpt-two", supported_endpoints: [] },
    { id: "gpt-one", name: "Complete name", model_picker_enabled: true, supported_endpoints: ["/chat/completions"], capabilities: { supports: { reasoning_effort: ["high"], vision: true }, limits: { max_context_window_tokens: 1000000, max_output_tokens: 200 } } },
    { id: "gpt-two", supported_endpoints: ["/responses"] }, { id: "gpt-three" },
  ] };
  const original = structuredClone(list), result = normalizeModelList(list);
  assert.deepEqual(list, original);assert.deepEqual(result.data.map(model => model.id), ["gpt-one", "gpt-two", "gpt-three"]);
  assert.equal(result.object, "list");assert.equal(result.data[0].name, "Complete name");assert.equal(result.data[0].model_picker_enabled, false);
  assert.deepEqual(result.data[0].supported_endpoints, ["/responses"]);assert.deepEqual(result.data[1].supported_endpoints, []);
  assert.deepEqual(result.data[0].capabilities.supports, { reasoning_effort: [], vision: false });
  assert.deepEqual(result.data[0].capabilities.limits, { max_output_tokens: 100, max_context_window_tokens: 1000000 });
  assert.equal(normalizeModelList(result), result);assert.equal(uniqueModelEntries(result.data), result.data);
});

test("selection and public catalog use the same completed model and never combine separate sources", () => {
  const first = { id: "gpt-shared", model_picker_enabled: true, vendor: "OpenAI" };
  const primary = { data: [first, { id: first.id, name: "Primary model", supported_endpoints: ["/responses"], capabilities: { limits: { max_context_window_tokens: 200000 }, supports: { reasoning_effort: ["low", "high"] } } }] };
  const other = { data: [{ id: first.id, name: "Other model", supported_endpoints: ["/chat/completions"], model_picker_enabled: false }] };
  assert.deepEqual(selectableCopilotModels(primary).models.map(model => model.id), [first.id]);
  const visible = publicCopilotModelCatalog(primary);assert.equal(visible.length, 1);assert.equal(visible[0].context_window, 200000);
  assert.equal(visible[0].display_name, "Primary model");assert.deepEqual(visible[0].reasoning_efforts, ["low", "high"]);
  assert.equal(publicModelCatalog(other.data)[0].display_name, "Other model");assert.equal(publicModelCatalog(other.data)[0].state, "hidden");
  assert.equal(publicCopilotModelCatalog(primary)[0].display_name, "Primary model");
  for (const invalid of [null, {}, { data: null }]) assert.equal(normalizeModelList(invalid), invalid);
});
