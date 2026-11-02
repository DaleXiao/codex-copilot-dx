import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { waitForPublicPackage } from "../scripts/public-npm-state.mjs";
import { stageReleaseAssets } from "../scripts/stage-release-assets.mjs";

test("npm processing beyond three minutes can finish within one bounded verification without republishing", async () => {
  let time = 0;
  const record = { version: "1.3.10", dist: { integrity: "sha512-synthetic" } };
  const result = await waitForPublicPackage({ name: "fixture", version: record.version, integrity: record.dist.integrity,
    now: () => time, wait: async ms => { time += ms; },
    readJson: async url => { if (time < 360000) throw Object.assign(Error("processing"), { statusCode: 404 });return url.endsWith("/latest") && time < 420000 ? { version: "1.3.9" } : record; } });
  assert.equal(result, record);assert.equal(time, 420000);
});

test("npm integrity conflicts and denied access fail immediately while processing has a finite deadline", async () => {
  for (const failure of ["integrity", "denied", "processing"]) {
    let time = 0;
    await assert.rejects(waitForPublicPackage({ name: "fixture", version: "1.3.10", integrity: "expected", timeoutMs: 20000,
      now: () => time, wait: async ms => { time += ms; }, readJson: async () => {
        if (failure === "integrity") return { version: "1.3.10", dist: { integrity: "different" } };
        throw Object.assign(Error(failure), { statusCode: failure === "denied" ? 403 : 404 });
      } }), failure === "integrity" ? /differs/ : failure === "denied" ? /denied/ : /deadline/);
    assert.equal(time, failure === "processing" ? 20000 : 0);
  }
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-stage-test-"));t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "package-manifest.json"), JSON.stringify({ version: "1.3.10", commit: "a".repeat(40), ci_run: "123" }));
  const sha = bytes => createHash("sha256").update(bytes).digest("hex"), names = ["source.tgz", "runtime.tgz"];
  for (const name of names) fs.writeFileSync(path.join(directory, name), "synthetic " + name);
  fs.writeFileSync(path.join(directory, "SHA256SUMS"), names.map(name => `${sha(fs.readFileSync(path.join(directory, name)))}  ${name}\n`).join(""));
  const assets = [...names, "SHA256SUMS"].map(name => ({ name, size: fs.statSync(path.join(directory, name)).size, digest: "sha256:" + sha(fs.readFileSync(path.join(directory, name))) }));
  const writes = [], release = { draft: false, assets };
  const run = (command, args) => { if (command === "git") return "a".repeat(40);if (args[0] === "api") return JSON.stringify(release);writes.push(args);return ""; };
  return { directory, release, writes, run, invoke: (options = {}) => stageReleaseAssets({ directory, repository: "fixture/repo", run, ciRun: "123", resumeRun: "456", ...options }) };
}

test("resuming a public release preserves all matching shipping bytes", t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.directory, "source.tgz"));
  assert.deepEqual(f.invoke(), { version: "1.3.10", uploaded: 0, preserved: 3 });assert.equal(f.writes.length, 0);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, "source.tgz")), before);
});

test("a public release cannot accidentally enter the npm upload path again", t => {
  const f = fixture(t);assert.throws(() => f.invoke({ resumeRun: "" }), /verification-only/);assert.equal(f.writes.length, 0);
});

test("asset provenance conflicts stop before GitHub access", t => {
  const f = fixture(t), manifest = path.join(f.directory, "package-manifest.json");
  fs.writeFileSync(manifest, JSON.stringify({ version: "1.3.10", commit: "b".repeat(40), ci_run: "123" }));
  assert.throws(f.invoke, /provenance/);assert.equal(f.writes.length, 0);
});

test("existing assets without API digests are downloaded and compared before recovery", t => {
  const f = fixture(t);delete f.release.assets[0].digest;let downloaded = 0;
  const result = f.invoke({ run: (command, args, options) => {
    if (command === "gh" && args[0] === "release" && args[1] === "download") {
      const name = args[args.indexOf("--pattern") + 1], target = args[args.indexOf("--dir") + 1];
      fs.copyFileSync(path.join(f.directory, name), path.join(target, name));downloaded++;return "";
    }
    return f.run(command, args, options);
  } });
  assert.equal(result.uploaded, 0);assert.equal(downloaded, 1);assert.equal(f.writes.length, 0);
});

test("an asset conflict or a missing public asset stops before any release write", t => {
  for (const mode of ["digest", "missing", "size"]) {
    const f = fixture(t);
    if (mode === "digest") f.release.assets[1].digest = "sha256:" + "b".repeat(64);
    if (mode === "missing") f.release.assets.pop();
    if (mode === "size") f.release.assets[1].size++;
    assert.throws(f.invoke, /differs|missing/);assert.equal(f.writes.length, 0);
  }
});

test("a draft resumes by uploading only absent assets and never replacing one", t => {
  const f = fixture(t);f.release.draft = true;f.release.assets.pop();
  assert.equal(f.invoke().uploaded, 1);assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0].slice(0, 5), ["release", "upload", "v1.3.10", "--repo", "fixture/repo"]);
  assert.equal(f.writes[0].at(-1), path.join(f.directory, "SHA256SUMS"));assert.ok(!f.writes[0].includes("--clobber"));
});
