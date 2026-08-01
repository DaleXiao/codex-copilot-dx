import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadAutoReviewModelCatalog,
  runAutoReviewModelCommand,
} from "../src/auto-review-model.mjs";
import { savedAutoReviewModel, writeAutoReviewModel } from "../src/user-settings.mjs";

function outputBuffer() {
  let value = "";
  return {
    stream: { isTTY: true, write(chunk) { value += chunk; } },
    text: () => value,
  };
}

test("auto-review catalog: prefers live adapter Responses models", async () => {
  const calls = [];
  const catalog = await loadAutoReviewModelCatalog({
    env: { ADAPTER_PORT: "3456" },
    fetchImpl: async (...args) => {
      calls.push(args);
      return new Response(JSON.stringify({ data: [
        { id: "gpt-5.6-sol", supported_endpoints: ["/responses"] },
        { id: "gpt-chat", supported_endpoints: ["/chat/completions"] },
        { id: "gpt-disabled", model_picker_enabled: false, supported_endpoints: ["/responses"] },
      ] }));
    },
    loadModelCacheFn: () => { throw new Error("cache should not be read"); },
  });

  assert.deepEqual(catalog, { modelIds: ["gpt-5.6-sol"], source: "running adapter" });
  assert.equal(calls[0][0], "http://127.0.0.1:3456/v1/models");
});

test("auto-review catalog: falls back to fresh local model metadata", async () => {
  const catalog = await loadAutoReviewModelCatalog({
    env: {},
    fetchImpl: async () => { throw new Error("offline"); },
    loadModelCacheFn: () => ({ data: [
      { id: "gpt-5.6-luna", supported_endpoints: ["/v1/responses"] },
      { id: "codex-auto-review", supported_endpoints: ["/responses"] },
    ] }),
  });

  assert.deepEqual(catalog, { modelIds: ["gpt-5.6-luna"], source: "local model cache" });
});

test("auto-review selector: retries invalid input and persists a listed model", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-selector-"));
  const output = outputBuffer();
  const answers = ["nope", "2"];
  const result = await runAutoReviewModelCommand({
    env: {},
    home,
    input: { isTTY: true },
    output: output.stream,
    loadCatalog: async () => ({
      modelIds: ["gpt-5.6-sol", "gpt-5.5"],
      source: "test catalog",
    }),
    prompt: async () => answers.shift(),
  });

  assert.equal(result.model, "gpt-5.6-sol");
  assert.equal(savedAutoReviewModel({ env: {}, home }), "gpt-5.6-sol");
  assert.match(output.text(), /1\. gpt-5\.5 \[current, default\]/);
  assert.match(output.text(), /Enter a number from 1 to 2/);
  assert.match(output.text(), /next Auto Review request/);
});

test("auto-review selector: choosing the default clears a saved override", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-selector-reset-"));
  writeAutoReviewModel("gpt-5.6-sol", { env: {}, home });
  const output = outputBuffer();

  await runAutoReviewModelCommand({
    env: {},
    home,
    input: { isTTY: true },
    output: output.stream,
    loadCatalog: async () => ({ modelIds: ["gpt-5.5", "gpt-5.6-sol"], source: "test catalog" }),
    prompt: async () => "2",
  });

  assert.equal(savedAutoReviewModel({ env: {}, home }), "");
  assert.match(output.text(), /Auto Review model: gpt-5\.5/);
});

test("auto-review selector: reports environment precedence and rejects non-interactive use", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-selector-env-"));
  const output = outputBuffer();
  await runAutoReviewModelCommand({
    env: { CCDX_AUTO_REVIEW_MODEL: "gpt-5.6-sol" },
    home,
    output: output.stream,
    loadCatalog: async () => ({ modelIds: ["gpt-5.5", "gpt-5.6-sol"], source: "test catalog" }),
    prompt: async () => "2",
  });
  assert.match(output.text(), /remains the effective override/);

  await assert.rejects(
    runAutoReviewModelCommand({ input: { isTTY: false }, output: { isTTY: false } }),
    /requires an interactive terminal/,
  );
});
