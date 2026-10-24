import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureClaudeClients, restoreClaudeClients, claudeClientPaths, M365_CLAUDE_PROFILE_ID } from "../src/claude-client-config.mjs";
import { m365Paths } from "../src/m365-settings.mjs";
import { claudeModelEntries } from "../src/claude-models.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-claude-config-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const options = { home, env: {}, platform: "darwin", desktopInstalled: true, desktopManaged: false,
    baseUrl: "http://127.0.0.1:2027", apiKey: "ccdx_m365_" + "a".repeat(64), models: [{ id: "claude-opus-5.5" }] };
  return { options, paths: claudeClientPaths(options) };
}
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, JSON.stringify(value)); }
const read = file => JSON.parse(fs.readFileSync(file));

test("compatibility aliases migrate owned App models on each platform without renaming Code models", t => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const { options } = fixture(t), input = { ...options, platform, models: [{ id: "deepseek-v4.1-flash-1017" }, { id: "qwen3.8-max" }] }, paths = claudeClientPaths(input);
    configureClaudeClients(input);
    const before = read(paths.profile);before.inferenceModels = JSON.stringify(JSON.parse(before.inferenceModels).toReversed());write(paths.profile, before);
    // Reordering is a user edit: ownership reconciliation must preserve it.
    assert.equal(configureClaudeClients({ ...input, desktopAliases: true }).app, "partially_preserved");
    assert.equal(read(paths.profile).inferenceModels, before.inferenceModels);
    restoreClaudeClients(input);fs.rmSync(paths.profile, { force: true });
    configureClaudeClients(input);
    const result = configureClaudeClients({ ...input, desktopAliases: true });assert.equal(result.app, "configured");
    assert.deepEqual(JSON.parse(read(paths.profile).inferenceModels), claudeModelEntries(input.models, { desktopAliases: true }));
    assert.equal(read(paths.code).env.ANTHROPIC_MODEL, input.models[0].id);
    assert.equal(configureClaudeClients({ ...input, desktopAliases: true }).changed, false);
    assert.equal(restoreClaudeClients(input).preserved, 0);
  }
});

test("Claude configuration is idempotent, private and restores only its own fields", t => {
  const { options, paths } = fixture(t);
  const original = { permissions: { allow: ["Read"] }, env: { USER_CHOICE: "kept" } };
  write(paths.code, original);write(paths.normal, { deploymentMode: "1p", mcpServers: { own: { command: "custom" } } });
  const first = configureClaudeClients(options);assert.equal(first.code, "configured");assert.equal(first.app, "configured");
  assert.deepEqual(read(paths.normal), { deploymentMode: "1p", mcpServers: { own: { command: "custom" } } });
  assert.equal(read(paths.code).env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, "1");
  const before = fs.readFileSync(paths.code), metaBefore = fs.readFileSync(paths.meta);
  assert.equal(configureClaudeClients(options).changed, false);
  assert.deepEqual(fs.readFileSync(paths.code), before);assert.deepEqual(fs.readFileSync(paths.meta), metaBefore);
  if (process.platform !== "win32") assert.equal(fs.statSync(paths.code).mode & 0o777, 0o600);
  const meta = read(paths.meta);meta.entries.push({ id: "another-profile", name: "Keep" });write(paths.meta, meta);
  const result = restoreClaudeClients(options);assert.equal(result.preserved, 0);assert.equal(result.remaining, 0);
  assert.deepEqual(read(paths.code), original);
  assert.deepEqual(read(paths.normal), { deploymentMode: "1p", mcpServers: { own: { command: "custom" } } });
  assert.deepEqual(read(paths.meta).entries, [{ id: "another-profile", name: "Keep" }]);
});

test("Windows third-party config uses LocalAppData while first-party detection uses roaming AppData", () => {
  const paths = claudeClientPaths({ home: "/fixture", platform: "win32", env: { LOCALAPPDATA: "/fixture/local", APPDATA: "/fixture/roaming" } });
  assert.equal(paths.normal, path.join("/fixture/roaming", "Claude", "claude_desktop_config.json"));
  assert.equal(paths.threep, path.join("/fixture/local", "Claude-3p", "claude_desktop_config.json"));
});

test("existing gateway, foreign token and managed Desktop routes are never partially replaced", t => {
  const { options, paths } = fixture(t);
  const existing = { env: { ANTHROPIC_AUTH_TOKEN: "foreign-token" }, permissions: { allow: [] } };
  write(paths.code, existing);write(paths.meta, { appliedId: "other", entries: [{ id: "other", name: "Corporate" }] });
  const before = fs.readFileSync(paths.code), meta = fs.readFileSync(paths.meta);
  const result = configureClaudeClients(options);assert.equal(result.code, "preserved");assert.equal(result.app, "preserved");
  assert.deepEqual(fs.readFileSync(paths.code), before);assert.deepEqual(fs.readFileSync(paths.meta), meta);
  assert.equal(fs.existsSync(paths.profile), false);
  assert.equal(configureClaudeClients({ ...options, desktopManaged: true }).app, "preserved");
});

test("user edits survive refresh and removal, while unchanged owned fields are restored", t => {
  const { options, paths } = fixture(t);configureClaudeClients(options);
  const code = read(paths.code);code.env.ANTHROPIC_MODEL = "user-chosen-model";code.env.USER_CHOICE = "kept";write(paths.code, code);
  configureClaudeClients({ ...options, models: [...options.models, { id: "claude-sonnet-5.5" }] });
  assert.equal(read(paths.code).env.ANTHROPIC_MODEL, "user-chosen-model");
  assert.deepEqual(JSON.parse(read(paths.profile).inferenceModels), [{ name: "claude-opus-5-5" }, { name: "claude-sonnet-5-5" }]);
  const result = restoreClaudeClients(options);assert.ok(result.preserved > 0);
  assert.deepEqual(read(paths.code).env, { ANTHROPIC_MODEL: "user-chosen-model", USER_CHOICE: "kept" });
});

