import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { updatePredictionRoute, hasInstalledPredictionRoute } from "../src/native-prediction-route.mjs";

function fixture(t, proxy) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-prediction-route-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, "profile"), directory = path.join(root, "owned");
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
  fs.writeFileSync(path.join(profile, "Local State"), "{}");
  const file = path.join(profile, "Default", "Preferences");
  fs.writeFileSync(file, JSON.stringify({ user: { keep: true }, ...(proxy ? { proxy } : {}) }));
  return { profile, directory, file, options: { profile, directory, pacUrl: "http://127.0.0.1:12345/proxy.pac", direct: true, assertClosed() {} } };
}

for (const original of [undefined, { mode: "system" }]) test(`persistent route installs/restores one owned field (${original?.mode || "absent"})`, t => {
  const f = fixture(t, original);
  assert.equal(hasInstalledPredictionRoute(f.options), false);
  assert.equal(updatePredictionRoute(f.options).status, "installed");
  assert.equal(hasInstalledPredictionRoute(f.options), true);
  const first = fs.readFileSync(f.file), stamp = fs.statSync(f.file).mtimeMs;
  assert.equal(updatePredictionRoute({ ...f.options, assertClosed() { assert.fail("idempotent setup must not probe"); } }).status, "installed");
  assert.deepEqual(fs.readFileSync(f.file), first);assert.equal(fs.statSync(f.file).mtimeMs, stamp);
  const edited = JSON.parse(first);edited.user.newSetting = 42;fs.writeFileSync(f.file, JSON.stringify(edited));
  assert.equal(updatePredictionRoute({ ...f.options, remove: true }).status, "removed");
  const after = JSON.parse(fs.readFileSync(f.file));
  assert.deepEqual(after.user, { keep: true, newSetting: 42 });
  assert.deepEqual(after.proxy, original);
  assert.equal(fs.existsSync(path.join(f.directory, "route.json")), false);
});

test("company routing is skipped without creating even a settings lock or calling an App probe", t => {
  const f = fixture(t), before = fs.readFileSync(f.file);
  assert.equal(updatePredictionRoute({ ...f.options, direct: false, assertClosed() { assert.fail(); } }).status, "preserved");
  assert.deepEqual(fs.readFileSync(f.file), before);assert.equal(fs.existsSync(f.directory), false);
});

test("explicit or unknown user proxies are never adopted or replaced", t => {
  for (const proxy of [{ mode: "direct" }, { mode: "fixed_servers", server: "company.test:8080" },
    { mode: "pac_script", pac_url: "http://127.0.0.1:12345/proxy.pac" }, { mode: "future" }]) {
    const f = fixture(t, proxy), before = fs.readFileSync(f.file);
    assert.equal(updatePredictionRoute(f.options).status, "preserved");
    assert.deepEqual(fs.readFileSync(f.file), before);assert.equal(fs.existsSync(path.join(f.directory, "route.json")), false);
  }
});

test("running App and concurrent profile edits are preserved, including activation intent recovery", t => {
  const f = fixture(t), original = fs.readFileSync(f.file);
  assert.throws(() => updatePredictionRoute({ ...f.options, assertClosed() { throw new Error("App running"); } }), /App running/);
  assert.deepEqual(fs.readFileSync(f.file), original);
  let checks = 0;
  assert.throws(() => updatePredictionRoute({ ...f.options, assertClosed() {
    if (++checks === 2) fs.writeFileSync(f.file, JSON.stringify({ user: { changed: true } }));
  } }), /changed during route setup/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), { user: { changed: true } });
  assert.equal(updatePredictionRoute(f.options).status, "installed");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).user, { changed: true });
});

test("off preserves a user-replaced proxy and removes only CCDX ownership metadata", t => {
  const f = fixture(t);updatePredictionRoute(f.options);
  fs.writeFileSync(f.file, JSON.stringify({ proxy: { mode: "direct" }, keep: 123 }));
  const before = fs.readFileSync(f.file);
  assert.equal(updatePredictionRoute({ ...f.options, remove: true }).status, "preserved");
  assert.deepEqual(fs.readFileSync(f.file), before);assert.equal(hasInstalledPredictionRoute(f.options), false);
});

test("malformed, oversized, linked and unknown profile/ownership files cannot cause preference writes", t => {
  for (const value of ["invalid JSON", "[]", "x".repeat(1024 * 1024 + 1)]) {
    const f = fixture(t);fs.writeFileSync(f.file, value);
    assert.throws(() => updatePredictionRoute(f.options));assert.equal(fs.readFileSync(f.file, "utf8"), value);
  }
  const f = fixture(t);fs.mkdirSync(f.directory);fs.writeFileSync(path.join(f.directory, "route.json"), JSON.stringify({ version: 999 }));
  const before = fs.readFileSync(f.file);
  assert.throws(() => updatePredictionRoute(f.options), /ownership/);assert.deepEqual(fs.readFileSync(f.file), before);
  if (process.platform !== "win32") {
    const g = fixture(t), target = path.join(g.profile, "preferences-original");
    fs.renameSync(g.file, target);fs.symlinkSync(target, g.file);
    assert.throws(() => updatePredictionRoute(g.options), /regular owned file/);
  }
});

test("uninitialized profiles are deferred and unsafe PAC bindings are rejected", t => {
  const f = fixture(t);fs.unlinkSync(f.file);
  assert.equal(updatePredictionRoute(f.options).status, "pending");assert.equal(fs.existsSync(f.file), false);
  for (const pacUrl of ["https://external.test/proxy.pac", "http://127.0.0.1:1/proxy.pac", "http://127.0.0.1:99999/proxy.pac", "http://127.0.0.1:12345/proxy.pac?x=1"]) {
    assert.throws(() => updatePredictionRoute({ ...f.options, pacUrl }));
  }
});
