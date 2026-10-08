import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadAutoReviewModelCatalog,
  runAutoReviewModelCommand,
} from "../src/auto-review-model.mjs";
import { autoReviewModelPreference, autoReviewPreference, readUserSettings, savedAutoReviewModel, userSettingsPath, writeAutoReviewModel } from "../src/user-settings.mjs";

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

  assert.deepEqual(catalog, { modelIds: ["gpt-5.6-sol"], reasoningEfforts: { "gpt-5.6-sol": [] }, source: "running adapter" });
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

  assert.deepEqual(catalog, { modelIds: ["gpt-5.6-luna"], reasoningEfforts: { "gpt-5.6-luna": [] }, source: "local model cache" });
});

test("auto-review selector: retries invalid input and persists a listed model", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-selector-"));
  const output = outputBuffer();
  const answers = ["nope", "2", "0"];
  const result = await runAutoReviewModelCommand({
    env: {},
    home,
    input: { isTTY: true },
    output: output.stream,
    loadCatalog: async () => ({
      modelIds: ["gpt-5.6-sol", "gpt-6.1-sol"],
      source: "test catalog",
    }),
    prompt: async () => answers.shift(),
  });

  assert.equal(result.model, "gpt-5.6-sol");
  assert.equal(savedAutoReviewModel({ env: {}, home }), "gpt-5.6-sol");
  assert.match(output.text(), /1\. gpt-6\.1-sol \[current, default\]/);
  assert.match(output.text(), /Enter a number from 1 to 2/);
  assert.match(output.text(), /The running adapter will use this model on the next Auto Review request/);
  assert.doesNotMatch(output.text(), /0\.5\.1/);
});

test("auto-review selector: choosing the default clears a saved override", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-selector-reset-"));
  writeAutoReviewModel("gpt-5.6-sol", { env: {}, home });
  const output = outputBuffer();
  const answers = ["2", "0"];

  await runAutoReviewModelCommand({
    env: {},
    home,
    input: { isTTY: true },
    output: output.stream,
    loadCatalog: async () => ({ modelIds: ["gpt-6.1-sol", "gpt-5.6-sol"], source: "test catalog" }),
    prompt: async () => answers.shift(),
  });

  assert.equal(savedAutoReviewModel({ env: {}, home }), "");
  assert.match(output.text(), /Auto Review model: gpt-6\.1-sol/);
});

