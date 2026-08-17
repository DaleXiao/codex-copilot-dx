import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeUpdatedCodexConfig, ensureCodexConfig } from "../src/config.mjs";

test("computeUpdatedCodexConfig: updates stale Codex and shell env URLs", () => {
  const before = `model = "gpt-5.5"
openai_base_url = "http://localhost:4142/v1"

[shell_environment_policy]
inherit = "core"

[shell_environment_policy.set]
ANTHROPIC_AUTH_TOKEN = "dummy"
ANTHROPIC_BASE_URL = "http://localhost:4141"
ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-custom"
OPENAI_BASE_URL = "http://localhost:4141/v1"
OPENAI_API_KEY = "dummy"

[projects."/tmp/example"]
trust_level = "trusted"
`;

  const { content, changed } = computeUpdatedCodexConfig(before, 2026);
  assert.equal(changed, true);
  assert.match(content, /^openai_base_url = "http:\/\/127\.0\.0\.1:2026\/v1"$/m);
  assert.match(content, /^model_context_window = 1000000$/m);
  assert.match(content, /^model_auto_compact_token_limit = 900000$/m);
  assert.ok(content.indexOf("model_auto_compact_token_limit") < content.indexOf("[shell_environment_policy]"));
  assert.match(content, /^ANTHROPIC_AUTH_TOKEN = "dummy"$/m);
  assert.match(content, /^ANTHROPIC_BASE_URL = "http:\/\/127\.0\.0\.1:2026"$/m);
  assert.match(content, /^ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-custom"$/m);
  assert.match(content, /^OPENAI_BASE_URL = "http:\/\/127\.0\.0\.1:2026\/v1"$/m);
  assert.match(content, /^OPENAI_API_KEY = "dummy"$/m);
  assert.match(content, /^\[projects."\/tmp\/example"\]$/m);
});

test("computeUpdatedCodexConfig: adds missing env URLs when shell env section exists", () => {
  const before = `[shell_environment_policy.set]
ANTHROPIC_AUTH_TOKEN = "dummy"
`;

  const { content, changed } = computeUpdatedCodexConfig(before, 2026);
  assert.equal(changed, true);
  assert.match(content, /^openai_base_url = "http:\/\/127\.0\.0\.1:2026\/v1"$/m);
  assert.match(content, /^ANTHROPIC_AUTH_TOKEN = "dummy"$/m);
  assert.match(content, /^ANTHROPIC_BASE_URL = "http:\/\/127\.0\.0\.1:2026"$/m);
  assert.match(content, /^OPENAI_BASE_URL = "http:\/\/127\.0\.0\.1:2026\/v1"$/m);
  assert.match(content, /^OPENAI_API_KEY = "dummy"$/m);
});

test("computeUpdatedCodexConfig: leaves absent shell env section absent", () => {
  const before = `model = "gpt-5.5"
openai_base_url = "http://localhost:4142/v1"
`;

  const { content } = computeUpdatedCodexConfig(before, 2026);
  assert.match(content, /^openai_base_url = "http:\/\/127\.0\.0\.1:2026\/v1"$/m);
  assert.doesNotMatch(content, /shell_environment_policy\.set/);
  assert.doesNotMatch(content, /ANTHROPIC_BASE_URL/);
});

test("computeUpdatedCodexConfig: reports unchanged when already current", () => {
  const before = `openai_base_url = "http://127.0.0.1:2026/v1"
model_context_window = 1000000
model_auto_compact_token_limit = 900000

[shell_environment_policy.set]
ANTHROPIC_AUTH_TOKEN = "dummy"
ANTHROPIC_BASE_URL = "http://127.0.0.1:2026"
OPENAI_BASE_URL = "http://127.0.0.1:2026/v1"
OPENAI_API_KEY = "dummy"
`;

  const { content, changed } = computeUpdatedCodexConfig(before, 2026);
  assert.equal(changed, false);
  assert.equal(content, before);
});

test("computeUpdatedCodexConfig: preserves existing model limits", () => {
  const before = `openai_base_url = "http://127.0.0.1:2026/v1"
model_context_window = 262144
model_auto_compact_token_limit = 200000
`;

  const { content, changed } = computeUpdatedCodexConfig(before, 2026);
  assert.equal(changed, false);
  assert.equal(content, before);
});

test("computeUpdatedCodexConfig: uses a bracketed IPv6 loopback URL", () => {
  const { content, changed } = computeUpdatedCodexConfig("model = \"gpt-5.5\"\n", 2026, "::1");

  assert.equal(changed, true);
  assert.match(content, /^openai_base_url = "http:\/\/\[::1\]:2026\/v1"$/m);
});

test("ensureCodexConfig: leaves an already-current file untouched", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-codex-config-"));
  const filePath = path.join(dir, "config.toml");
  const content = `openai_base_url = "http://127.0.0.1:2026/v1"
model_context_window = 1000000
model_auto_compact_token_limit = 900000

[shell_environment_policy.set]
ANTHROPIC_AUTH_TOKEN = "dummy"
ANTHROPIC_BASE_URL = "http://127.0.0.1:2026"
OPENAI_BASE_URL = "http://127.0.0.1:2026/v1"
OPENAI_API_KEY = "dummy"
`;
  fs.writeFileSync(filePath, content);
  const before = fs.statSync(filePath);
  await new Promise((resolve) => setTimeout(resolve, 5));
  ensureCodexConfig(2026, { filePath });
  const after = fs.statSync(filePath);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("ensureCodexConfig: creates a new file with model defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-codex-config-"));
  const filePath = path.join(dir, "config.toml");

  ensureCodexConfig(2026, { filePath });

  const content = fs.readFileSync(filePath, "utf8");
  assert.match(content, /^model_context_window = 1000000$/m);
  assert.match(content, /^model_auto_compact_token_limit = 900000$/m);
  assert.doesNotMatch(content, /ANTHROPIC_DEFAULT_(?:SONNET|OPUS|HAIKU)_MODEL/);
  assert.doesNotMatch(content, /CLAUDE_CODE_SUBAGENT_MODEL/);
});
