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

test("image setup merges edits made during prompts and skips unchanged config replacements", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-concurrent-"));
  const codexPath = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(codexPath), { recursive: true });
  fs.writeFileSync(codexPath, 'model = "gpt-5.5"\n');
  const options = { action: "enable", home, env: {}, codexPath, output: capture(),
    fetchImpl: providerFetch, probeFetchImpl: offlineProbe, promptSecret: async () => "fixture-key" };
  try {
    await runImageCommand({ ...options, prompt: async () => {
      fs.writeFileSync(codexPath, 'model = "gpt-6-astra"\n# edited while prompting\n');
      return "https://images.example/v1";
    } });
    assert.match(fs.readFileSync(codexPath, "utf8"), /gpt-6-astra/);
    assert.match(fs.readFileSync(codexPath, "utf8"), /edited while prompting/);
    const before = fs.statSync(codexPath);
    const providerBefore = fs.statSync(imageProviderConfigPath({ home, env: {} }));
    const result = await runImageCommand({ ...options, prompt: async () => "", promptSecret: async () => "" });
    assert.equal(result.codexChanged, false);
    assert.equal(fs.statSync(codexPath).ino, before.ino);
    assert.equal(fs.statSync(codexPath).mtimeMs, before.mtimeMs);
    assert.equal(fs.statSync(imageProviderConfigPath({ home, env: {} })).ino, providerBefore.ino);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("image setup cannot forward an old key to a new origin after a blank answer", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-origin-"));
  writeImageProviderConfig({ endpoint: "https://old.example/v1", api_key: "old-fixture-key", model: "qwen-image-3.0-pro", protocol: "qwen-messages" }, { home, env: {} });
  let calls = 0;
  try {
    await assert.rejects(runImageCommand({ action: "enable", home, env: {}, output: capture(),
      prompt: async () => "https://new.example/v1", promptSecret: async question => {
        assert.match(question, /new origin/); return "";
      }, fetchImpl: async () => { calls += 1; throw new Error("must not call"); },
    }), /API key is required/);
    assert.equal(calls, 0);
    assert.equal(readImageProviderConfig({ home, env: {} }).api_key, "old-fixture-key");
    assert.equal(fs.existsSync(path.join(home, ".codex", "skills")), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("image setup preserves a conflicting MCP declaration added during validation", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-new-conflict-"));
  const codexPath = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(codexPath), { recursive: true });
  fs.writeFileSync(codexPath, 'model = "gpt-5.5"\n');
  const external = '[mcp_servers.ccdx_image]\ncommand = "user-owned-command"\n';
  try {
    await assert.rejects(runImageCommand({ action: "enable", home, env: {}, codexPath, output: capture(),
      prompt: async () => "https://images.example/v1", promptSecret: async () => "fixture-key",
      fetchImpl: async url => { fs.writeFileSync(codexPath, external); return providerFetch(url); }, probeFetchImpl: offlineProbe,
    }), /ccdx_image/);
    assert.equal(fs.readFileSync(codexPath, "utf8"), external);
    assert.equal(readImageProviderConfig({ home, env: {} }), null);
    assert.equal(fs.existsSync(path.join(home, ".codex", "skills", "ccdx-image")), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

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
  for (const reference of ["editing.md", "helper.md"]) assert.equal(fs.existsSync(path.join(path.dirname(skillPath), "references", reference)), true);
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
  assert.equal(fs.existsSync(path.dirname(skillPath)), false);
  assert.doesNotMatch(fs.readFileSync(codexPath, "utf8"), /ccdx:image-mcp|mcp_servers\.ccdx_image/);
  assert.equal(fs.readFileSync(codexPath, "utf8"), "model = \"gpt-5.6-sol\"\n");
  fs.rmSync(home, { recursive: true, force: true });
});

test("image CLI: base URLs configure the existing generation endpoint without extra provider requests", async () => {
  for (const [baseUrl, endpoint, modelsUrl] of [
    ["https://images.example", "https://images.example/v1/images/generations", "https://images.example/v1/models"],
    ["https://images.example/v1/", "https://images.example/v1/images/generations", "https://images.example/v1/models"],
    ["https://images.example/proxy/v1", "https://images.example/proxy/v1/images/generations", "https://images.example/proxy/v1/models"],
    ["https://images.example/custom/images/generations", "https://images.example/custom/images/generations", "https://images.example/custom/models"],
  ]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-cli-base-"));
    try {
      const output = capture();
      const requests = [];
      const enabled = await runImageCommand({
        action: "enable", home, env: {}, output,
        prompt: async (question) => {
          assert.match(question, /^API base URL or endpoint/);
          return baseUrl;
        },
        promptSecret: async () => "secret-value", probeFetchImpl: offlineProbe,
        fetchImpl: async (url, init = {}) => {
          requests.push({ url, method: init.method || "GET", body: init.body && JSON.parse(init.body) });
          return providerFetch(url);
        },
      });
      assert.equal(enabled.endpoint, endpoint);
      assert.equal(enabled.model, "qwen-image-3.0-pro");
      assert.equal(enabled.protocol, "qwen-messages");
      assert.equal(readImageProviderConfig({ home, env: {}, strict: true }).endpoint, endpoint);
      assert.deepEqual(requests, [
        { url: modelsUrl, method: "GET", body: undefined },
        { url: endpoint, method: "POST", body: { model: "qwen-image-3.0-pro" } },
      ]);
      assert.match(output.text(), /HTTPS base URL.*full \/images\/generations endpoint/);
      assert.doesNotMatch(output.text(), /secret-value/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});

test("image CLI: blank answers preserve an existing full endpoint, key and chosen model", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-cli-keep-endpoint-"));
  try {
    const endpoint = "https://images.example/custom/api/images/generations";
    writeImageProviderConfig({
      endpoint, api_key: "secret-value", model: "qwen-image-3.0-pro", protocol: "qwen-messages",
    }, { home, env: {} });
    const enabled = await runImageCommand({
      action: "enable", home, env: {}, output: capture(),
      prompt: async (question) => {
        assert.equal(question, `API base URL or endpoint [${endpoint}]: `);
        return "";
      },
      promptSecret: async () => "", fetchImpl: providerFetch, probeFetchImpl: offlineProbe,
    });
    assert.equal(enabled.endpoint, endpoint);
    assert.deepEqual(readImageProviderConfig({ home, env: {}, strict: true }), {
      enabled: true, endpoint, api_key: "secret-value", model: "qwen-image-3.0-pro", protocol: "qwen-messages",
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
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
    assert.equal(fs.existsSync(path.join(home, ".codex", "skills", "ccdx-image")), false);
    assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
    assert.equal(fs.statSync(providerPath).isDirectory(), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("image status and disable without prior enable install neither skill nor MCP", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-disabled-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexPath = path.join(home, ".codex", "config.toml");
  const output = capture();
  let requests = 0;
  const fetchImpl = async () => { requests += 1; throw new Error("Disabled images must not use the network"); };
  for (const action of ["status", "disable", "status"]) {
    const result = await runImageCommand({ action, home, env: {}, codexPath, output, fetchImpl, probeFetchImpl: fetchImpl });
    assert.equal(result.enabled, false);
    assert.equal(fs.existsSync(path.join(home, ".codex")), false);
    assert.equal(fs.existsSync(imageProviderConfigPath({ home, env: {} })), false);
  }
  assert.equal(requests, 0);
});

test("disable-image removes owned configuration and guidance after marker loss or damage", async (t) => {
  for (const marker of ["both", "start", "end"]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-orphan-disable-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const codexPath = path.join(home, ".codex", "config.toml");
    await runImageCommand({
      action: "enable", home, env: {}, output: capture(),
      prompt: async () => "https://images.example/v1", promptSecret: async () => "fixture-only-key",
      fetchImpl: providerFetch, probeFetchImpl: offlineProbe,
    });
    const original = fs.readFileSync(codexPath, "utf8");
    const stripped = original.split("\n").filter(line => marker === "both"
      ? !line.startsWith("# ccdx:image-mcp:") : line !== `# ccdx:image-mcp:${marker}`).join("\n");
    fs.writeFileSync(codexPath, `${stripped}\n[mcp_servers.other]\ncommand = "keep"\n`);
    const disabled = await runImageCommand({ action: "disable", home, env: {}, codexPath, output: capture() });
    assert.equal(disabled.enabled, false);
    assert.equal(fs.existsSync(imageProviderConfigPath({ home, env: {} })), false);
    assert.equal(fs.existsSync(path.join(home, ".codex", "skills", "ccdx-image")), false);
    const finalConfig = fs.readFileSync(codexPath, "utf8");
    assert.doesNotMatch(finalConfig, /ccdx_image|ccdx:image-mcp/);
    assert.ok(finalConfig.includes('[mcp_servers.other]\ncommand = "keep"'));
  }
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