test("auto-review selector: GPT-5.5 remains an explicit non-default choice", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-selector-legacy-review-"));
  const output = outputBuffer();
  try {
    const answers = ["2", "0"];
    const result = await runAutoReviewModelCommand({
      env: {}, home, output: output.stream,
      loadCatalog: async () => ({ modelIds: ["gpt-5.5", "gpt-6.1-sol"], source: "test catalog" }),
      prompt: async () => answers.shift(),
    });
    assert.equal(result.model, "gpt-5.5");
    assert.equal(savedAutoReviewModel({ env: {}, home }), "gpt-5.5");
    assert.match(output.text(), /1\. gpt-6\.1-sol \[current, default\]/);
    assert.match(output.text(), /2\. gpt-5\.5\n/);

    const kept = await runAutoReviewModelCommand({
      env: {}, home, output: output.stream,
      loadCatalog: async () => ({ modelIds: ["gpt-6.1-sol", "gpt-5.5"], source: "test catalog" }),
      prompt: async () => "",
    });
    assert.equal(kept.model, "gpt-5.5");
    assert.deepEqual(autoReviewModelPreference({ env: {}, home }), { model: "gpt-5.5", source: "settings" });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("auto-review selector: reports environment precedence and rejects non-interactive use", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-selector-env-"));
  const output = outputBuffer();
  const answers = ["2", "0"];
  await runAutoReviewModelCommand({
    env: { CCDX_AUTO_REVIEW_MODEL: "gpt-5.6-sol" },
    home,
    output: output.stream,
    loadCatalog: async () => ({ modelIds: ["gpt-5.5", "gpt-5.6-sol"], source: "test catalog" }),
    prompt: async () => answers.shift(),
  });
  assert.match(output.text(), /remains the effective override/);

  await assert.rejects(
    runAutoReviewModelCommand({ input: { isTTY: false }, output: { isTTY: false } }),
    /requires an interactive terminal/,
  );
});

test("auto-review catalog: keeps effort metadata in the same lookup including cached responses", async () => {
  let calls = 0;
  const models = { data: [
    { id: "gpt-6.1-sol", supported_endpoints: ["/responses"], capabilities: { supports: { reasoning_effort: ["none", "low", "medium", "high", "max"] } } },
    { id: "gpt-5.5", supported_endpoints: ["/responses"], capabilities: { supports: { reasoning_effort: ["none", "low"] } } },
  ] };
  const catalog = await loadAutoReviewModelCatalog({
    env: {}, fetchImpl: async () => { calls += 1; return Response.json(models, { headers: { "X-CCDX-Model-Source": "last-known-good" } }); },
    loadModelCacheFn: () => { throw Error("no second lookup"); },
  });
  assert.equal(calls, 1);
  assert.equal(catalog.source, "running adapter cache");
  assert.deepEqual(catalog.reasoningEfforts, { "gpt-6.1-sol": ["low", "medium", "high", "max"], "gpt-5.5": ["low", "none"] });
  const cached = await loadAutoReviewModelCatalog({ env: {}, fetchImpl: async () => { throw Error("offline"); }, loadModelCacheFn: () => models });
  assert.deepEqual(cached.reasoningEfforts, catalog.reasoningEfforts);
});

const twoStepCatalog = {
  modelIds: ["gpt-6.1-sol", "gpt-5.5"], source: "test catalog",
  reasoningEfforts: { "gpt-6.1-sol": ["low", "medium", "high", "max"], "gpt-5.5": ["low", "none"] },
};

test("auto-review selector: two numeric steps save together and retry invalid effort input", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-selector-two-step-"));
  const options = { env: {}, home };
  const filePath = userSettingsPath(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{"terminal_animation":"twin","untouched":42}', { mode: 0o640 });
  const original = fs.readFileSync(filePath, "utf8");
  const answers = ["1", "bad", "99", "3"];
  const output = outputBuffer();
  let catalogCalls = 0;
  try {
    const result = await runAutoReviewModelCommand({
      ...options, output: output.stream,
      loadCatalog: async () => { catalogCalls += 1; return twoStepCatalog; },
      prompt: async () => { assert.equal(fs.readFileSync(filePath, "utf8"), original); return answers.shift(); },
    });
    assert.equal(result.reasoningEffort, "high");
    assert.equal(catalogCalls, 1);
    assert.deepEqual(readUserSettings(options), { terminal_animation: "twin", untouched: 42, auto_review_reasoning: { model: "gpt-6.1-sol", effort: "high" } });
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o640);
    assert.equal(fs.readdirSync(path.dirname(filePath)).length, 1);
    assert.match(output.text(), /Reasoning for gpt-6\.1-sol/);
    assert.match(output.text(), /1\. low \[default\]/);
    assert.match(output.text(), /Enter a number from 0 to 4/);
    assert.doesNotMatch(output.text(), /\. (none|minimal)/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("auto-review selector: cancellation and interrupted prompts preserve both choices byte-for-byte", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-selector-two-step-cancel-"));
  const options = { env: {}, home };
  writeAutoReviewModel("gpt-5.5", { ...options, reasoningEffort: "none" });
  const filePath = userSettingsPath(options);
  const original = fs.readFileSync(filePath, "utf8");
  try {
    for (const answers of [["q"], ["2", "q"], ["2", "interrupt"]]) {
      const run = () => runAutoReviewModelCommand({
        ...options, output: outputBuffer().stream, loadCatalog: async () => twoStepCatalog,
        prompt: async () => { const answer = answers.shift(); if (answer === "interrupt") throw Error("interrupted"); return answer; },
      });
      if (answers.includes("interrupt")) await assert.rejects(run(), /interrupted/);
      else assert.equal((await run()).cancelled, true);
      assert.equal(fs.readFileSync(filePath, "utf8"), original);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("auto-review selector: Enter preserves current effort, model changes choose low, and zero removes the override", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-selector-two-step-default-"));
  const options = { env: {}, home };
  try {
    writeAutoReviewModel("", { ...options, reasoningEffort: "high" });
    const run = (answers) => runAutoReviewModelCommand({
      ...options, output: outputBuffer().stream, loadCatalog: async () => twoStepCatalog, prompt: async () => answers.shift(),
    });
    assert.equal((await run(["", ""])).reasoningEffort, "high");
    assert.equal((await run(["2", ""])).reasoningEffort, "low");
    assert.deepEqual(autoReviewPreference(options), { model: "gpt-5.5", source: "settings", reasoningEffort: "low" });
    assert.equal((await run(["", "0"])).reasoningEffort, null);
    assert.equal(autoReviewPreference(options).reasoningEffort, null);
    assert.equal((await run(["", ""])).reasoningEffort, null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("auto-review selector: missing effort metadata never invents a choice or prevents selecting the model", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-selector-no-effort-"));
  const output = outputBuffer();
  const answers = ["1", "1", ""];
  try {
    const result = await runAutoReviewModelCommand({ env: {}, home, output: output.stream,
      loadCatalog: async () => ({ modelIds: ["gpt-6.1-sol"], source: "test catalog" }), prompt: async () => answers.shift() });
    assert.equal(result.reasoningEffort, null);
    assert.match(output.text(), /No reasoning efforts are advertised/);
    assert.match(output.text(), /Enter a number from 0 to 0/);
    assert.equal(autoReviewPreference({ env: {}, home }).reasoningEffort, null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("auto-review selector: environment model precedence never applies another model's selected effort", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-selector-env-effort-"));
  const options = { env: { CCDX_AUTO_REVIEW_MODEL: "gpt-5.5" }, home };
  const output = outputBuffer();
  const answers = ["2", "3"];
  try {
    await runAutoReviewModelCommand({ ...options, output: output.stream, loadCatalog: async () => twoStepCatalog, prompt: async () => answers.shift() });
    assert.equal(autoReviewPreference(options).reasoningEffort, undefined);
    assert.equal(autoReviewPreference({ env: {}, home }).reasoningEffort, "high");
    assert.match(output.text(), /Reasoning is bound to gpt-6\.1-sol/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
