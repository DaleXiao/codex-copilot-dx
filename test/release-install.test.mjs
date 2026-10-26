import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { downloadRelease, packageMetadata, protectInstallation, releaseBytes, releaseChecksum } from "../src/release-install.mjs";
function artifact(version = "1.2.1", name = "codex-copilot-dx") {
  const bytes = Buffer.from(JSON.stringify({ name, version })), header = Buffer.alloc(512);
  header.write("package/package.json");header.write(bytes.length.toString(8).padStart(11, "0"), 124);header[156] = 48;
  return gzipSync(Buffer.concat([header, bytes, Buffer.alloc(512 - bytes.length), Buffer.alloc(1024)]));
}
function directory(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-release-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));return root; }
test("release download verifies SHA256, package identity and tag before writing", async t => {
  const root = directory(t), bytes = artifact(), calls = [], name = "codex-copilot-dx-1.2.1.tgz";
  const result = await downloadRelease("v1.2.1", { directory: root, fetchImpl: async url => {
    calls.push(url);return new Response(url.endsWith("SHA256SUMS") ? `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n` : bytes);
  } });
  assert.equal(calls.length, 2);assert.ok(calls.every(url => url.startsWith("https://github.com/DaleXiao/codex-copilot-dx/releases/download/v1.2.1/")));
  assert.equal(result.version, "1.2.1");assert.deepEqual(fs.readFileSync(result.file), bytes);
});
test("corrupt, wrong-version and wrong-package release artifacts never reach installation", async t => {
  const root = directory(t), name = "codex-copilot-dx-1.2.1.tgz";
  for (const [bytes, checksum] of [[artifact(), "0".repeat(64)], [artifact("1.2.0"), null], [artifact("1.2.1", "other"), null]]) {
    await assert.rejects(downloadRelease("v1.2.1", { directory: root, fetchImpl: async url => new Response(url.endsWith("SHA256SUMS")
      ? `${checksum || createHash("sha256").update(bytes).digest("hex")}  ${name}\n` : bytes) }), /checksum mismatch|version does not match|identity is invalid/);
    assert.deepEqual(fs.readdirSync(root), []);
  }
  assert.throws(() => packageMetadata(Buffer.from("not gzip")));
  for (const manifest of ["", `x  ${name}\n`, `${"a".repeat(64)}  ${name}\n${"a".repeat(64)}  ${name}\n`]) assert.throws(() => releaseChecksum(Buffer.from(manifest), name));
  await assert.rejects(downloadRelease('v1.2.1&echo injected', { directory: root, fetchImpl() { assert.fail(); } }), /stable/);
});
test("downloads reject refusal, oversized and truncated bodies, and untrusted redirects", async () => {
  await assert.rejects(releaseBytes("https://github.com/a", { maxBytes: 10, fetchImpl: async () => new Response("denied", { status: 403 }) }), /HTTP 403/);
  await assert.rejects(releaseBytes("https://github.com/a", { maxBytes: 3, fetchImpl: async () => new Response("large") }), /did not finish/);
  const response = new Response("x");Object.defineProperty(response, "url", { value: "https://attacker.example/asset" });
  await assert.rejects(releaseBytes("https://github.com/a", { maxBytes: 10, fetchImpl: async () => response }), /refused/);
});
test("failed installation restores prior package and command bytes, success removes the backup", t => {
  const root = directory(t), prefix = path.join(root, "prefix 中文 & ! %PATH%"), target = path.join(prefix, "lib", "node_modules", "codex-copilot-dx");
  fs.mkdirSync(target, { recursive: true });fs.mkdirSync(path.join(prefix, "bin"));
  fs.writeFileSync(path.join(target, "old.txt"), "old package");fs.writeFileSync(path.join(prefix, "bin", "ccdx"), "old launcher");
  let transaction = protectInstallation({ target, prefix, platform: "darwin" });
  assert.throws(() => protectInstallation({ target, prefix }), /Another install/);
  fs.rmSync(target, { recursive: true });fs.mkdirSync(target);fs.writeFileSync(path.join(target, "new.txt"), "partial");
  fs.writeFileSync(path.join(prefix, "bin", "ccdx"), "changed");transaction.rollback();
  assert.equal(fs.readFileSync(path.join(target, "old.txt"), "utf8"), "old package");assert.equal(fs.existsSync(path.join(target, "new.txt")), false);
  assert.equal(fs.readFileSync(path.join(prefix, "bin", "ccdx"), "utf8"), "old launcher");
  transaction = protectInstallation({ target, prefix, platform: "darwin" });transaction.commit();
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["codex-copilot-dx"]);
});
test("a linked npm target is preserved before starting an install", t => {
  const root = directory(t), actual = path.join(root, "checkout"), target = path.join(root, "node_modules", "codex-copilot-dx");
  fs.mkdirSync(actual);fs.mkdirSync(path.dirname(target));fs.symlinkSync(actual, target, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => protectInstallation({ target, prefix: root }), /linked/);assert.equal(fs.realpathSync(target), fs.realpathSync(actual));
});

