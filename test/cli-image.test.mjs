import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { hiddenQuestion, runImageCommand, syncEnabledImageSkill } from "../src/cli-image.mjs";
import { imageProviderConfigPath, readImageProviderConfig, writeImageProviderConfig } from "../src/image-provider-config.mjs";

function capture() {
  let text = "";
  return { isTTY: false, write: (chunk) => { text += chunk; }, text: () => text };
}

function providerFetch(url) {
  return url.endsWith("/models")
    ? Promise.resolve(Response.json({ data: [{ id: "qwen-image-3.0-pro" }] }))
    : Promise.resolve(Response.json({ message: "Field required: input.messages" }, { status: 400 }));
}

const offlineProbe = async () => new Response(null, { status: 404 });

test("image CLI: API key entry is hidden and restores terminal raw mode", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; };
  const output = capture();
  output.isTTY = true;
  const answer = hiddenQuestion(input, output, "API key: ");
  input.write("secret-value\r");
  assert.equal(await answer, "secret-value");
  assert.equal(input.isRaw, false);
  assert.equal(output.text(), "API key: \n");
});

test("image CLI: enable, status, and disable form one safe configuration lifecycle", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-cli-"));
  const codexPath = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(codexPath), { recursive: true });
  fs.writeFileSync(codexPath, "model = \"gpt-5.6-sol\"\n", { mode: 0o644 });
  const output = capture();

  const enabled = await runImageCommand({
    action: "enable",
    home,
    env: {},
    codexPath,
    output,
    input: { isTTY: false },
    prompt: async () => "https://images.example/v1/images/generations",
    promptSecret: async () => "secret-value",
    fetchImpl: providerFetch,
    probeFetchImpl: offlineProbe,
    adapterPort: 3030,
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.protocol, "qwen-messages");
  assert.equal(enabled.readiness.ready, false);
  assert.match(output.text(), /Local image service: unavailable/);
  const skillPath = path.join(home, ".codex", "skills", "ccdx-image", "SKILL.md");
  assert.equal(fs.existsSync(skillPath), true);
  const saved = readImageProviderConfig({ home, env: {}, strict: true });
  assert.equal(saved.api_key, "secret-value");
  assert.equal(fs.statSync(imageProviderConfigPath({ home, env: {} })).mode & 0o777, 0o600);
  assert.equal(fs.statSync(codexPath).mode & 0o777, 0o600);
  const codex = fs.readFileSync(codexPath, "utf8");
  assert.match(codex, /^# ccdx:image-mcp:start$/m);
  assert.match(codex, /^\[mcp_servers\.ccdx_image\]$/m);
  assert.match(codex, /^url = "http:\/\/127\.0\.0\.1:3030\/mcp\/image"$/m);
  assert.doesNotMatch(codex, /secret-value/);
  assert.doesNotMatch(output.text(), /secret-value/);

  const statusOutput = capture();
  const status = await runImageCommand({ action: "status", home, env: {}, codexPath, output: statusOutput, probeFetchImpl: offlineProbe });
  assert.equal(status.enabled, true);
  assert.match(statusOutput.text(), /qwen-image-3\.0-pro/);
  assert.doesNotMatch(statusOutput.text(), /secret-value/);

  const disabledOutput = capture();
  const disabled = await runImageCommand({ action: "disable", home, env: {}, codexPath, output: disabledOutput });
  assert.equal(disabled.enabled, false);
  assert.equal(fs.existsSync(imageProviderConfigPath({ home, env: {} })), false);
  assert.equal(fs.existsSync(skillPath), false);
  assert.doesNotMatch(fs.readFileSync(codexPath, "utf8"), /ccdx:image-mcp|mcp_servers\.ccdx_image/);
  assert.equal(fs.readFileSync(codexPath, "utf8"), "model = \"gpt-5.6-sol\"\n");
  fs.rmSync(home, { recursive: true, force: true });
});

