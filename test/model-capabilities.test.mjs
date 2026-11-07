import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validCapabilities, catalogCapabilities, deploymentRevision, resolveModelCapabilities, constrainModelRequest, deploymentModelId, claudeEffortPrefix } from "../src/model-capabilities.mjs";
import { compileClientModels, sourceModels } from "../src/client-model-plan.mjs";
import { claudeSharedCapabilityPlan, claudeSupportForSync, syncClaudeCapabilities, inspectClaudeCapabilitySupport } from "../src/claude-capability-config.mjs";
import { claudeClientPaths, restoreClaudeClients, configureClaudeClients } from "../src/claude-client-config.mjs";
import { defaultAccessSettings, accessSettingsPath, readAccessSettings, updateAccessSettings } from "../src/access-settings.mjs";
import { m365Paths } from "../src/m365-settings.mjs";

const temporary = t => { const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-capabilities-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));return { home, env: {}, platform: "linux" }; };
const model = (id, window, output = 16000) => ({ id, public_id: id, client_id: id, capability: { values: { ...(window ? { context_window: window } : {}), max_output_tokens: output, reasoning_efforts: ["low", "medium", "high"] } } });

test("verified Claude App 3.x and 4.x retain reasoning routes while unknown major versions stay conservative", () => {
  for (const appVersion of ["3.10.0", "4.29.0", "4.4212.0"]) {
    const support = inspectClaudeCapabilitySupport({ appVersion, codeVersion: "2.1.316" });
    assert.equal(support.app, true, appVersion);
    const source = { id: "api_one", name: "Source", models: () => [{ id: "independent-reasoner", supported_endpoints: ["/v1/messages"], capability: { values: { context_window: 256000, reasoning_efforts: ["low", "medium", "high"] } } }] };
    const binding = { enabled: true, source: source.id, allowed: [source.id], deployments: [{ source: source.id, model: "independent-reasoner" }] };
    const plan = compileClientModels({ client: "claude_app", binding, source: () => source, enabled: () => true, desktopEffortAliases: support.app });
    assert.match(plan.models[0].public_id, /^mythos-ccdx-/);
    const shared = claudeSharedCapabilityPlan({ app: plan.models, support });
    assert.ok(shared.capabilities.includes(plan.models[0].public_id + "=effort"));
    assert.equal(shared.limitations.some(item => item.code === "client_version_unknown"), false);
    const legacy = plan.models[0].public_id.replace("mythos-ccdx-", "ccdx/claude-compatible-");
    assert.equal(plan.routes.get(legacy).upstreamModel, "independent-reasoner");
  }
  for (const appVersion of ["2.999.0", "5.0.0", "unverified"]) assert.equal(inspectClaudeCapabilitySupport({ appVersion, codeVersion: "2.1.316" }).app, false);
});

test("App 4.x resync preserves long-context choice and replaces owned legacy capability IDs", t => {
  const options = temporary(t), paths = claudeClientPaths(options);
  const source = { id: "api_one", name: "Source", models: () => [{ id: "independent-reasoner", supported_endpoints: ["/v1/messages"], capability: { values: { context_window: 1000000, reasoning_efforts: ["low", "medium", "high"] } } }] };
  const binding = { enabled: true, source: source.id, allowed: [source.id], deployments: [{ source: source.id, model: "independent-reasoner" }] };
  const compile = desktopEffortAliases => compileClientModels({ client: "claude_app", binding, source: () => source, enabled: () => true, desktopEffortAliases });
  const before = compile(false), input = { ...options, client: "claude_app", desktopInstalled: true, desktopManaged: false, baseUrl: "http://127.0.0.1:2026/anthropic", apiKey: "synthetic", models: before.models, defaultModel: before.defaultModel };
  configureClaudeClients(input);syncClaudeCapabilities(claudeSharedCapabilityPlan({ app: before.models, support: { app: true } }), options);
  const profile = JSON.parse(fs.readFileSync(paths.profile)), entries = JSON.parse(profile.inferenceModels);
  entries[0].prefer1m = false;profile.inferenceModels = JSON.stringify(entries);fs.writeFileSync(paths.profile, JSON.stringify(profile));
  const after = compile(true), result = configureClaudeClients({ ...input, models: after.models, defaultModel: after.defaultModel });
  syncClaudeCapabilities(claudeSharedCapabilityPlan({ app: after.models, support: { app: true } }), options);
  const saved = JSON.parse(fs.readFileSync(paths.profile)), selected = JSON.parse(saved.inferenceModels)[0], settings = JSON.parse(fs.readFileSync(paths.code));
  assert.equal(result.app, "configured");assert.equal(selected.name, after.models[0].public_id);
  assert.equal(selected.prefer1m, false);assert.equal(selected.maxEffort, "high");
  assert.equal(settings.env.CLAUDE_CODE_MODEL_CAPABILITIES, `${selected.name}=effort`);
  assert.equal(after.routes.get(before.models[0].public_id).upstreamModel, "independent-reasoner");
});

