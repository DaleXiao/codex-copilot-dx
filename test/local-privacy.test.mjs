import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalPrivacy } from "../src/local-privacy.mjs";
import { userSettingsPath, readUserSettings } from "../src/user-settings.mjs";

function fixture(t, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-privacy-")), options = { home, env: {} }, file = userSettingsPath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, JSON.stringify({ terminal_color_theme: "pink", future: "retained" }));
  let state = "not_downloaded", calls = 0, fail = false;
  const model = { snapshot: () => ({ state }), installed: async () => state !== "not_downloaded", download: async () => { if (fail) throw Error("offline");state = "installed"; }, load: async () => { state = "ready"; },
    find: async texts => { calls++;if (fail) throw Error("offline");return texts.map(() => []); }, stop: () => { state = "installed"; }, remove: async () => { state = "not_downloaded"; }, close() {}, busy: () => false, ...extra };
  const privacy = createLocalPrivacy({ ...options, model });t.after(() => { privacy.close();fs.rmSync(home, { recursive: true, force: true }); });
  return { privacy, model, file, options, calls: () => calls, fail: value => { fail = value; } };
}
async function enable(f) {
  await f.privacy.action({ action: "enable", revision: f.privacy.snapshot().revision });
  for (let i = 0; i < 40 && f.privacy.snapshot().action_pending; i++) await new Promise(resolve => setTimeout(resolve, 5));
}
test("default-off requests keep identity and never load the model or write settings", async t => {
  const f = fixture(t), before = fs.readFileSync(f.file), value = { model: "one", input: "api_key=private-value" };
  assert.equal(await f.privacy.prepare(value, { protocol: "responses" }), value);assert.equal(f.calls(), 0);
  assert.deepEqual(fs.readFileSync(f.file), before);assert.equal(fs.existsSync(path.join(path.dirname(f.file), "privacy-key")), false);
});
test("enable becomes effective after preparation, retains configuration, and reuses detection results", async t => {
  const f = fixture(t);await enable(f);assert.equal(f.privacy.snapshot().enabled, true);
  const value = { model: "one", input: "api_key=private-value" };
  const first = await f.privacy.prepare(value, { protocol: "responses", client: "codex" });assert.notEqual(first.input, value.input);
  const second = await f.privacy.prepare(value, { protocol: "responses", client: "codex" });assert.equal(second.input, first.input);assert.equal(f.calls(), 1);
  const saved = readUserSettings(f.options);assert.equal(saved.terminal_color_theme, "pink");assert.equal(saved.future, "retained");
  await f.privacy.action({ action: "disable", revision: f.privacy.snapshot().revision });
  assert.equal(await f.privacy.prepare(value, { protocol: "responses" }), value);
});
test("download failure never activates protection or overwrites saved preferences", async t => {
  const f = fixture(t), before = fs.readFileSync(f.file);f.fail(true);await enable(f);
  assert.equal(f.privacy.snapshot().enabled, false);assert.deepEqual(fs.readFileSync(f.file), before);assert.equal(f.privacy.snapshot().error, "ccdx_privacy_unavailable");
});
test("failed checks never invoke the provider and stale settings cannot be applied", async t => {
  const f = fixture(t);await enable(f);f.fail(true);let calls = 0;
  const invoke = f.privacy.wrap(async () => { calls++; }, { protocol: "responses", client: "codex" });
  await assert.rejects(invoke({ input: "new text" }));assert.equal(calls, 0);
  await assert.rejects(f.privacy.action({ action: "disable", revision: "stale" }), { code: "ccdx_privacy_settings_changed" });
  assert.equal(f.privacy.snapshot().enabled, true);
});
test("cancellation detaches one waiter while shared local detection can finish for another", async t => {
  let resolve;const f = fixture(t, { find: () => new Promise(done => { resolve = done; }) });await enable(f);
  const controller = new AbortController(), value = { input: "new text" };
  const one = f.privacy.prepare(value, { protocol: "responses", signal: controller.signal });
  const two = f.privacy.prepare(value, { protocol: "responses" });controller.abort(Error("cancelled"));
  await assert.rejects(one, /cancelled/);resolve([[]]);assert.equal(await two, value);
});

test("a request pins protection across an off switch while a later request keeps the original provider function", async t => {
  const f = fixture(t);await enable(f);
  const res = { write: () => true, end() {}, writeHead() {}, removeHeader() {}, getHeader() {}, once() {} };
  const fn = async body => body, context = { res, protocol: "responses", client: "codex" };
  const protectedCall = f.privacy.wrap(fn, context);
  await f.privacy.action({ action: "disable", revision: f.privacy.snapshot().revision });
  assert.match((await protectedCall({ input: "api_key=private-value" })).input, /\{\{CCDX_/);
  assert.match((await f.privacy.wrap(fn, context)({ input: "api_key=another-value" })).input, /\{\{CCDX_/);
  assert.equal(f.privacy.wrap(fn, { ...context, res: {} }), fn);
});
