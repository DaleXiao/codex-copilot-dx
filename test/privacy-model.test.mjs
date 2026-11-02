import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createPrivacyModel, PRIVACY_COMPONENT_RELEASE } from "../src/privacy-model.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
async function fixture(t, { legacy = false, offline = false } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-model-unit-"));
  const weights = Buffer.from("synthetic weights"), runner = Buffer.from("synthetic runner"), requests = [], jobs = [];
  let child, spawned;
  const model = createPrivacyModel({ home, env: {}, modelFiles: [{ name: "model", bytes: weights.length, sha256: sha(weights) }],
    fetchImpl: async url => { requests.push(url);if (offline) throw Error("offline");return new Response(url.endsWith("SHA256SUMS") ? `${sha(runner)}  ${model.paths.name}\n` : runner); },
    spawnImpl: file => { spawned = file;child = new EventEmitter();child.stdout = new PassThrough();child.stdin = new Writable({ write(bytes, _encoding, done) { jobs.push(JSON.parse(bytes));done(); } });child.kill = () => {};setImmediate(() => child.stdout.write('{"ready":true,"backend":"CPU"}\n'));return child; },
  });
  t.after(async () => { model.close();await fs.rm(home, { recursive: true, force: true }); });
  await fs.mkdir(model.paths.model, { recursive: true });await fs.writeFile(path.join(model.paths.model, "model"), weights);
  const file = legacy ? model.paths.legacyRunner : model.paths.runner, receipt = legacy ? model.paths.legacyReceipt : model.paths.receipt;
  await fs.mkdir(path.dirname(file), { recursive: true });await fs.writeFile(file, runner);await fs.writeFile(receipt, JSON.stringify({ release: legacy ? "1.3.6" : PRIVACY_COMPONENT_RELEASE, sha256: sha(runner) }));
  return { model, requests, jobs, spawned: () => spawned, reply: (id, found = [[]]) => child.stdout.write(JSON.stringify({ id, found }) + "\n") };
}
test("cancelled native work retains admission slots until physical acknowledgement", async t => {
  const f = await fixture(t), abort = new AbortController();await f.model.load();
  const pending = f.model.find(["synthetic"], { signal: abort.signal });await new Promise(setImmediate);abort.abort(Error("cancelled"));
  await assert.rejects(pending, /cancelled/);assert.equal(f.model.snapshot().pending_checks, 1);assert.equal(f.model.snapshot().cancelled_checks, 1);
  f.reply(f.jobs[0].id);assert.equal(f.model.snapshot().pending_checks, 0);
  const calls = Array.from({ length: 8 }, () => f.model.find(["synthetic"]));await new Promise(setImmediate);
  await assert.rejects(f.model.find(["overflow"]), { code: "ccdx_privacy_busy" });
  for (const job of f.jobs.slice(1)) f.reply(job.id);await Promise.all(calls);
});
test("legacy protection remains ready when a background component upgrade fails", async t => {
  const f = await fixture(t, { legacy: true, offline: true });assert.equal(await f.model.installed({ current: true }), false);
  await f.model.load();await f.model.download({ background: true }).catch(() => {});assert.equal(f.spawned(), f.model.paths.legacyRunner);
  assert.equal(f.model.snapshot().state, "ready");assert.equal(f.model.snapshot().component_update, "error");
  const pending = f.model.find(["synthetic"]);await new Promise(setImmediate);f.reply(f.jobs[0].id);assert.deepEqual(await pending, [[]]);
});
test("a verified component stages separately and reuses unchanged model weights", async t => {
  const f = await fixture(t, { legacy: true });const before = await fs.readFile(f.model.paths.legacyRunner);
  await f.model.load();await f.model.download({ background: true });assert.equal(f.model.snapshot().state, "ready");
  assert.equal(await f.model.installed({ current: true }), true);assert.deepEqual(await fs.readFile(f.model.paths.legacyRunner), before);
  assert.equal(f.requests.length, 2);assert.equal(f.requests.some(url => url.includes("huggingface")), false);
  f.model.stop();await f.model.load();assert.equal(f.spawned(), f.model.paths.runner);assert.equal(f.model.snapshot().component_release, PRIVACY_COMPONENT_RELEASE);
  await fs.writeFile(f.model.paths.runner, "corrupt");f.model.stop();assert.equal(await f.model.installed({ current: true }), false);assert.equal(await f.model.installed(), true);
});