test("install locks identify their owner and backup, and keep legacy empty locks intact", t => {
  const root = directory(t), target = path.join(root, "node_modules", "codex-copilot-dx"), lock = path.join(path.dirname(target), ".ccdx-install.lock");
  const transaction = protectInstallation({ target, prefix: root });
  const record = JSON.parse(fs.readFileSync(lock, "utf8"));
  assert.equal(record.version, 1);assert.equal(record.pid, process.pid);assert.ok(Number.isFinite(Date.parse(record.created_at)));
  assert.equal(path.dirname(record.backup), path.dirname(target));assert.equal(fs.statSync(record.backup).isDirectory(), true);
  assert.throws(() => protectInstallation({ target, prefix: root }), error => error.cause?.code === "EEXIST" && error.message.includes(lock));
  transaction.commit();fs.writeFileSync(lock, "");
  const old = new Date(Date.now() - 5 * 86400000);fs.utimesSync(lock, old, old);
  const modified = fs.statSync(lock).mtimeMs;
  assert.throws(() => protectInstallation({ target, prefix: root }), error => error.cause?.code === "EEXIST" && error.message.includes(lock));
  assert.equal(fs.readFileSync(lock, "utf8"), "");assert.equal(fs.statSync(lock).mtimeMs, modified);
});

test("install-lock I/O failures are not reported as another running installation", t => {
  const root = directory(t), target = path.join(root, "node_modules", "codex-copilot-dx"), lock = path.join(path.dirname(target), ".ccdx-install.lock");
  fs.mkdirSync(path.dirname(target));
  const original = fs.openSync;
  t.mock.method(fs, "openSync", function (file, ...args) {
    if (file === lock) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return original.call(this, file, ...args);
  });
  assert.throws(() => protectInstallation({ target, prefix: root }), error => error.cause?.code === "EACCES" && /permissions/i.test(error.message) && error.message.includes(lock) && !/Another install/.test(error.message));
  assert.deepEqual(fs.readdirSync(path.dirname(target)), []);
  t.mock.restoreAll();
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", function (file, ...args) {
    if (typeof file === "number") throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return write.call(this, file, ...args);
  });
  assert.throws(() => protectInstallation({ target, prefix: root }), { code: "ENOSPC" });
  assert.deepEqual(fs.readdirSync(path.dirname(target)), []);
});

test("private POSIX commands preserve uppercase prefix and quote shell paths", { skip: process.platform === "win32" }, async t => {
  const { writePrivateLaunchers } = await import("../src/release-install.mjs"), { execFileSync } = await import("node:child_process");
  const root = directory(t), prefix = path.join(root, "prefix ' \" $() ` !"), target = path.join(prefix, "lib", "node_modules", "codex-copilot-dx");
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });fs.mkdirSync(path.join(target, "bin"), { recursive: true });
  fs.writeFileSync(path.join(target, "bin", "cli.mjs"), 'console.log(JSON.stringify({prefix:process.env.npm_config_prefix,upper:process.env.NPM_CONFIG_PREFIX,private:process.env.CCDX_PRIVATE_INSTALL_PREFIX}));');
  await writePrivateLaunchers({ prefix, target });
  const env = { ...process.env, PATH: "/nonexistent", NPM_CONFIG_PREFIX: "/chosen-prefix" };delete env.npm_config_prefix;
  const result = JSON.parse(execFileSync(path.join(prefix, "bin", "ccdx"), [], { env, encoding: "utf8" }));
  assert.equal(result.upper, "/chosen-prefix");assert.equal(result.prefix, undefined);assert.equal(result.private, prefix);
});

test('installation rollback restores a relative launcher without following its dangling backup link', async t => {
 if(process.platform==='win32')return t.skip('POSIX npm launcher layout');
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const {protectInstallation}=await import('../src/release-install.mjs');
 const prefix=fs.mkdtempSync(path.join(os.tmpdir(),'ccdx-relative-launcher-'));t.after(()=>fs.rmSync(prefix,{recursive:true,force:true}));
 const target=path.join(prefix,'lib/node_modules/codex-copilot-dx');fs.mkdirSync(path.join(target,'bin'),{recursive:true});fs.mkdirSync(path.join(prefix,'bin'));
 fs.writeFileSync(path.join(target,'bin/cli.mjs'),'original');fs.symlinkSync('../lib/node_modules/codex-copilot-dx/bin/cli.mjs',path.join(prefix,'bin/ccdx'));
 const transaction=protectInstallation({target,prefix});fs.writeFileSync(path.join(target,'bin/cli.mjs'),'replacement');
 transaction.rollback();transaction.rollback();
 assert.equal(fs.readFileSync(path.join(prefix,'bin/ccdx'),'utf8'),'original');assert.equal(fs.readlinkSync(path.join(prefix,'bin/ccdx')),'../lib/node_modules/codex-copilot-dx/bin/cli.mjs');
});
