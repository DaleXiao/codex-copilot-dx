import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeUpdatedSettings, ensureClaudeConfig } from "../src/claude-config.mjs";

test("computeUpdatedSettings: updates only ANTHROPIC_BASE_URL when env exists", () => {
  const before = { env: { ANTHROPIC_BASE_URL: "http://localhost:4141", ANTHROPIC_AUTH_TOKEN: "dummy" }, model: "claude-opus-4.8" };
  const { json, changed } = computeUpdatedSettings(before, 2026);
  assert.equal(json.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:2026");
  assert.equal(json.env.ANTHROPIC_AUTH_TOKEN, "dummy");
  assert.equal(json.model, "claude-opus-4.8");
  assert.equal(changed, true);
});

test("computeUpdatedSettings: creates env when missing", () => {
  const { json, changed } = computeUpdatedSettings({ model: "x" }, 2026);
  assert.equal(json.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:2026");
  assert.equal(json.env.ANTHROPIC_AUTH_TOKEN, "dummy");
  assert.equal(json.model, "x");
  assert.equal(changed, true);
});

test("computeUpdatedSettings: reports unchanged when already current", () => {
  const before = { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:2026", ANTHROPIC_AUTH_TOKEN: "dummy" } };
  const { changed } = computeUpdatedSettings(before, 2026);
  assert.equal(changed, false);
});

test("computeUpdatedSettings: preserves unrelated keys", () => {
  const before = { env: { ANTHROPIC_BASE_URL: "http://localhost:4141", FOO: "bar" }, hooks: { a: 1 }, permissions: { deny: ["WebSearch"] } };
  const { json } = computeUpdatedSettings(before, 2026);
  assert.equal(json.env.ANTHROPIC_AUTH_TOKEN, "dummy");
  assert.equal(json.env.FOO, "bar");
  assert.deepEqual(json.hooks, { a: 1 });
  assert.deepEqual(json.permissions, { deny: ["WebSearch"] });
});

test("computeUpdatedSettings: does not mutate input", () => {
  const before = { env: { ANTHROPIC_BASE_URL: "http://localhost:4141" } };
  computeUpdatedSettings(before, 2026);
  assert.equal(before.env.ANTHROPIC_BASE_URL, "http://localhost:4141");
});

test("ensureClaudeConfig: atomically updates settings and keeps a backup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-claude-config-"));
  const filePath = path.join(dir, "settings.json");
  const before = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://old" }, keep: true }, null, 2) + "\n";
  fs.writeFileSync(filePath, before, { mode: 0o640 });

  ensureClaudeConfig(2026, { filePath });

  assert.equal(fs.readFileSync(`${filePath}.bak`, "utf8"), before);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).keep, true);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["settings.json", "settings.json.bak"]);
});
