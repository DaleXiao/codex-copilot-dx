import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { computeImageMcpCodexConfig, computeUpdatedCodexConfig, ensureCodexConfig } from "../src/config.mjs";

test("computeUpdatedCodexConfig: updates stale Codex URLs without touching legacy Anthropic keys", () => {
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
  assert.match(content, /^ANTHROPIC_BASE_URL = "http:\/\/localhost:4141"$/m);
  assert.match(content, /^ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-custom"$/m);
  assert.match(content, /^OPENAI_BASE_URL = "http:\/\/127\.0\.0\.1:2026\/v1"$/m);
  assert.match(content, /^OPENAI_API_KEY = "dummy"$/m);
  assert.match(content, /^\[projects."\/tmp\/example"\]$/m);
});

test("computeUpdatedCodexConfig: adds only missing OpenAI env URLs when shell env section exists", () => {
  const before = `[shell_environment_policy.set]
ANTHROPIC_AUTH_TOKEN = "dummy"
`;

  const { content, changed } = computeUpdatedCodexConfig(before, 2026);
  assert.equal(changed, true);
  assert.match(content, /^openai_base_url = "http:\/\/127\.0\.0\.1:2026\/v1"$/m);
  assert.match(content, /^ANTHROPIC_AUTH_TOKEN = "dummy"$/m);
  assert.doesNotMatch(content, /ANTHROPIC_BASE_URL/);
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

[features]
context_management = true
`;

  const { content, changed } = computeUpdatedCodexConfig(before, 2026);
  assert.equal(changed, false);
  assert.equal(content, before);
});

test("computeUpdatedCodexConfig: preserves existing model limits", () => {
  const before = `openai_base_url = "http://127.0.0.1:2026/v1"
model_context_window = 262144
model_auto_compact_token_limit = 200000

[features]
context_management = false
`;

  const { content, changed } = computeUpdatedCodexConfig(before, 2026);
  assert.equal(changed, false);
  assert.equal(content, before);
});

test("quoted managed keys and table headers retain their spelling, comments, and values", () => {
  const before = `"openai_base_url"  = 'http://localhost:4142/v1' # endpoint
'model_context_window' = 262_144
"model_auto_compact_token_limit" = 200_000

[ "shell_environment_policy" . 'set' ] # environment
"OPENAI_BASE_URL" = 'http://localhost:4142/v1' # shell endpoint
'OPENAI_API_KEY' = 'old-placeholder'
KEEP_ME = "untouched"

["features"]
'context_management' = false
`;
  const { content } = computeUpdatedCodexConfig(before);
  const parsed = parse(content);
  assert.equal(parsed.openai_base_url, "http://127.0.0.1:2026/v1");
  assert.equal(parsed.model_context_window, 262144);
  assert.equal(parsed.model_auto_compact_token_limit, 200000);
  assert.deepEqual(parsed.shell_environment_policy.set, {
    OPENAI_BASE_URL: "http://127.0.0.1:2026/v1", OPENAI_API_KEY: "dummy", KEEP_ME: "untouched",
  });
  assert.equal(parsed.features.context_management, false);
  assert.match(content, /^"openai_base_url"  = "http:\/\/127\.0\.0\.1:2026\/v1" # endpoint$/m);
  assert.match(content, /^\[ "shell_environment_policy" \. 'set' \] # environment$/m);
  assert.match(content, /^'model_context_window' = 262_144$/m);
  assert.deepEqual(computeUpdatedCodexConfig(content), { content, changed: false });
});

test("dotted shell settings are updated without redefining their tables", () => {
  for (const [prefix, header] of [["shell_environment_policy.set.", ""], ["set.", "[shell_environment_policy]\n"]]) {
    const before = `${currentTopLevel}${header}${prefix}"OPENAI_BASE_URL" = "http://old.test/v1" # keep
${prefix}KEEP_ME = "untouched"
`;
    const { content } = computeUpdatedCodexConfig(before);
    assert.deepEqual(parse(content).shell_environment_policy.set, {
      OPENAI_BASE_URL: "http://127.0.0.1:2026/v1", KEEP_ME: "untouched", OPENAI_API_KEY: "dummy",
    });
    assert.match(content, /# keep/);
    assert.deepEqual(computeUpdatedCodexConfig(content), { content, changed: false });
  }
});

test("multiline strings and arrays cannot masquerade as managed keys, tables, or image markers", () => {
  const before = `notes = '''
openai_base_url = "http://notes.test/v1"
[features]
# ccdx:image-mcp:start
notes = "keep this"
# ccdx:image-mcp:end
'''
examples = [
  "[shell_environment_policy.set]",
  "OPENAI_API_KEY = 'example'",
]
[projects.sample]
trust_level = "trusted"
`;
  const { content } = computeUpdatedCodexConfig(before, 2026, "127.0.0.1", { imageProviderEnabled: false });
  const original = parse(before);
  const updated = parse(content);
  assert.equal(updated.notes, original.notes);
  assert.deepEqual(updated.examples, original.examples);
  assert.deepEqual(updated.projects, original.projects);
  assert.equal(updated.openai_base_url, "http://127.0.0.1:2026/v1");
  assert.equal(updated.features.context_management, true);
});

test("image setup recognizes quoted, dotted, inline, and commented user-owned server declarations", () => {
  for (const before of [
    '["mcp_servers"."ccdx_image"]\nurl = "http://example.test/mcp"\n',
    '[mcp_servers.ccdx_image] # owned by user\nurl = "http://example.test/mcp"\n',
    'mcp_servers.ccdx_image.url = "http://example.test/mcp"\n',
    'mcp_servers = { ccdx_image = { url = "http://example.test/mcp" } }\n',
  ]) {
    assert.doesNotThrow(() => parse(before));
    assert.throws(() => computeImageMcpCodexConfig(before, { enabled: true }), /outside the CCDX-managed block/);
  }
});

test("startup refuses invalid TOML without overwriting the existing file or leaking its content", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-config-guard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "config.toml");
  const before = 'token = "sensitive-value\n';
  fs.writeFileSync(filePath, before);
  const stat = fs.statSync(filePath);
  assert.throws(() => ensureCodexConfig(2026, { filePath }), (error) => {
    assert.match(error.message, /TOML/);
    assert.doesNotMatch(error.message, /sensitive-value/);
    return true;
  });
  assert.equal(fs.readFileSync(filePath, "utf8"), before);
  assert.equal(fs.statSync(filePath).ino, stat.ino);
  const invalidUtf8 = Buffer.concat([Buffer.from('notes = "'), Buffer.from([0xff]), Buffer.from('"\n')]);
  fs.writeFileSync(filePath, invalidUtf8);
  assert.throws(() => ensureCodexConfig(2026, { filePath }), /UTF-8 TOML/);
  assert.deepEqual(fs.readFileSync(filePath), invalidUtf8);
});

test("image block removal cannot delete settings outside the managed image server", () => {
  const before = `# ccdx:image-mcp:start
[mcp_servers.ccdx_image]
url = "http://127.0.0.1:2026/mcp/image"
[projects.sample]
trust_level = "trusted"
# ccdx:image-mcp:end
`;
  for (const enabled of [true, false]) {
    const result = computeImageMcpCodexConfig(before, { enabled });
    assert.equal(result.content, before);
    assert.deepEqual(parse(result.content).projects, parse(before).projects);
  }
});

test("multiline managed strings are replaced without consuming following comments or declarations", () => {
  const before = `${currentTopLevel.replace('openai_base_url = "http://127.0.0.1:2026/v1"', '"openai_base_url" = """http://old.test/v1""" # endpoint')}
notes = """
Literal [features], escaped \\"quote\\" and a continued \\
  line.
"""
[features]
context_management = false
`;
  const { content } = computeUpdatedCodexConfig(before);
  assert.equal(parse(content).notes, parse(before).notes);
  assert.equal(parse(content).openai_base_url, "http://127.0.0.1:2026/v1");
  assert.match(content, /# endpoint/);
});

test("empty MCP parent tables survive an enable-disable round trip", () => {
  const before = '[mcp_servers]\n';
  const enabled = computeImageMcpCodexConfig(before, { enabled: true });
  assert.deepEqual(computeImageMcpCodexConfig(enabled.content, { enabled: false }), { content: before, changed: true });
});

test("computeUpdatedCodexConfig: does not treat a section key as top-level openai_base_url", () => {
  const before = `model = "gpt-5.5"

[projects."/tmp/example"]
openai_base_url = "https://project.example/v1"
trust_level = "trusted"
`;

  const { content, changed } = computeUpdatedCodexConfig(before, 2026);
  assert.equal(changed, true);
  assert.match(content, /^openai_base_url = "http:\/\/127\.0\.0\.1:2026\/v1"$/m);
  assert.match(content, /^openai_base_url = "https:\/\/project\.example\/v1"$/m);
});

test("computeUpdatedCodexConfig: updates only the top-level openai_base_url", () => {
  const before = `openai_base_url = "http://localhost:4142/v1"

[projects."/tmp/example"]
openai_base_url = "https://project.example/v1"
`;

  const { content, changed } = computeUpdatedCodexConfig(before, 2026);
  assert.equal(changed, true);
  assert.match(content, /^openai_base_url = "http:\/\/127\.0\.0\.1:2026\/v1"$/m);
  assert.match(content, /^openai_base_url = "https:\/\/project\.example\/v1"$/m);
});

test("computeUpdatedCodexConfig: does not mistake top-level multiline array values for tables", () => {
  const before = `fallbacks = [
  ["gpt-5.5", "gpt-5.6-sol"],
]
openai_base_url = "http://localhost:4142/v1"

[projects."/tmp/example"] # retained project settings
trust_level = "trusted"
`;

  const { content, changed } = computeUpdatedCodexConfig(before, 2026);
  assert.equal(changed, true);
  assert.equal(content.match(/^openai_base_url\s*=/gm)?.length, 1);
  assert.match(content, /^openai_base_url = "http:\/\/127\.0\.0\.1:2026\/v1"$/m);
  assert.ok(content.indexOf("model_auto_compact_token_limit") < content.indexOf("[projects."));
  assert.match(content, /^  \["gpt-5\.5", "gpt-5\.6-sol"\],$/m);
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

[features]
context_management = false
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
  assert.match(content, /^\[features\]\ncontext_management = true$/m);
  assert.doesNotMatch(content, /ANTHROPIC/);
  assert.doesNotMatch(content, /ANTHROPIC_DEFAULT_(?:SONNET|OPUS|HAIKU)_MODEL/);
  assert.doesNotMatch(content, /CLAUDE_CODE_SUBAGENT_MODEL/);
});

const currentTopLevel = `openai_base_url = "http://127.0.0.1:2026/v1"
model_context_window = 1000000
model_auto_compact_token_limit = 900000
`;

test("context management default creates a missing features table and remains idempotent", () => {
  for (const ending of ["", "\n"]) {
    const before = `${currentTopLevel}\n[projects."/tmp/example"]\ntrust_level = "trusted"${ending}`;
    const { content, changed } = computeUpdatedCodexConfig(before);
    assert.equal(changed, true);
    assert.equal(content, `${before.trimEnd()}\n\n[features]\ncontext_management = true${ending}`);
    assert.deepEqual(computeUpdatedCodexConfig(content), { content, changed: false });
  }
});

test("context management default stays in the existing features table and preserves other sections", () => {
  const before = `${currentTopLevel}
[features] # retain this comment
other_feature = true
# context_management = false

[features.other]
context_management = false

[projects."/tmp/example"]
trust_level = "trusted"
`;
  const { content, changed } = computeUpdatedCodexConfig(before);
  assert.equal(changed, true);
  assert.equal(content, before.replace("# context_management = false\n", "# context_management = false\ncontext_management = true\n"));
  assert.deepEqual(computeUpdatedCodexConfig(content), { content, changed: false });
});

test("context management preserves existing true and false values, quoted keys, and formatting", () => {
  for (const value of ["true", "false"]) {
    for (const [section, key] of [["[features]", "context_management"], ['[ "features" ] # flags', '"context_management"'], ["['features']", "'context_management'"]]) {
      const content = `${currentTopLevel}\n${section}\n  ${key}  = ${value} # user's choice\nother_feature = true\n`;
      assert.deepEqual(computeUpdatedCodexConfig(content), { content, changed: false });
    }
  }
});

