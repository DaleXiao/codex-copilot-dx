import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { parseCliArgs, cliHelp } from "../src/cli-options.mjs";
import { MANAGED_COMMANDS } from "../src/cli-command-spec.mjs";
import { runManagementCommand } from "../src/cli-management.mjs";
import { projectTerminalState, retainedRequests } from "../src/terminal-state.mjs";
import { userSettingsPath, readUserSettings } from "../src/user-settings.mjs";
import { settingsPreferencesSnapshot, settingsBackupPath } from "../src/settings-preferences.mjs";

const graph = () => ({ source: "connections", management_version: 1,
  providers: [{ id: "github", name: "GitHub Copilot", enabled: true, builtin: true }, { id: "m365", name: "Microsoft 365", enabled: true, builtin: true },
    { id: "api_work", name: "Work API", enabled: false, builtin: false, base_url: "https://example.test/v1", endpoints: { responses: "https://example.test/v1/responses", messages: "https://example.test/v1/messages" }, models: [], auth_header: "bearer", key_saved: true }],
  source_impacts: Object.fromEntries(["github", "m365", "api_work"].map(id => [id, { revision: id + "-revision", clients: [] }])),
  clients: ["codex", "claude_app", "claude_code"].map(id => ({ id, enabled: true, allowed: ["github", "m365"], source: id === "codex" ? "github" : null,
    setup: "configured", revision: id + "-revision", model_plan: { models: [], unavailable: [], available: [], default_model: null } })) });