test("image setup preserves user-owned guidance and provider config on an ownership conflict", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-conflict-"));
  try {
    const skillPath = path.join(home, ".codex", "skills", "ccdx-image", "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, "user guidance");
    await assert.rejects(runImageCommand({
      action: "enable", home, env: {}, output: capture(),
      prompt: async () => "https://images.example/v1/images/generations",
      promptSecret: async () => "secret-value", fetchImpl: providerFetch, probeFetchImpl: offlineProbe,
    }), /existing or modified|owned|managed|overwrite/i);
    assert.equal(fs.readFileSync(skillPath, "utf8"), "user guidance");
    assert.equal(fs.existsSync(imageProviderConfigPath({ home, env: {} })), false);
    assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("enabled-provider startup migrates image guidance without rewriting it on subsequent starts", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-startup-"));
  try {
    const first = syncEnabledImageSkill({ home });
    assert.equal(first.changed, true);
    const before = fs.statSync(first.skillPath).mtimeMs;
    assert.equal(syncEnabledImageSkill({ home }).changed, false);
    assert.equal(fs.statSync(first.skillPath).mtimeMs, before);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("failed provider persistence rolls back newly installed image guidance", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-rollback-"));
  try {
    const providerPath = imageProviderConfigPath({ home, env: {} });
    fs.mkdirSync(providerPath, { recursive: true });
    await assert.rejects(runImageCommand({
      action: "enable", home, env: {}, output: capture(),
      prompt: async () => "https://images.example/v1/images/generations",
      promptSecret: async () => "secret-value", fetchImpl: providerFetch, probeFetchImpl: offlineProbe,
    }));
    assert.equal(fs.existsSync(path.join(home, ".codex", "skills", "ccdx-image", "SKILL.md")), false);
    assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
    assert.equal(fs.statSync(providerPath).isDirectory(), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("image setup selects before probing and saves that model's protocol on mixed gateways", async () => {
  for (const [models, protocol, message] of [
    [["qwen-image-3.0-pro", "gpt-image-1"], "openai-images", "Missing required parameter: prompt"],
    [["gpt-image-1", "qwen-image-3.0-pro"], "qwen-messages", "Field required: input.messages"],
  ]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-model-choice-"));
    const requests = [];
    try {
      const enabled = await runImageCommand({
        action: "enable", home, env: {}, output: capture(),
        prompt: async (question) => {
          if (!question.startsWith("Select")) return "https://images.example/v1/images/generations";
          assert.deepEqual(requests, ["catalog"]);
          return "2";
        },
        promptSecret: async () => "secret-value", probeFetchImpl: offlineProbe,
        fetchImpl: async (url, init = {}) => {
          if (url.endsWith("/models")) {
            requests.push("catalog");
            return Response.json({ data: models.map((id) => ({ id })) });
          }
          requests.push(JSON.parse(init.body));
          return Response.json({ error: { message } }, { status: 400 });
        },
      });
      assert.equal(enabled.model, models[1]);
      assert.equal(enabled.protocol, protocol);
      assert.deepEqual(requests, ["catalog", { model: models[1] }]);
      assert.equal(readImageProviderConfig({ home, env: {}, strict: true }).protocol, protocol);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});

test("image enable and disable preserve invalid UTF-8 config, credentials and guidance without exposing contents", async () => {
  for (const action of ["enable", "disable"]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-invalid-utf8-"));
    try {
      const codexPath = path.join(home, ".codex", "config.toml");
      const installed = syncEnabledImageSkill({ home, codexPath });
      const provider = writeImageProviderConfig({
        endpoint: "https://images.example/v1/images/generations", api_key: "fixture-private-key",
        model: "qwen-image-3.0-pro", protocol: "qwen-messages",
      }, { home, env: {} });
      const invalid = Buffer.concat([Buffer.from('model = "gpt-5.6-sol"\n# fixture-private-comment '), Buffer.from([0xff]), Buffer.from("\n")]);
      fs.writeFileSync(codexPath, invalid);
      const files = [codexPath, provider.filePath, installed.skillPath, path.join(path.dirname(installed.skillPath), "scripts", "generate.mjs")];
      const before = files.map((file) => fs.readFileSync(file));
      let prompts = 0;
      let requests = 0;
      const output = capture();
      await assert.rejects(runImageCommand({
        action, home, env: {}, codexPath, output,
        prompt: async () => { prompts += 1; return ""; },
        promptSecret: async () => { prompts += 1; return ""; },
        fetchImpl: async (url) => { requests += 1; return providerFetch(url); },
        probeFetchImpl: offlineProbe,
      }), (error) => {
        assert.match(error.message, /not valid UTF-8 TOML/);
        assert.doesNotMatch(error.message, /fixture-private/);
        return true;
      });
      assert.equal(prompts, 0);
      assert.equal(requests, 0);
      assert.deepEqual(files.map((file) => fs.readFileSync(file)), before);
      assert.doesNotMatch(output.text(), /fixture-private/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});
