import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { previewArguments, previewCatalog } from "../scripts/carbon-parallel-preview.mjs";
import { defaultAccessSettings, updateAccessSettings } from "../src/access-settings.mjs";
import { githubTokenPath } from "../src/auth.mjs";
import { githubTokenFingerprint } from "../src/github-identity.mjs";
import { saveModelCache } from "../src/model-cache.mjs";
import { testEnvironment } from "./helpers/environment.mjs";

const model = { id: "gemini-4-carbon", supported_endpoints: ["/chat/completions"] };

test("preview catalog only changes Carbon's local client metadata", () => {
  const cached = { data: [model] }, original = { models: [{ slug: model.id, use_responses_lite: false, extra: { value: 1 } }, { slug: "other" }] };
  const result = previewCatalog(cached, original);
  assert.deepEqual(result.models.map(item => [item.slug, item.use_responses_lite]), [[model.id, true]]);
  result.models[0].extra.value = 2;
  assert.equal(original.models[0].extra.value, 1);
  assert.equal(original.models[0].use_responses_lite, false);
  assert.throws(() => previewCatalog({ data: [{ ...model, supported_endpoints: ["/responses"] }] }, original), /missing/);
  assert.throws(() => previewCatalog(cached, { models: [] }), /missing/);
});

test("preview overrides apply only to the launched Codex process", () => {
  const catalogFile = path.resolve("local catalog.json");
  const interactive = previewArguments({ port: 43210, catalogFile });
  assert.equal(interactive[0], "--no-daemon");
  assert.ok(!interactive.includes("exec"));
  assert.ok(!interactive.includes("--ephemeral"));
  assert.ok(interactive.includes('openai_base_url="http://127.0.0.1:43210/v1"'));
  assert.ok(interactive.includes("model_catalog_json=" + JSON.stringify(catalogFile)));
  const once = previewArguments({ port: 43210, catalogFile, prompt: "read files", live: true, once: true });
  assert.ok(once.includes("--ephemeral"));
  assert.ok(once.includes('web_search="live"'));
  assert.equal(once.at(-1), "read files");
  assert.throws(() => previewArguments({ port: 2026, catalogFile, once: true }), /prompt/);
  assert.throws(() => previewArguments({ port: 0, catalogFile }), /local port/);
});

test("parallel preview uses a separate listener and enforces the saved model binding", { skip: process.platform === "win32" }, () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-carbon-preview-test-"));
  try {
    const codexDir = path.join(fixture, "codex"), binDir = path.join(fixture, "bin");
    fs.mkdirSync(codexDir, { recursive: true });fs.mkdirSync(binDir, { recursive: true });
    const configFile = path.join(codexDir, "config.toml"), config = 'model_provider = "openai"\n';
    fs.writeFileSync(configFile, config);
    fs.writeFileSync(path.join(codexDir, "models_cache.json"), JSON.stringify({ models: [{ slug: model.id, use_responses_lite: false }] }));
    const fakeToken = "test-only-token", tokenFile = githubTokenPath(fixture);
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });fs.writeFileSync(tokenFile, fakeToken);
    saveModelCache({ data: [model] }, { home: fixture, credentialFingerprint: githubTokenFingerprint(fakeToken) });
    const env = testEnvironment(fixture, { CODEX_HOME: codexDir, XDG_CONFIG_HOME: path.join(fixture, "config"), PATH: binDir + path.delimiter + process.env.PATH });
    const settings = defaultAccessSettings();
    settings.clients.codex = { enabled: true, allowed: ["github"], source: "github", deployments: [{ source: "github", model: model.id }] };
    updateAccessSettings(() => settings, { home: fixture, env });
    const fakeCodex = `#!/usr/bin/env node
const args = process.argv.slice(2);
const values = args.filter((arg, index) => args[index - 1] === '-c');
const get = key => JSON.parse(values.find(value => value.startsWith(key + '=' )).slice(key.length + 1));
const base = get('openai_base_url'), catalog = get('model_catalog_json');
if (new URL(base).port === '2026' || !args.includes('--no-daemon') || !args.includes('--ephemeral')) throw Error('unexpected launch');
const response = await fetch(base + '/models');
const body = await response.json();
if (!response.ok || !body.data.some(item => item.id === 'gemini-4-carbon')) throw Error('model is unavailable');
console.log('preview-fixture:' + JSON.stringify({ catalog }));
`;
    fs.writeFileSync(path.join(binDir, "codex"), fakeCodex, { mode: 0o755 });
    const script = fileURLToPath(new URL("../scripts/carbon-parallel-preview.mjs", import.meta.url));
    const run = () => spawnSync(process.execPath, [script, "--once", "fixture prompt"], { env, encoding: "utf8", timeout: 15000 });
    const ready = run();
    assert.equal(ready.status, 0, ready.stderr);
    const line = ready.stdout.split("\n").find(value => value.startsWith("preview-fixture:"));
    assert.ok(line, ready.stdout);
    assert.equal(fs.existsSync(JSON.parse(line.slice("preview-fixture:".length)).catalog), false);
    assert.equal(fs.readFileSync(configFile, "utf8"), config);
    assert.equal(fs.readFileSync(tokenFile, "utf8"), fakeToken);
    settings.clients.codex.deployments = [];
    updateAccessSettings(() => settings, { home: fixture, env });
    const denied = run();
    assert.equal(denied.status, 1);
    assert.ok(!denied.stdout.includes("preview-fixture:"));
    assert.equal(fs.readFileSync(configFile, "utf8"), config);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