function fixture() {
  const state = graph(), calls = [], output = [];
  const data = { version: "1.2.33", uptime_ms: 1000, model_activity: { active: 0 }, runtime_usage: { records: 2, input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 },
    providers: { connections: state, claude: { requests: { performance: { active_requests: [], recent_requests: [] } } } },
    stream_performance: { active_requests: [], recent_requests: [{ request_id: "old-request", application: "codex_app", provider: "github", model: "model", outcome: "completed" }] },
    requests: { by_route: Object.fromEntries(["responses", "responses_compact", "messages"].map(route => [route, { active: 0, total: route === "responses" ? 1 : 0 }])) } };
  const options = { output: { isTTY: false, columns: 100, write: value => output.push(value) }, input: Readable.from([]), version: "1.2.33",
    readStatus: async () => ({ data, baseUrl: "http://127.0.0.1:2026" }),
    request: async input => {
      calls.push(structuredClone(input));
      if (input.path === "providers") return { providers: [{ id: "github", auth: { state: "saved" }, models: { source: "cache", count: 15 } }] };
      if (input.path === "settings") return { effective: { image_enabled: { configured: true, value: true } } };
      if (input.body?.operation === "source_catalog") return { source: input.body.id, evidence: "cached", access_checked: false, models: [{ id: "all-family-model" }] };
      if (input.body?.operation === "preview_client") return { ...structuredClone(state), preview: { saved: false, models: [] } };
      return structuredClone(state);
    } };
  const run = args => runManagementCommand(parseCliArgs(args), options);
  return { state, data, calls, output, options, run };
}
test("canonical routes and deep help share one public grammar", () => {
  for (const spec of MANAGED_COMMANDS) {
    const args = spec.path.map(token => ({ "<source>": "api_work", "<app>": "codex", "<request>": "request-1", "<key>": "open_webui", "<value>": "false" }[token] || token));
    assert.ok(parseCliArgs(args).command, args.join(" "));
    assert.match(cliHelp("ccdx", args.slice(0, -1).join(" ") || args[0]), /Usage|Compatibility|Usage:/);
  }
  assert.throws(() => parseCliArgs(["source", "github"]));
  assert.throws(() => parseCliArgs(["models"]));
  assert.equal(parseCliArgs(["source", "github", "reauth", "--login", "user"]).expectedLogin, "user");
  assert.equal(parseCliArgs(["app", "codex", "prediction", "setup"]).action, "on");
  assert.equal(parseCliArgs(["config", "limits", "--decoded", "256"]).limitMib, 256);
  assert.match(cliHelp("ccdx", "app codex prediction"), /setup|repair/);
  assert.doesNotMatch(cliHelp("ccdx", "source github"), /github (?:edit|remove)/);
});
test("canonical feature help retains the existing integration safety and data-loss boundaries", () => {
  assert.match(cliHelp("ccdx", "app codex prediction setup"), /decrypted locally/);
  assert.match(cliHelp("ccdx", "app codex prediction setup"), /Codex to be closed/);
  assert.match(cliHelp("ccdx", "app codex image remove"), /stored image credential/);
  assert.match(cliHelp("ccdx", "doctor cache"), /break chat continuation/);
  assert.match(cliHelp("ccdx", "update"), /entire dependency tree/);
});
test("unknown actions, malformed client IDs, duplicate flags and nonnumeric bounds fail before IO", () => {
  for (const args of [["app", "wrong", "status"], ["source", "github", "unknown"], ["requests", "--limit", "101"], ["requests", "--active", "--failed"],
    ["status", "--format", "xml"], ["app", "codex", "models", "--file", "x"], ["source", "m365", "access", "--apps", "codex"], ["source", "github", "status", "--format", "json", "--format", "json"]]) assert.throws(() => parseCliArgs(args), undefined, args.join(" "));
});
test("read-only client/source/status/request commands do not start a service or send writes", async () => {
  const f = fixture();
  for (const args of [["source", "list", "--format", "json"], ["source", "github", "status", "--format", "json"], ["app", "list", "--format", "json"], ["app", "codex", "status", "--format", "json"],
    ["app", "codex", "models", "--format", "json"], ["requests", "--format", "json"], ["requests", "show", "old-request", "--format", "json"], ["status", "--format", "json"], ["usage", "--scope", "run", "--format", "json"]]) {
    const text = await f.run(args);assert.doesNotThrow(() => JSON.parse(text), args.join(" "));assert.doesNotMatch(text, /\x1b/);
  }
  assert.ok(f.calls.every(call => !call.body));
  const catalog = JSON.parse(await f.run(["source", "m365", "models", "--format", "json"]));
  assert.equal(catalog.models[0].id, "all-family-model");assert.equal(catalog.access_checked, false);
  assert.deepEqual(f.calls.filter(call => call.body).map(call => call.body.operation), ["source_catalog"]);
  await assert.rejects(f.run(["requests", "show", "missing"]), /not retained/i);
});
test("configuration evidence never becomes App liveness; features remain scoped to Codex", async () => {
  const f = fixture();
  const codex = JSON.parse(await f.run(["app", "codex", "status", "--details", "--format", "json"]));
  assert.ok(codex.features);assert.match(codex.app_adoption, /Gateway request observed/);assert.match(codex.chatgpt_sign_in, /not inferred/);
  const claude = JSON.parse(await f.run(["app", "claude-app", "status", "--details", "--format", "json"]));
  assert.equal(claude.access, "Paused");assert.equal(claude.features, undefined);
  const source = JSON.parse(await f.run(["source", "github", "status", "--format", "json"]));
  assert.equal(source.credentials.state, "saved");assert.match(source.access, /Not inferred/);
});
test("new client writes fail closed against an older running service; sync preview never writes", async () => {
  const f = fixture();delete f.state.management_version;
  await f.run(["app", "codex", "sync", "--preview"]);assert.ok(f.calls.every(call => !call.body));
  await assert.rejects(f.run(["app", "codex", "disable", "--yes"]), /updated running service/);
  assert.ok(f.calls.every(call => !call.body));
});
test("disabling a client retains unavailable selections and sends the current revision", async () => {
  const f = fixture();Object.assign(f.state.clients[0], { deployments: [{ source: "github", model: "missing" }], default_model: "missing-route" });
  await f.run(["app", "codex", "disable", "--yes"]);
  const write = f.calls.find(call => call.body?.operation === "client_state").body;
  assert.equal(write.enabled, false);assert.equal(write.client_revision, "codex-revision");assert.equal(write.deployments, undefined);
});
test("shared source access previews grants without silently choosing client models", async () => {
  const f = fixture();
  await f.run(["source", "m365", "access", "--edit", "--apps", "claude-app", "--yes"]);
  const write = f.calls.find(call => call.body).body;
  assert.deepEqual(write, { operation: "source_access", id: "m365", allowed: ["claude_app"], impact_revision: "m365-revision" });
  f.state.source_impacts.m365.clients = [{ id: "codex", needs_replacement: true }];
  await assert.rejects(f.run(["source", "m365", "disable", "--yes"]), /explicit --replacements/);
});
test("CLI reset/restore reuses a service-only backup and retains routes, keys and feature access", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-settings-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const options = { home, env: {} }, file = userSettingsPath(options);fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ terminal_color_theme: "pink", image_enabled: false, prediction_enabled: false, custom: "untouched" }));
  const f = fixture();Object.assign(f.options, options, { readStatus: async () => { throw Error("adapter is not running"); } });
  await f.run(["config", "reset", "--yes"]);
  assert.ok(settingsPreferencesSnapshot({ ...options, backupScope: "service" }).backup);assert.equal(fs.existsSync(settingsBackupPath(options)), false);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(settingsBackupPath({ ...options, backupScope: "service" }))), "scope"), false);
  assert.equal(readUserSettings(options).terminal_color_theme, "green");assert.equal(readUserSettings(options).image_enabled, false);
  await f.run(["config", "restore", "--yes"]);assert.equal(readUserSettings(options).terminal_color_theme, "pink");assert.equal(readUserSettings(options).custom, "untouched");
  await assert.rejects(f.run(["config", "set", "terminal_color_theme", "invalid", "--yes"]));
  assert.equal(readUserSettings(options).terminal_color_theme, "pink");
});
test("API metadata cannot contain a key, while bounded private stdin never enters output", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-api-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "api.json"), config = { name: "New API", base_url: "https://example.test/v1", endpoints: { messages: "https://example.test/v1/messages" }, auth_header: "bearer", models: [] };
  fs.writeFileSync(file, JSON.stringify({ config: { ...config, key: "DO-NOT-PRINT" }, allowed: [] }));
  const f = fixture();await assert.rejects(f.run(["source", "add", "--file", file, "--preview"]), /privately|private input/);assert.doesNotMatch(f.output.join(""), /DO-NOT-PRINT/);
  fs.writeFileSync(file, JSON.stringify({ config, allowed: [] }));f.options.input = Readable.from(["PRIVATE-STDIN-KEY\n"]);
  const base = f.options.request;
  f.options.request = async input => { if (input.body?.operation === "save_api") { const next = structuredClone(f.state);next.providers.push({ ...config, id: "api_new", builtin: false });f.calls.push(structuredClone(input));return next; }return base(input); };
  const result = await f.run(["source", "add", "--file", file, "--key-stdin", "--yes"]);
  assert.equal(f.calls.find(call => call.body?.operation === "save_api").body.key, "PRIVATE-STDIN-KEY");
  assert.doesNotMatch(result + f.output.join(""), /PRIVATE-STDIN-KEY/);
});
test("request diagnostics retain cancellation and incomplete outcomes when HTTP errors exist", () => {
  const data = { stream_performance: { recent_requests: [{ request_id: "cancelled", outcome: "cancelled" }, { request_id: "partial", outcome: "incomplete" }] },
    http_errors: { recent: [{ request_id: "cancelled", code: "client_aborted" }, { request_id: "partial", http_status: 502 }] } };
  const rows = retainedRequests(data);assert.equal(rows.find(row => row.request_id === "cancelled").state, "cancelled");assert.equal(rows.find(row => row.request_id === "partial").state, "incomplete");
});
test("new client model editing warns before removing an observed memory dependency without guessing its name", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-memory-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "models.json");fs.writeFileSync(file, JSON.stringify({ deployments: [{ source: "github", model: "other" }], default_model: "other" }));
  for (const observed of ["observed-memory-id", "qualified-memory-route"]) {
    const f = fixture();Object.assign(f.state.clients[0], { memory_model: { model: observed }, deployments: [{ source: "github", model: "observed-memory-id" }] });
    f.state.clients[0].model_plan.models = [{ source: "github", id: "observed-memory-id", route_id: "qualified-memory-route" }];
    await f.run(["app", "codex", "models", "--edit", "--file", file, "--yes"]);
    assert.match(f.output.join(""), /memory writing may fail/);
  }
});
test("an explicit empty model file clears the old default and keeps pause separate from credentials", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-empty-models-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "models.json");fs.writeFileSync(file, JSON.stringify({ deployments: [] }));
  const f = fixture();Object.assign(f.state.clients[0], { deployments: [{ source: "github", model: "previous" }], default_model: "old-route" });
  await f.run(["app", "codex", "models", "--edit", "--file", file, "--yes"]);
  assert.equal(f.calls.find(call => call.body?.operation === "client").body.default_model, null);
  fs.writeFileSync(file, JSON.stringify({ auto_sync: false }));await assert.rejects(f.run(["app", "codex", "models", "--edit", "--file", file, "--yes"]), /explicit deployments/);
});
test("noninteractive same-origin API metadata edits keep the saved key without requesting secret input", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-api-edit-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "api.json");fs.writeFileSync(file, JSON.stringify({ config: { name: "Work API", base_url: "https://example.test/v1", endpoints: { responses: "https://example.test/v1/responses", messages: "https://example.test/v1/messages" }, auth_header: "bearer", models: [] }, allowed: [] }));
  const f = fixture();await f.run(["source", "api_work", "edit", "--file", file, "--yes"]);
  assert.equal(f.calls.find(call => call.body?.operation === "save_api").body.key, undefined);
});
test("model activity excludes transport-only MCP work, keeps unknown clients and stale identities", () => {
  const f = fixture();f.data.requests.by_route.image_mcp = { active: 3, total: 99 };
  assert.equal(projectTerminalState(f.data).activity, 0);
  f.data.model_activity.active = 2;f.data.requests.by_route.responses.active = 2;
  f.data.stream_performance.active_requests = [{ request_id: "one", route: "responses", application: "api" }, { request_id: "two", route: "responses", application: "codex_app" }];
  const view = projectTerminalState(f.data);assert.equal(view.clients.find(row => row.id === "codex").active, 1);assert.equal(view.clients.find(row => row.id === "other").active, 1);
  assert.equal(retainedRequests(f.data).find(row => row.request_id === "one").active, true);
  f.data.model_activity.active = null;assert.equal(projectTerminalState(f.data).activity, null);
});