test("App 4.x keeps non-contiguous upstream effort declarations limited without inventing levels", () => {
  const capability = { values: { context_window: 1000000, reasoning_efforts: ["low", "high", "max"] } };
  const source = { id: "api_one", models: () => [{ id: "gapped-reasoner", supported_endpoints: ["/v1/messages"], capability }] };
  const binding = { enabled: true, source: source.id, allowed: [source.id], deployments: [{ source: source.id, model: "gapped-reasoner" }] };
  const support = inspectClaudeCapabilitySupport({ appVersion: "4.4212.0", codeVersion: "2.1.316" });
  const plan = compileClientModels({ client: "claude_app", binding, source: () => source, enabled: () => true, desktopEffortAliases: support.app });
  const shared = claudeSharedCapabilityPlan({ app: plan.models, support });
  assert.match(plan.models[0].public_id, /^ccdx\/claude-compatible-/);
  assert.equal(shared.capabilities, "");assert.ok(shared.limitations.some(item => item.code === "reasoning_levels_limited"));
  assert.deepEqual(plan.models[0].capability.values.reasoning_efforts, ["low", "high", "max"]);
  assert.throws(() => constrainModelRequest({ output_config: { effort: "medium" } }, capability, "messages"), { code: "ccdx_api_effort_unavailable" });
});

test("App shows the safe lower effort levels when a supported maximum has a gap", t => {
  const options = temporary(t), paths = claudeClientPaths(options);
  const capability = { values: { context_window: 1000000, reasoning_efforts: ["low", "medium", "high", "max"] } };
  const source = { id: "api_one", name: "Source", models: () => [{ id: "independent-reasoner", supported_endpoints: ["/v1/messages"], capability }] };
  const binding = { enabled: true, source: source.id, allowed: [source.id], deployments: [{ source: source.id, model: "independent-reasoner" }] };
  const compile = desktopEffortAliases => compileClientModels({ client: "claude_app", binding, source: () => source, enabled: () => true, desktopEffortAliases });
  const before = compile(false), plan = compile(true), selected = plan.models[0];
  assert.match(selected.public_id, /^mythos-ccdx-/);
  assert.equal(plan.routes.get(before.models[0].public_id).upstreamModel, selected.id);
  const input = { ...options, client: "claude_app", desktopInstalled: true, desktopManaged: false, baseUrl: "http://127.0.0.1:2026/anthropic", apiKey: "synthetic-gateway-key-0123456789", models: before.models, defaultModel: before.defaultModel };
  configureClaudeClients(input);
  const previous = JSON.parse(fs.readFileSync(paths.profile)), previousEntries = JSON.parse(previous.inferenceModels);
  previousEntries[0].prefer1m = false;previous.inferenceModels = JSON.stringify(previousEntries);fs.writeFileSync(paths.profile, JSON.stringify(previous));
  configureClaudeClients({ ...input, models: plan.models, defaultModel: plan.defaultModel });
  const entries = JSON.parse(JSON.parse(fs.readFileSync(paths.profile)).inferenceModels);
  assert.equal(entries[0].maxEffort, "high");assert.equal(entries[0].prefer1m, false);
  const shared = claudeSharedCapabilityPlan({ app: plan.models, support: { app: true } });
  assert.equal(shared.capabilities, `${selected.public_id}=effort`);
  assert.ok(shared.limitations.some(item => item.code === "reasoning_levels_limited"));
  assert.deepEqual(selected.capability.values.reasoning_efforts, ["low", "medium", "high", "max"]);
  assert.doesNotThrow(() => constrainModelRequest({ output_config: { effort: "max" } }, capability, "messages"));
  assert.throws(() => constrainModelRequest({ output_config: { effort: "xhigh" } }, capability, "messages"), { code: "ccdx_api_effort_unavailable" });
  for (const invalid of ["high", ["low", "low"], ["low", "medium", "future"]]) assert.deepEqual(claudeEffortPrefix({ reasoning_efforts: invalid }), []);
});

