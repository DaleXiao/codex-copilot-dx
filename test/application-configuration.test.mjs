import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectApplicationConfiguration } from "../src/application-configuration.mjs";
import { claudeClientPaths, M365_CLAUDE_PROFILE_ID } from "../src/claude-client-config.mjs";

import { userSettingsPath } from "../src/user-settings.mjs";

test("configuration checks are read-only, semantic and preserve sealed-credential uncertainty", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-app-check-"));t.after(() => fs.rm(home, { recursive: true, force: true }));
  const options = { home, env: {}, platform: "darwin" }, files = claudeClientPaths(options);
  const before = await inspectApplicationConfiguration("claude_app", options);assert.equal(before.state, "not_configured");
  await assert.rejects(fs.stat(files.profile), { code: "ENOENT" });
  await fs.mkdir(path.dirname(files.profile), { recursive: true });
  const profile = { inferenceProvider: "gateway", inferenceGatewayBaseUrl: "http://127.0.0.1:2026/anthropic", inferenceGatewayApiKey: "__sealed__:v1:first",
    inferenceModels: '[{"name":"model","context":1000000}]' };
  await fs.writeFile(files.profile, JSON.stringify(profile));await fs.writeFile(files.meta, JSON.stringify({ appliedId: M365_CLAUDE_PROFILE_ID }));
  const first = await inspectApplicationConfiguration("claude_app", options);assert.equal(first.state, "configured");
  profile.inferenceModels = '[ { "context":1000000, "name":"model" } ]';
  await fs.writeFile(files.profile, JSON.stringify(profile));
  const formatted = await inspectApplicationConfiguration("claude_app", options);assert.equal(first.revision, formatted.revision);
  profile.inferenceGatewayApiKey = "__sealed__:v1:second";await fs.writeFile(files.profile, JSON.stringify(profile));
  const sealed = await inspectApplicationConfiguration("claude_app", options);assert.notEqual(sealed.revision, first.revision);assert.equal(sealed.reloadRevision, first.reloadRevision);
  assert.doesNotMatch(JSON.stringify(sealed), /sealed|first|second|apiKey/);
  await fs.writeFile(files.threep, JSON.stringify({ deploymentMode: "1p" }));assert.equal((await inspectApplicationConfiguration("claude_app", options)).state, "preserved");
  profile.disableDeploymentModeChooser = true;await fs.writeFile(files.profile, JSON.stringify(profile));assert.equal((await inspectApplicationConfiguration("claude_app", options)).state, "configured");
});


test("changing only the Antigravity default effort invalidates the application configuration revision", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-antigravity-revision-"));t.after(() => fs.rm(home, { recursive: true, force: true }));
  const options = { home, env: {} }, file = userSettingsPath(options);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const selected = ["ccdx-copilot-gemini-4-carbon-medium", "ccdx-copilot-gemini-4-carbon-high"];
  const write = async defaultModel => {
    await fs.writeFile(file, JSON.stringify({ gemini_antigravity_enabled: true, gemini_antigravity_models: selected, gemini_antigravity_default_model: defaultModel }));
    return inspectApplicationConfiguration("antigravity", options);
  };
  const medium = await write(selected[0]), high = await write(selected[1]);
  assert.notEqual(medium.revision, high.revision);assert.notEqual(medium.reloadRevision, high.reloadRevision);
  assert.equal((await write(selected[1])).revision, high.revision, "Saving the same setting does not reopen again");
});
