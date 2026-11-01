import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { runServiceSupervisor } from "../src/service-supervisor.mjs";

async function replay(t, { busy = false, failPromotion = false, releaseVersion = "1.3.8" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-manual-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "installed"), candidateTarget = path.join(root, "candidate");
  for (const [dir, version] of [[target, "1.3.7"], [candidateTarget, releaseVersion]]) {
    fs.mkdirSync(dir);fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }));
  }
  const events = [], processObj = new EventEmitter();let lookups = 0, preparations = 0, first = true;
  const sample = version => ({ version, fingerprint: "unchanged", business: [], busy, activity: { active: busy ? 1 : 0, total: 3 }, health: {} });
  const stopSoon = () => setTimeout(() => processObj.emit("SIGINT"), 0);
  const launch = (dir, options) => {
    const version = JSON.parse(fs.readFileSync(path.join(dir, "package.json"))).version;
    let exit;const exited = new Promise(resolve => { exit = resolve; });
    if (first) { first = false;setTimeout(() => { options.onManualUpdate();options.onManualUpdate(); }, 0); }
    return {
      ready: Promise.resolve(sample(version)), exited,
      async call(action) {
        events.push(version + ":" + action);
        if (action === "promote" && failPromotion) throw new Error("promotion failed");
        return { ...sample(version), ...(action === "quiesce" ? { state: { version: 1 } } : {}) };
      },
      async stop() { events.push(version + ":stop");exit({ code: 0 }); },
      status(value) { events.push(value.phase);if (["updated", "current", "deferred", "failed"].includes(value.phase)) stopSoon(); },
      notice: code => events.push(code),
    };
  };
  const result = await runServiceSupervisor({
    environment: { target }, env: { XDG_CONFIG_HOME: path.join(root, "config") }, processObj, launch,
    retain: () => ({ target, cleanup: () => events.push("baseline-cleanup") }), verify: async () => {},
    timers: { setInterval: () => ({ unref() {} }), clearInterval() {} },
    lookup: async () => { lookups++;return { version: releaseVersion, published_at: "2026-10-31T00:00:00Z" }; },
    prepare: async () => {
      preparations++;
      return { version: releaseVersion, target: candidateTarget, cleanup: () => events.push("candidate-cleanup"),
        install: async () => {
          events.push("install");fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ version: releaseVersion }));
          return { commit: () => events.push("commit"), rollback: () => { events.push("rollback");fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ version: "1.3.7" })); } };
        } };
    },
  });
  return { result, events, lookups, preparations, installed: JSON.parse(fs.readFileSync(path.join(target, "package.json"))).version };
}

test("manual WebUI update switches once without enabling the nightly schedule", async t => {
  const r = await replay(t);
  assert.equal(r.result, 0);assert.equal(r.lookups, 1);assert.equal(r.preparations, 1);assert.equal(r.installed, "1.3.8");
  assert.ok(r.events.includes("updated"));assert.ok(r.events.indexOf("commit") < r.events.indexOf("1.3.7:stop"));
});

test("active work defers manual update before any lookup or download", async t => {
  const r = await replay(t, { busy: true });
  assert.equal(r.lookups, 0);assert.equal(r.preparations, 0);assert.equal(r.installed, "1.3.7");assert.ok(r.events.includes("deferred"));
});

test("manual promotion failure restores installation and resumes the old service", async t => {
  const r = await replay(t, { failPromotion: true });
  assert.equal(r.installed, "1.3.7");assert.ok(r.events.includes("rollback"));assert.ok(r.events.includes("1.3.7:resume"));assert.ok(r.events.includes("failed"));
});

test("manual update never downgrades to an older published release", async t => {
  const r = await replay(t, { releaseVersion: "1.3.6" });
  assert.equal(r.preparations, 0);assert.equal(r.installed, "1.3.7");assert.ok(r.events.includes("current"));
});
