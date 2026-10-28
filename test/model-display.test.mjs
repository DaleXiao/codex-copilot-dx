import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { modelDisplayName } from "../src/model-display.mjs";
import { compileClientModels } from "../src/client-model-plan.mjs";
import { deploymentModelId } from "../src/model-capabilities.mjs";
import { claudeModelEntries } from "../src/claude-models.mjs";
import { configureClaudeClients, claudeClientPaths } from "../src/claude-client-config.mjs";

test("display evidence falls back without changing model identity or interpreting its name", () => {
  assert.equal(modelDisplayName({ id: "route", name: " Model ", display_name: "显示名称" }), "显示名称");
  for (const display_name of ["", "bad\nname", "\u202esecret", "x".repeat(401)]) assert.equal(modelDisplayName({ id: "route", display_name }), "route");
});

test("mixed-source names survive any default source, opaque aliases, sync and restart", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-model-names-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sourceModels = { api_one: [{ id: "external-one", display_name: "External model" }], m365: [{ id: "claude-opus-5.5", name: "Claude Opus" }] };
  const providers = Object.fromEntries(Object.entries(sourceModels).map(([id, models]) => [id, { id, models: () => models.map(model => ({ ...model, supported_endpoints: ["/v1/messages"] })) }]));
  const binding = { enabled: true, allowed: Object.keys(providers), deployments: Object.keys(providers).map(source => ({ source, model: sourceModels[source][0].id })) };
  const compile = () => compileClientModels({ client: "claude_app", binding, source: id => providers[id], enabled: () => true });
  let identities;
  for (const source of Object.keys(providers)) {
    binding.source = source;binding.default_model = deploymentModelId(source, sourceModels[source][0].id);
    const plan = compile(), names = claudeModelEntries(plan.models);
    assert.deepEqual(names.map(model => model.labelOverride), ["External model", "Claude Opus"]);
    if (identities) assert.deepEqual(names.map(model => model.name), identities);else identities = names.map(model => model.name);
    configureClaudeClients({ home, env: {}, client: "claude_app", desktopInstalled: true, desktopManaged: false, desktopAliases: source.startsWith("api_"),
      baseUrl: "http://127.0.0.1:2026/anthropic", apiKey: "a".repeat(64), models: plan.models, defaultModel: plan.defaultModel });
    const read = () => JSON.parse(JSON.parse(fs.readFileSync(claudeClientPaths({ home, env: {} }).profile, "utf8")).inferenceModels);
    assert.deepEqual(new Map(read().map(model => [model.name, model.labelOverride])), new Map(names.map(model => [model.name, model.labelOverride])));
    assert.deepEqual(claudeModelEntries(compile().models), names);
  }
});

test("display collisions are distinguished independently of route-ID collisions", () => {
  const providers = { api_one: { id: "api_one", name: "One", models: () => ["a", "b"].map(id => ({ id, display_name: "Same", supported_endpoints: ["/v1/messages"] })) },
    api_two: { id: "api_two", name: "Two", models: () => [{ id: "a", display_name: "Same", supported_endpoints: ["/v1/messages"] }] } };
  const plan = compileClientModels({ client: "claude_app", binding: { enabled: true, allowed: Object.keys(providers), deployments: [{ source: "api_one", model: "a" }, { source: "api_one", model: "b" }, { source: "api_two", model: "a" }] }, source: id => providers[id], enabled: () => true });
  assert.deepEqual(plan.models.map(model => model.display_name), ["Same · One (a)", "Same · One (b)", "Same · Two"]);
  assert.equal(new Set(plan.models.map(model => model.public_id)).size, 3);assert.equal(plan.routes.has("a"), false);
  assert.deepEqual(claudeModelEntries(plan.models).map(model => model.labelOverride), plan.models.map(model => model.display_name));
});
