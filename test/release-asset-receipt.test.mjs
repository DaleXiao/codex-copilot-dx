import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("latest promotion can amend its receipt after every public shipping asset was byte-verified", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-public-receipt-"));t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const version = "1.3.10", targets = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"];
  const names = [`codex-copilot-dx-${version}.tgz`, "ccdx-install.mjs", "install.sh", "install.ps1",
    ...targets.map(target => `codex-copilot-dx-${version}-${target}.tgz`), ...targets.map(target => `ccdx-privacy-guard-1-${target}${target.startsWith("win32") ? ".exe" : ""}`)];
  const sha = bytes => createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(path.join(directory, "package-manifest.json"), JSON.stringify({ version }));
  for (const name of names) fs.writeFileSync(path.join(directory, name), `synthetic bytes for ${name}`);
  fs.writeFileSync(path.join(directory, "SHA256SUMS"), names.map(name => `${sha(fs.readFileSync(path.join(directory, name)))}  ${name}\n`).join(""));
  for (const target of targets) {
    const name = `codex-copilot-dx-${version}-${target}.tgz`, bytes = fs.readFileSync(path.join(directory, name));
    fs.writeFileSync(path.join(directory, name + ".manifest.json"), JSON.stringify({ version, target, size: bytes.length,
      integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") }));
  }
  fs.writeFileSync(path.join(directory, "release-receipt.json"), '{"npm":{"latest":null}}');
  const preload = path.join(directory, "public.cjs"), calls = path.join(directory, "calls.json");
  fs.writeFileSync(preload, `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
    const directory=process.env.ASSET_FIXTURE;
    cp.execFileSync=()=>JSON.stringify({isDraft:false,assets:fs.readdirSync(directory).filter(name=>name==='SHA256SUMS'||name==='release-receipt.json'||name.endsWith('.tgz')||name.startsWith('ccdx-privacy-guard-1-')||['ccdx-install.mjs','install.sh','install.ps1'].includes(name)).map(name=>{const bytes=fs.readFileSync(path.join(directory,name));return{name,size:bytes.length,digest:'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex')};})});
    globalThis.fetch=async url=>{const name=new URL(url).pathname.split('/').pop(),file=path.join(directory,'calls.json'),calls=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[];calls.push(name);fs.writeFileSync(file,JSON.stringify(calls));return new Response(fs.readFileSync(path.join(directory,name)));};require('node:module').syncBuiltinESMExports();`);
  const run = mode => spawnSync(process.execPath, ["--require", preload, fileURLToPath(new URL("../scripts/verify-release-assets.mjs", import.meta.url)), directory, mode],
    { env: { ...process.env, ASSET_FIXTURE: directory, GITHUB_REPOSITORY: "fixture/repo" }, encoding: "utf8" });
  const first = run("public");assert.equal(first.status, 0, first.stderr);assert.equal(JSON.parse(fs.readFileSync(calls)).length, 14);
  const before = JSON.parse(fs.readFileSync(path.join(directory, "public-assets-receipt.json")));
  fs.writeFileSync(path.join(directory, "release-receipt.json"), '{"npm":{"latest":"1.3.10"}}');fs.writeFileSync(calls, "[]");
  const updated = run("receipt");assert.equal(updated.status, 0, updated.stderr);assert.deepEqual(JSON.parse(fs.readFileSync(calls)), ["release-receipt.json"]);
  const after = JSON.parse(fs.readFileSync(path.join(directory, "public-assets-receipt.json")));assert.equal(after.assets.length, 14);
  assert.deepEqual(after.assets.filter(row => row.name !== "release-receipt.json"), before.assets.filter(row => row.name !== "release-receipt.json"));
  assert.notEqual(after.assets.at(-1).sha256, before.assets.at(-1).sha256);
  fs.appendFileSync(path.join(directory, names[0]), "changed");fs.writeFileSync(calls, "[]");
  assert.notEqual(run("receipt").status, 0);assert.deepEqual(JSON.parse(fs.readFileSync(calls)), []);
});
