import test from "node:test";
import assert from "node:assert/strict";
import { codexClientCatalog, codexSourceCatalog } from "../src/clients/codex-models.mjs";

const model = { id: "gpt-fixture", public_id: "gpt-fixture", source_id: "github", source_name: "GitHub",
  capability: { values: { input_modalities: ["text"], reasoning_efforts: ["low", "high"] } } };
const fast = { id: "gpt-fixture-fast", vendor: "openai", model_picker_enabled: true,
  policy: { state: "enabled" }, supported_endpoints: ["/responses"] };
const nativeCatalog = { models: [{ slug: "gpt-fixture", input_modalities: ["text", "image"], additional_speed_tiers: ["fast"],
  service_tiers: [{ id: "priority" }], default_service_tier: "priority" }] };

test("managed Codex catalog reflects the full GitHub source and explicit input modalities", () => {
  const registry = { data: [] }, project = codexClientCatalog({ models: [model] }, () => registry);
  let result = project({ data: [model] }, nativeCatalog).models[0];
  assert.deepEqual(result.input_modalities, ["text"]);assert.deepEqual(result.additional_speed_tiers, []);
  assert.deepEqual(result.service_tiers, []);assert.equal(result.default_service_tier, undefined);
  registry.data.push(fast);
  result = project({ data: [model] }, nativeCatalog).models[0];
  assert.deepEqual(result.additional_speed_tiers, ["fast"]);assert.deepEqual(result.service_tiers, [{ id: "priority" }]);
  assert.equal(result.default_service_tier, "priority");
  for (const patch of [{ policy: { state: "disabled" } }, { model_picker_enabled: false }, { supported_endpoints: ["/responses", "/chat/completions"] }]) {
    registry.data[0] = { ...fast, ...patch };result = project({ data: [model] }, nativeCatalog).models[0];
    assert.deepEqual(result.additional_speed_tiers, []);assert.deepEqual(result.service_tiers, []);
  }
});

test("unknown modalities retain the existing native template while explicit vision remains available", () => {
  const project = values => codexClientCatalog({ models: [{ ...model, capability: { values } }] })(
    { data: [model] }, nativeCatalog).models[0];
  assert.deepEqual(project({}).input_modalities, ["text", "image"]);
  assert.deepEqual(project({ input_modalities: ["text", "image"] }).input_modalities, ["text", "image"]);
  assert.deepEqual(project({ input_modalities: ["text"] }).input_modalities, ["text"]);
});

test("only GitHub Carbon uses Responses Lite for the native standalone web tool", () => {
  const carbon = { ...model, id: "gemini-4-carbon", public_id: "gemini-4-carbon" };
  const apiCarbon = { ...carbon, source_id: "api_other", public_id: "api_other/carbon" };
  const result = codexClientCatalog({ models: [carbon, model, apiCarbon] })({ data: [] },
    { models: [{ slug: "gemini-4-carbon", use_responses_lite: false }, { slug: "gpt-fixture", use_responses_lite: false }] });
  assert.equal(result.models[0].use_responses_lite, true);
  assert.equal(result.models[1].use_responses_lite, false);
  assert.equal(result.models[2].use_responses_lite, undefined);
  assert.equal(codexSourceCatalog({ id: "github", models: () => [carbon] })({}).models[0].use_responses_lite, true);
  assert.equal(codexSourceCatalog({ id: "api_other", models: () => [carbon] })({}).models[0].use_responses_lite, undefined);
});
