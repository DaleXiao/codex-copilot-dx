import test from "node:test";
import assert from "node:assert/strict";
import { claudeEffortControl, messagesWithEffortDefault } from "../src/client-effort.mjs";
import { compileClientModels } from "../src/client-model-plan.mjs";
import { claudeModelEntries } from "../src/claude-models.mjs";

const capability = levels => ({ values: { reasoning: true, reasoning_efforts: levels } });
const support = { app: true, app_contract: { status: "verified", profiles: [{ model: "claude-opus-4-7", efforts: ["low", "medium", "high", "xhigh", "max"] }] } };
test("native-first control is derived from declared sets, not model names", () => {
  assert.equal(claudeEffortControl(capability(["low", "high", "xhigh"]), support), "gateway");
  assert.equal(claudeEffortControl(capability(["low", "medium", "high", "xhigh"]), support), "native");
  assert.equal(claudeEffortControl(capability(["high"]), support), "gateway");
  assert.equal(claudeEffortControl(capability([]), support), "unsupported");
  assert.equal(claudeEffortControl({ values: { reasoning: false } }, support), "unsupported");
  assert.equal(claudeEffortControl({}, support), "unknown");
  assert.equal(claudeEffortControl({ values: { reasoning_efforts: "high" } }, support), "unknown");
  assert.equal(claudeEffortControl(capability(["low", "high"]), { app: false }), "gateway");
});

test("a default supplies only a missing effort, without copying history or changing source identity", () => {
  const body = { model: "unseen-reasoner", messages: [{ role: "user", content: "keep" }], output_config: { format: { type: "json_schema", schema: {} } } };
  const before = structuredClone(body), cap = capability(["low", "high", "xhigh"]);
  const result = messagesWithEffortDefault(body, "xhigh", cap);
  assert.deepEqual(body, before);assert.equal(result.model, body.model);assert.equal(result.messages, body.messages);
  assert.equal(result.output_config.format, body.output_config.format);assert.equal(result.output_config.effort, "xhigh");
  assert.equal(messagesWithEffortDefault(body, undefined, cap), body);
  const disabled = { ...body, thinking: { type: "disabled" } };
  const withDisabledThinking = messagesWithEffortDefault(disabled, "xhigh", cap);
  assert.equal(withDisabledThinking.thinking, disabled.thinking);assert.equal(withDisabledThinking.output_config.effort, "xhigh");
  for (const effort of ["low", "medium", null]) {
    const explicit = { ...body, output_config: { effort } };
    assert.equal(messagesWithEffortDefault(explicit, "xhigh", cap), explicit, "The app's value is neither remapped nor replaced");
  }
});

test("removed or unknown default capabilities fail rather than changing the selected level", () => {
  const body = { model: "unseen-reasoner", messages: [] };
  for (const cap of [capability(["low", "high"]), {}, { values: { reasoning: false, reasoning_efforts: ["xhigh"] } }, { values: { reasoning_efforts: "xhigh" } }])
    assert.throws(() => messagesWithEffortDefault(body, "xhigh", cap), { code: "ccdx_client_effort_unavailable" });
  for (const output_config of [null, "invalid", []]) assert.throws(() => messagesWithEffortDefault({ ...body, output_config }, "high", capability(["high"])), { code: "ccdx_messages_invalid" });
});

test("defaults stay on the authenticated App deployment and cannot come from provider metadata", () => {
  const source = id => ({ id, name: id, models: () => [{ id: "shared", supported_endpoints: ["/v1/messages"], capability: capability(["low", "high", "xhigh"]), client_effort_default: "low" }] });
  const binding = { enabled: true, allowed: ["api_one", "api_two"], deployments: [{ source: "api_one", model: "shared", reasoning_effort: "xhigh" }, { source: "api_two", model: "shared" }] };
  const compile = client => compileClientModels({ client, binding, source, enabled: () => true });
  const app = compile("claude_app");
  assert.deepEqual(app.models.map(model => app.routes.get(model.public_id).effortDefault), ["xhigh", undefined]);
  const withoutDefaults = compileClientModels({ client: "claude_app", binding: { ...binding, deployments: binding.deployments.map(({ reasoning_effort, ...item }) => item) }, source, enabled: () => true });
  assert.deepEqual(claudeModelEntries(app.models), claudeModelEntries(withoutDefaults.models), "A gateway default does not change native model declarations");
  const code = compile("claude_code");assert.ok(code.models.every(model => code.routes.get(model.public_id).effortDefault === undefined));
});