test("context management missing key is inserted in a quoted features table", () => {
  const before = `${currentTopLevel}\n[ "features" ] # keep\nother_feature = false\n`;
  const { content, changed } = computeUpdatedCodexConfig(before);
  assert.equal(changed, true);
  assert.equal(content, `${before}context_management = true\n`);
  assert.deepEqual(computeUpdatedCodexConfig(content), { content, changed: false });
});

test("context management preserves existing inline, dotted, and nested TOML declarations", () => {
  for (const declaration of [
    "features = { context_management = false }",
    "features.other_feature = true",
    "features.context_management = false",
    '"features"."context_management" = true',
    "[features.context_management]\nexperimental_mode = false",
    "[features]\ncontext_management.experimental_mode = false",
  ]) {
    const content = `${currentTopLevel}${declaration}\n`;
    assert.deepEqual(computeUpdatedCodexConfig(content), { content, changed: false });
  }
});

test("creating a fresh Codex config includes the feature and a second startup does not write it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-context-management-"));
  const filePath = path.join(dir, "config.toml");
  try {
    ensureCodexConfig(2026, { filePath });
    const content = fs.readFileSync(filePath, "utf8");
    const before = fs.statSync(filePath);
    assert.match(content, /^\[features\]\ncontext_management = true$/m);
    ensureCodexConfig(2026, { filePath });
    const after = fs.statSync(filePath);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(fs.readFileSync(filePath, "utf8"), content);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
