import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectCodexConfig } from "../src/codex-config-doctor.mjs";
import { collectDoctorChecks, runDoctor } from "../src/doctor.mjs";
import { initialCodexConfig } from "../src/config.mjs";

function fixture(t, content) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-config-doctor-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, ".codex", "config.toml");
  if (content !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return { home, file };
}

test("config-only doctor needs no credential, adapter, network, or file writes", async (t) => {
  const { home, file } = fixture(t, initialCodexConfig(2026, "127.0.0.1").replace("context_management = true", "context_management = false"));
  const before = fs.readFileSync(file);
  const stat = fs.statSync(file);
  const unexpected = () => assert.fail("config-only doctor must not query the network or adapter");
  const checks = await collectDoctorChecks({
    home, configOnly: true, online: true, compat: true,
    fetchImpl: unexpected, checkRunningAdapterFn: unexpected, checkAdapterListeningFn: unexpected, inspectAdapterCompatibilityFn: unexpected,
  });
  assert.deepEqual(checks, inspectCodexConfig({ home }));
  assert.ok(checks.every((check) => check.kind === "ok"));
  assert.ok(checks.some((check) => /explicitly disabled/.test(check.message)));
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file).ino, stat.ino);
  assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);
  assert.deepEqual(fs.readdirSync(home), [".codex"]);
  const lines = [];
  await runDoctor({ home, configOnly: true, log: (line) => lines.push(line) });
  assert.equal(lines[0], "ccdx doctor config");
});

test("missing config previews creation without creating directories", (t) => {
  const { home } = fixture(t);
  const checks = inspectCodexConfig({ home });
  assert.equal(checks.every((check) => check.kind === "warn"), true);
  assert.match(checks[0].message, /config not found/);
  assert.match(checks[1].message, /create the file and set:.*features.context_management/);
  assert.deepEqual(fs.readdirSync(home), []);
});

test("syntax, duplicate keys, UTF-8, and unreadable configs fail without leaking source", (t) => {
  for (const content of ['token = "sensitive-token\n', 'a = 1\na = "sensitive-token"', Buffer.from([0xff])]) {
    const { home } = fixture(t, content);
    const checks = inspectCodexConfig({ home });
    assert.equal(checks.length, 1);
    assert.equal(checks[0].kind, "err");
    assert.doesNotMatch(JSON.stringify(checks), /sensitive-token/);
    if (typeof content === "string") assert.match(checks[0].message, /line \d+, column \d+/);
  }
  const { home, file } = fixture(t);
  fs.mkdirSync(file, { recursive: true });
  assert.equal(inspectCodexConfig({ home })[0].kind, "err");
});

test("config diagnosis reads TOML scopes instead of same-named keys in other tables or strings", (t) => {
  const { home } = fixture(t, `notes = '''
openai_base_url = "http://127.0.0.1:4142/v1"
'''
[projects.sample]
openai_base_url = "http://127.0.0.1:2026/v1"
model_context_window = 1000000
context_management = true
OPENAI_API_KEY = "dummy"
`);
  const checks = inspectCodexConfig({ home });
  assert.ok(checks.some((check) => check.kind === "warn" && check.message === "Codex base URL is missing"));
  assert.ok(checks.some((check) => check.message === "model_context_window is missing"));
  assert.ok(checks.some((check) => /features.context_management is missing/.test(check.message)));
  assert.ok(checks.some((check) => /Optional shell_environment_policy.set table is absent/.test(check.message)));
  assert.ok(checks.some((check) => check.kind === "err" && /outside CCDX's managed keys/.test(check.message)));
});

test("valid custom limits and false flags remain valid across quoted, dotted, and inline TOML", (t) => {
  for (const declaration of [
    "features = { context_management = false }",
    "features.context_management = false",
    '[ "features" ]\n"context_management" = false',
  ]) {
    const { home } = fixture(t, `openai_base_url = 'http://127.0.0.1:2026/v1'
model_context_window = 262_144
model_auto_compact_token_limit = 200_000
${declaration}
`);
    const checks = inspectCodexConfig({ home });
    assert.ok(checks.every((check) => check.kind !== "err"));
    assert.ok(checks.some((check) => /context_management = false \(explicitly disabled; retained\)/.test(check.message)));
    assert.ok(checks.some((check) => /model_context_window = 262144/.test(check.message)));
    assert.ok(checks.filter((check) => /Next startup would set/.test(check.message)).every((check) => !check.message.includes("context_management")));
  }
});

test("type errors and invalid limit relationships are distinguished from customization", (t) => {
  for (const value of ["0", "-1", "1.0", '"1000"', "true"]) {
    const { home } = fixture(t, `model_context_window = ${value}\n`);
    assert.ok(inspectCodexConfig({ home }).some((check) => check.kind === "err" && /positive TOML integer/.test(check.message)));
  }
  const { home } = fixture(t, 'model_context_window = 1000\nmodel_auto_compact_token_limit = 1000\n[features]\ncontext_management = "sensitive-token"\n');
  const checks = inspectCodexConfig({ home });
  assert.ok(checks.some((check) => check.kind === "warn" && /not below/.test(check.message)));
  assert.ok(checks.some((check) => check.kind === "err" && /must be a boolean/.test(check.message)));
  assert.doesNotMatch(JSON.stringify(checks), /sensitive-token/);
});

test("startup preview matches the existing writer and never reveals key or URL secrets", (t) => {
  const { home } = fixture(t, `openai_base_url = "https://user:sensitive-token@example.test/v1?key=sensitive-token"
[shell_environment_policy.set]
OPENAI_BASE_URL = "https://example.test/?token=sensitive-token"
OPENAI_API_KEY = "sensitive-token"
[features] # supported comment
other = true
`);
  const checks = inspectCodexConfig({ home });
  const preview = checks.find((check) => /Next startup would set/.test(check.message));
  assert.ok(preview);
  for (const key of ["openai_base_url", "model_context_window", "model_auto_compact_token_limit", "OPENAI_BASE_URL", "OPENAI_API_KEY", "features.context_management"]) {
    assert.ok(preview.message.includes(key));
  }
  assert.doesNotMatch(JSON.stringify(checks), /sensitive-token/);
});

test("structured context-management settings are retained with an explicit verification limit", (t) => {
  const { home } = fixture(t, `${initialCodexConfig(2026, "127.0.0.1").replace("context_management = true", "context_management.experimental_mode = true")}`);
  const checks = inspectCodexConfig({ home });
  assert.ok(checks.some((check) => check.kind === "warn" && /Structured context-management.*not verified/.test(check.message)));
  assert.equal(checks.at(-1).message, "No startup configuration changes required");
});
