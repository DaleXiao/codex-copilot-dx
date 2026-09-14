import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { hiddenQuestion, runImageCommand } from "../src/cli-image.mjs";
import { imageProviderConfigPath, readImageProviderConfig } from "../src/image-provider-config.mjs";

function capture() {
  let text = "";
  return { isTTY: false, write: (chunk) => { text += chunk; }, text: () => text };
}

function providerFetch(url) {
  return url.endsWith("/models")
    ? Promise.resolve(Response.json({ data: [{ id: "qwen-image-3.0-pro" }] }))
    : Promise.resolve(Response.json({ message: "Field required: input.messages" }, { status: 400 }));
}

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
    adapterPort: 3030,
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.protocol, "qwen-messages");
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
  const status = await runImageCommand({ action: "status", home, env: {}, codexPath, output: statusOutput });
  assert.equal(status.enabled, true);
  assert.match(statusOutput.text(), /qwen-image-3\.0-pro/);
  assert.doesNotMatch(statusOutput.text(), /secret-value/);

  const disabledOutput = capture();
  const disabled = await runImageCommand({ action: "disable", home, env: {}, codexPath, output: disabledOutput });
  assert.equal(disabled.enabled, false);
  assert.equal(fs.existsSync(imageProviderConfigPath({ home, env: {} })), false);
  assert.doesNotMatch(fs.readFileSync(codexPath, "utf8"), /ccdx:image-mcp|mcp_servers\.ccdx_image/);
  assert.equal(fs.readFileSync(codexPath, "utf8"), "model = \"gpt-5.6-sol\"\n");
});