test("explicit API keys, credential helpers and cloud routes keep their existing Code destination", t => {
  const { options, paths } = fixture(t);
  for (const existing of [{ env: { ANTHROPIC_API_KEY: "existing-private-key" } }, { apiKeyHelper: "existing-helper" },
    { env: { CLAUDE_CODE_USE_ANTHROPIC_AWS: "1" } }, { env: { CLAUDE_CODE_USE_GATEWAY: "1" } }]) {
    write(paths.code, existing);const before = fs.readFileSync(paths.code);
    assert.equal(configureClaudeClients({ ...options, desktopInstalled: false }).code, "preserved");
    assert.deepEqual(fs.readFileSync(paths.code), before);
  }
});

test("damaged Code settings do not prevent independent Desktop setup", t => {
  const { options, paths } = fixture(t);fs.mkdirSync(path.dirname(paths.code), { recursive: true });fs.writeFileSync(paths.code, Buffer.from([0xff]));
  const result = configureClaudeClients(options);assert.equal(result.code, "configuration_unavailable");assert.equal(result.app, "configured");
  assert.deepEqual(fs.readFileSync(paths.code), Buffer.from([0xff]));assert.equal(read(paths.meta).appliedId, M365_CLAUDE_PROFILE_ID);
});

test("untrusted cleanup ownership cannot edit arbitrary Claude fields", t => {
  const { options, paths } = fixture(t);configureClaudeClients(options);
  const journal = m365Paths(options).ownership, value = read(journal);
  value.operations.push({ file: paths.code, keys: ["permissions"], before: { exists: false }, after: {} });write(journal, value);
  const before = fs.readFileSync(paths.code);
  assert.throws(() => restoreClaudeClients(options), /ownership is invalid/);assert.deepEqual(fs.readFileSync(paths.code), before);
});

test("owned legacy defaults migrate exactly; user effort and model choices survive later catalogs", t => {
  const { options, paths } = fixture(t);
  options.models[0].capabilities = { supports: { reasoning_effort: ["low", "high"] } };
  configureClaudeClients(options);
  let code = read(paths.code);code.env.ANTHROPIC_MODEL = "claude-opus-5.5";write(paths.code, code);
  const journalPath = m365Paths(options).ownership, journal = read(journalPath);
  journal.operations.find(op => op.file === paths.code && op.keys.join(".") === "env.ANTHROPIC_MODEL").after = "claude-opus-5.5";write(journalPath, journal);
  configureClaudeClients(options);
  assert.equal(read(paths.code).env.ANTHROPIC_MODEL, "claude-opus-5-5");
  assert.deepEqual(JSON.parse(read(paths.profile).inferenceModels), [{ name: "claude-opus-5-5", maxEffort: "high" }]);
  const profile = read(paths.profile);profile.inferenceModels = JSON.stringify([{ name: "claude-opus-5-5", maxEffort: "low" }]);write(paths.profile, profile);
  options.models[0].capabilities.supports.reasoning_effort = ["low", "medium", "high", "max"];
  configureClaudeClients(options);
  assert.equal(JSON.parse(read(paths.profile).inferenceModels)[0].maxEffort, "low");
  assert.equal(read(paths.code).env.ANTHROPIC_MODEL, "claude-opus-5-5");
});

test("upstream catalog ordering does not replace the surviving App default", t => {
  const { options, paths } = fixture(t);
  configureClaudeClients(options);
  configureClaudeClients({ ...options, models: [{ id: "claude-sonnet-5.5" }, ...options.models] });
  assert.deepEqual(JSON.parse(read(paths.profile).inferenceModels).map(entry => entry.name), ["claude-opus-5-5", "claude-sonnet-5-5"]);
});

test("owned 2027 endpoints migrate to the shared prefix and retain original restoration values", t => {
  const { options, paths } = fixture(t);
  const original = { env: { USER_CHOICE: "kept" } };write(paths.code, original);
  configureClaudeClients(options);
  const next = { ...options, baseUrl: "http://127.0.0.1:2026/anthropic" };
  const result = configureClaudeClients(next);
  assert.equal(result.code, "configured");assert.equal(result.app, "configured");
  assert.equal(read(paths.code).env.ANTHROPIC_BASE_URL, next.baseUrl);
  assert.equal(read(paths.profile).inferenceGatewayBaseUrl, next.baseUrl);
  assert.equal(configureClaudeClients(next).changed, false);
  assert.equal(restoreClaudeClients(next).remaining, 0);assert.deepEqual(read(paths.code), original);
});

test("prefix migration preserves user-edited routes and rejects arbitrary base paths", t => {
  const { options, paths } = fixture(t);configureClaudeClients(options);
  const code = read(paths.code);code.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:3333";write(paths.code, code);
  const profile = read(paths.profile);profile.inferenceGatewayBaseUrl = "http://127.0.0.1:4444";write(paths.profile, profile);
  const result = configureClaudeClients({ ...options, baseUrl: "http://127.0.0.1:2026/anthropic" });
  assert.equal(result.code, "preserved");assert.equal(result.app, "preserved");
  assert.deepEqual(read(paths.code), code);assert.deepEqual(read(paths.profile), profile);
  assert.throws(() => configureClaudeClients({ ...options, baseUrl: "http://127.0.0.1:2026/arbitrary" }), /gateway must use/);
});
