import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validCapabilities, catalogCapabilities, deploymentRevision, resolveModelCapabilities, constrainModelRequest, deploymentModelId } from "../src/model-capabilities.mjs";
import { compileClientModels, sourceModels } from "../src/client-model-plan.mjs";
import { claudeSharedCapabilityPlan, syncClaudeCapabilities } from "../src/claude-capability-config.mjs";
import { claudeClientPaths, restoreClaudeClients, configureClaudeClients } from "../src/claude-client-config.mjs";
import { defaultAccessSettings, accessSettingsPath, readAccessSettings, updateAccessSettings } from "../src/access-settings.mjs";

const temporary = t => { const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-capabilities-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));return { home, env: {}, platform: "linux" }; };
const model = (id, window, output = 16000) => ({ id, public_id: id, client_id: id, capability: { values: { ...(window ? { context_window: window } : {}), max_output_tokens: output, reasoning_efforts: ["low", "medium", "high"] } } });

test("an unverified client version preserves the existing capability configuration", t => {
  const options = temporary(t), file = claudeClientPaths(options).code;
  fs.mkdirSync(path.dirname(file), { recursive: true });const before = '{"env":{"CLAUDE_CODE_MAX_CONTEXT_TOKENS":"128000"},"modelSettings":{"custom":{"autoCompactWindow":120000}}}';fs.writeFileSync(file, before);
  const result = syncClaudeCapabilities({ limitations: [{ code: "client_version_unknown" }] }, options);
  assert.equal(result.state, "partially_preserved");assert.equal(result.changed, false);assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("capabilities preserve explicit false, field evidence, unknowns and credential generations", () => {
  const config = { base_url: "https://example.test/v1", endpoints: { messages: "https://example.test/v1/messages" }, auth_header: "bearer", secret_ref: "a".repeat(32) };
  const revision = deploymentRevision(config), metadata = { deployment: revision, checked_at: "2026-10-24T00:00:00.000Z", values: { context_window: 256000, reasoning: true, reasoning_efforts: ["low", "high"], tools: true } };
  const resolved = resolveModelCapabilities({ metadata, capabilities: { reasoning: false, tools: false, context_window: 128000 } }, { revision });
  assert.equal(resolved.values.reasoning, false);assert.equal(resolved.values.tools, false);assert.equal(resolved.values.context_window, 128000);assert.equal(resolved.values.reasoning_efforts, undefined);
  assert.equal(resolved.fields.context_window.source, "manual");assert.equal(resolved.fields.reasoning_efforts.source, "catalog");
  const changed = resolveModelCapabilities({ metadata }, { revision: deploymentRevision({ ...config, secret_ref: "b".repeat(32) }) });
  assert.deepEqual(changed.values, {});assert.equal(changed.stale, true);
  assert.notEqual(deploymentRevision({ ...config, key_env: "KEY" }, { KEY: "one" }), deploymentRevision({ ...config, key_env: "KEY" }, { KEY: "two" }));
  assert.deepEqual(catalogCapabilities({ id: "model-1m-thinking" }), {});
  assert.deepEqual(catalogCapabilities({ max_tokens: 1000000 }), {});
  assert.equal(validCapabilities({ reasoning: false, tools: false, web_search: [] }), true);
  for (const value of [{ context_window: -1 }, { max_output_tokens: 1.5 }, { reasoning: "false" }, { web_search: true }, { reasoning_efforts: ["super"] }, { context_window: 10, max_input_tokens: 11 }]) assert.equal(validCapabilities(value), false);
});

test("v1 migration preserves original bytes and single-source visibility until explicit selection", t => {
  const options = temporary(t), file = accessSettingsPath(options), old = defaultAccessSettings();old.version = 1;
  fs.mkdirSync(path.dirname(file), { recursive: true });const text = JSON.stringify(old);fs.writeFileSync(file, text);
  const next = readAccessSettings(options);assert.equal(next.version, 2);assert.equal(next.clients.codex.deployments, null);assert.equal(fs.readFileSync(file, "utf8"), text);
  updateAccessSettings(value => value, options);assert.equal(fs.readFileSync(file + ".v1-backup", "utf8"), text);
  updateAccessSettings(value => value, options);assert.equal(fs.readFileSync(file + ".v1-backup", "utf8"), text);
});

test("same-name deployments compile to separate routes, retain old aliases and reject ambiguous raw IDs", () => {
  const sources = Object.fromEntries(["api_one", "api_two"].map(id => [id, { id, models: () => [{ ...model("same", id === "api_one" ? 128000 : 1000000), supported_endpoints: ["/v1/messages"] }] }]));
  const binding = { enabled: true, allowed: Object.keys(sources), source: "api_one", deployments: [{ source: "api_one", model: "same" }, { source: "api_two", model: "same" }] };
  const plan = compileClientModels({ client: "claude_app", binding, source: id => sources[id], enabled: () => true, desktopEffortAliases: true });
  assert.equal(plan.models.length, 2);assert.notEqual(plan.models[0].public_id, plan.models[1].public_id);assert.equal(plan.routes.has("same"), false);
  for (const entry of plan.models) assert.equal(plan.routes.get(entry.public_id).provider.id, entry.source_id);
  const previous = plan.models[0].public_id;sources.api_one.models = () => [{ id: "same", supported_endpoints: ["/v1/messages"] }];
  const changed = compileClientModels({ client: "claude_app", binding, source: id => sources[id], enabled: () => true, desktopEffortAliases: true });assert.equal(changed.routes.get(previous).source, "api_one");
  const legacy = compileClientModels({ client: "claude_app", binding: { ...binding, deployments: null }, source: id => sources[id], enabled: () => true });assert.equal(legacy.models.length, 1);
  assert.equal(deploymentModelId("api_one", "same"), plan.models[0].route_id);
});

test("shared Claude budgets handle mixed windows and preserve manual and unrelated fields", t => {
  const options = temporary(t), file = claudeClientPaths(options).code;
  const plan = claudeSharedCapabilityPlan({ app: [model("ccdx/model-1", 128000)], code: [model("ccdx/model-2", 1000000, 64000)], support: { app: true, code: true } });
  assert.equal(plan.context_tokens, 1000000);assert.equal(plan.budgets["ccdx/model-1"], 128000);assert.equal(plan.budgets["ccdx/model-2"], 1000000);
  fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, JSON.stringify({ env: {}, permissions: { allow: [] }, modelSettings: { "ccdx/model-1": { autoCompactWindow: 110000, effortLevel: "low" } } }));
  configureClaudeClients({ ...options, client: "claude_code", baseUrl: "http://127.0.0.1:2026/anthropic", apiKey: "test-local-key-for-owned-settings", models: [model("ccdx/model-1", 128000)], disableExperimentalBetas: false });
  const result = syncClaudeCapabilities(plan, options);assert.equal(result.state, "partially_preserved");
  const saved = JSON.parse(fs.readFileSync(file));assert.equal(saved.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1000000");assert.equal(saved.modelSettings["ccdx/model-1"].autoCompactWindow, 110000);assert.equal(saved.modelSettings["ccdx/model-1"].effortLevel, "low");assert.deepEqual(saved.permissions, { allow: [] });
  restoreClaudeClients(options);const restored = JSON.parse(fs.readFileSync(file));assert.equal(restored.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);assert.equal(restored.modelSettings["ccdx/model-1"].autoCompactWindow, 110000);
  for (const window of [64000, 2000000, null]) { const limited = claudeSharedCapabilityPlan({ app: [model("ccdx/model-1", window), model("ccdx/model-2", 256000)], support: { app: true } });assert.equal(limited.context_tokens, null);assert.deepEqual(limited.budgets, {}); }
});

test("output constraints are explicit, never discard history, and reject undeclared effort", () => {
  const body = { model: "actual", max_tokens: 32000, messages: [{ role: "user", content: "keep" }] };
  const result = constrainModelRequest(body, { values: { max_output_tokens: 16000 } }, "messages");assert.equal(result.body.max_tokens, 16000);assert.equal(body.max_tokens, 32000);assert.equal(result.body.messages, body.messages);assert.deepEqual(result.applied, ["output_limit"]);
  assert.throws(() => constrainModelRequest({ ...body, output_config: { effort: "xhigh" } }, { values: { reasoning_efforts: ["low", "high"] } }, "messages"), { code: "ccdx_api_effort_unavailable" });
  assert.equal(constrainModelRequest(body, { values: {} }, "messages").body, body);
});


test("Codex keeps GitHub's existing Chat bridge without opening Chat-only manual APIs", () => {
  const models = () => [{ id: "legacy-chat", supported_endpoints: ["/chat/completions"] }];
  assert.equal(sourceModels({ id: "github", models }, "codex").length, 1);
  assert.equal(sourceModels({ id: "api_chat", models }, "codex").length, 0);
});

test("builtin capability declarations stay normalized and never become manual overrides", () => {
  const result = resolveModelCapabilities({ capabilities: { type: "chat", tokenizer: "vendor", supports: {
    tool_calls: false, structured_outputs: true, vision: true, reasoning_effort: ["low", "high"],
  } } }, { builtin: true });
  assert.equal(validCapabilities(result.values), true);
  assert.equal(result.values.tools, false);assert.equal(result.values.structured_output, true);
  assert.deepEqual(result.values.input_modalities, ["text", "image"]);
  assert.equal(result.values.supports, undefined);assert.equal(result.values.tokenizer, undefined);
  assert.ok(Object.values(result.fields).every(field => field.source === "catalog"));
});

test("a missing explicit default never falls back and recovers when its catalog entry returns", () => {
  let reads = 0, entries = ["other"];
  const provider = { id: "github", models: () => { reads++;return entries.map(id => ({ id, supported_endpoints: ["/responses"] })); } };
  const binding = { enabled: true, allowed: ["github"], deployments: [{ source: "github", model: "default" }, { source: "github", model: "other" }], default_model: deploymentModelId("github", "default") };
  const compile = () => compileClientModels({ client: "codex", binding, source: () => provider, enabled: () => true });
  const missing = compile();assert.equal(missing.defaultModel, null);assert.equal(missing.defaultUnavailable, true);assert.equal(missing.models.length, 1);assert.equal(reads, 1);
  entries = ["default", "other"];const recovered = compile();assert.equal(recovered.defaultModel, "default");assert.equal(recovered.routes.get(recovered.defaultModel).model.route_id, binding.default_model);
  delete binding.default_model;assert.equal(compile().defaultModel, "default");
});


test("Codex exposes unambiguous names while keeping qualified routes and source-bound defaults", () => {
  const providers = Object.fromEntries(["github", "api_two"].map(id => [id, { id, models: () => [{ id: "same", name: "Friendly model", supported_endpoints: ["/responses"] }] }]));
  const binding = { enabled: true, allowed: Object.keys(providers), deployments: [{ source: "github", model: "same" }], default_model: deploymentModelId("github", "same") };
  const compile = () => compileClientModels({ client: "codex", binding, source: id => providers[id], enabled: () => true, names: { github: "GitHub Copilot", api_two: "Work API" } });
  const single = compile();assert.equal(single.defaultModel, "same");assert.equal(single.models[0].display_name, "Friendly model");assert.equal(single.models[0].name, "Friendly model");
  assert.equal(single.routes.get(binding.default_model), single.routes.get("same"));
  binding.deployments.push({ source: "api_two", model: "same" });const mixed = compile();assert.equal(mixed.routes.has("same"), false);
  assert.equal(mixed.routes.get(mixed.defaultModel).source, "github");assert.equal(mixed.defaultModel, binding.default_model);
  assert.deepEqual(mixed.models.map(model => model.display_name), ["Friendly model · GitHub Copilot", "Friendly model · Work API"]);
  binding.deployments.pop();assert.equal(compile().defaultModel, "same");
});
