import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchActiveProviderModels, formatM365Status, runM365Command } from "../src/cli-m365.mjs";
import { writeProviderSettings } from "../src/provider-settings.mjs";
import { collectDoctorChecks } from "../src/doctor.mjs";
import { repairDoctor } from "../src/doctor-repair.mjs";
function fixture(t) { const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-m365-cli-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));return { home, env: {} }; }
const preference = { model: "gpt-6-sol", auto_review_model: "gpt-6-sol" };
const available = { models: [{ id: "gpt-6-sol", publisher: "OpenAI" }], state: { codex_provider: "m365", m365: { state: "ready" } } };

test("M365 model command uses its isolated runtime catalog, not GitHub credentials", async t => {
  const options = fixture(t);writeProviderSettings("m365", preference, options);
  const models = await fetchActiveProviderModels({ ...options, control: async request => {
    assert.deepEqual(request.action, { action: "models", family: "gpt" });return available;
  }, fetchImpl: () => assert.fail("Must not contact GitHub") });
  assert.equal(models.upstreamHost, "Microsoft 365");assert.equal(models.source, "catalog");assert.equal(models.models[0].id, "gpt-6-sol");
});

test("noninteractive switching requires explicit available models and records no change on cancellation", async t => {
  const options = fixture(t), actions = [], lines = [];
  const control = async request => { actions.push(request.action);return request.action?.action === "models" ? available : available.state; };
  const output = { isTTY: false, write: line => lines.push(line) }, input = { isTTY: false };
  await assert.rejects(runM365Command({ ...options, action: "switch", provider: "m365", control, input, output }), /Specify --model/);
  assert.equal(actions.some(value => value.action === "switch"), false);
  await runM365Command({ ...options, action: "switch", provider: "m365", model: "gpt-6-sol", autoReviewModel: "gpt-6-sol", control, input, output });
  assert.equal(actions.at(-1).action, "switch");assert.match(lines.join(""), /Standard/);
});

test("M365-selected doctor does not validate or reimport an inactive GitHub credential", async t => {
  const options = fixture(t);writeProviderSettings("m365", preference, options);
  let controls = 0;
  const checks = await collectDoctorChecks({ ...options, online: true, checkAdapter: false,
    inspectUpdateEnvironmentFn: () => ({ state: "checkout" }), inspectCredentialPermissionsFn: () => "missing",
    providerControlFn: async () => { controls++;return available; }, fetchImpl: () => assert.fail("No GitHub contact") });
  assert.equal(controls, 1);assert.ok(checks.some(check => /Microsoft 365 is ready/.test(check.message)));
  assert.ok(checks.filter(check => check.id === "github-auth").every(check => check.kind === "info"));
  await repairDoctor({ ...options, command: () => ({ status: "checkout" }), config: () => ({ status: "unchanged" }), inspectConfig: () => [],
    importToken: () => assert.fail("Inactive credential must not be imported"), predictionSettings: () => ({ enabled: false }) });
});

test("M365 CLI status cannot inject terminal controls through account metadata", () => {
  const output = formatM365Status({ m365: { state: "ready", account: { login: "name\u001b[2J" } } });
  assert.doesNotMatch(output, /\u001b/);
});