test("an unverified client version preserves the existing capability configuration", t => {
  const options = temporary(t), file = claudeClientPaths(options).code;
  fs.mkdirSync(path.dirname(file), { recursive: true });const before = '{"env":{"CLAUDE_CODE_MAX_CONTEXT_TOKENS":"128000"},"modelSettings":{"custom":{"autoCompactWindow":120000}}}';fs.writeFileSync(file, before);
  const result = syncClaudeCapabilities({ limitations: [{ code: "client_version_unknown" }] }, options);
  assert.equal(result.state, "partially_preserved");assert.equal(result.changed, false);assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("an observed unknown Claude major preserves future shared configuration without changing runtime support", t => {
  const options = temporary(t), file = claudeClientPaths(options).code, support = { app: true, code: true };
  fs.mkdirSync(path.dirname(file), { recursive: true });const before = '{"env":{"CLAUDE_CODE_MAX_CONTEXT_TOKENS":"128000"}}';fs.writeFileSync(file, before);
  const observed = { claude: [{ id: "claude_system_claude", version: "5.0.0" }] };
  const guarded = claudeSupportForSync(support, observed);
  const plan = claudeSharedCapabilityPlan({ app: [model("synthetic", 128000)], support: guarded });
  assert.equal(guarded.app, false);assert.equal(support.app, true);assert.ok(plan.limitations.some(item => item.code === "client_version_unknown"));
  assert.equal(syncClaudeCapabilities(plan, options).changed, false);assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(claudeSupportForSync(support, { claude: [{ id: "claude_system_claude", version: "4.999.0" }] }), support);
  assert.equal(claudeSupportForSync(support, null), support);
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

test("removing old capability fields and writing replacement budgets roll back together", t => {
  const options = temporary(t), file = claudeClientPaths(options).code;
  const initial = claudeSharedCapabilityPlan({ app: [model("old-model", 128000)], support: { app: true } });
  syncClaudeCapabilities(initial, options);
  const before = fs.readFileSync(file), owner = m365Paths(options).ownership, journal = fs.readFileSync(owner), rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => { if (to === file) throw Error("fixture write rejected");return rename(from, to); });
  const replacement = claudeSharedCapabilityPlan({ app: [model("new-model", 256000)], support: { app: true } });
  assert.throws(() => syncClaudeCapabilities(replacement, options), /fixture write rejected/);
  assert.deepEqual(fs.readFileSync(file), before);assert.deepEqual(fs.readFileSync(owner), journal);
  t.mock.restoreAll();syncClaudeCapabilities(replacement, options);
  const current = JSON.parse(fs.readFileSync(file));assert.equal(current.modelSettings["old-model"]?.autoCompactWindow, undefined);
  assert.equal(current.modelSettings["new-model"].autoCompactWindow, 256000);
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
