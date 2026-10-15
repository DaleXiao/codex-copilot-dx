import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readBoundedFileSync } from "../src/bounded-file.mjs";
import { inspectCredentialPermissions } from "../src/credential-permissions.mjs";
import { readUserSettings, userSettingsPath } from "../src/user-settings.mjs";
import { readImageProviderConfig, imageProviderConfigPath } from "../src/image-provider-config.mjs";
import { loadModelCache, modelCachePath } from "../src/model-cache.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-bounded-file-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "fixture");return { root, file };
}
test("bounded files preserve bytes and reject size before reading", t => {
  const { file } = fixture(t);fs.writeFileSync(file, "中文");
  assert.equal(readBoundedFileSync(file, { maxBytes: 6, encoding: "utf8" }), "中文");
  assert.deepEqual(readBoundedFileSync(file, { maxBytes: 6 }), Buffer.from("中文"));
  t.mock.method(fs, "readSync", () => assert.fail("oversized snapshot must not be read"));
  assert.throws(() => readBoundedFileSync(file, { maxBytes: 5 }), /read limit/);
  assert.throws(() => readBoundedFileSync(file, { maxBytes: Infinity }), /Invalid/);
});
test("bounded file handles growth, empty files and missing files without overwriting", t => {
  const { file } = fixture(t);fs.writeFileSync(file, "");
  assert.equal(readBoundedFileSync(file).length, 0);
  fs.writeFileSync(file, "a");const original = fs.readSync;let first = true;
  t.mock.method(fs, "readSync", (...args) => { if (first) { first = false;fs.appendFileSync(file, "b"); }return original(...args); });
  assert.throws(() => readBoundedFileSync(file), /grew during/);
  assert.equal(fs.readFileSync(file, "utf8"), "ab");
  assert.throws(() => readBoundedFileSync(file + "-missing"), { code: "ENOENT" });
});
test("oversized local settings retain strict/non-strict behavior and preserve files", t => {
  const { root } = fixture(t), options = { home: root, env: {} };
  for (const [file, read] of [[userSettingsPath(options), () => readUserSettings({ ...options, strict: true })],
    [imageProviderConfigPath(options), () => readImageProviderConfig({ ...options, strict: true })]]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, "");fs.truncateSync(file, 1024 * 1024 + 1);
    assert.throws(read, /read limit/);assert.equal(fs.statSync(file).size, 1024 * 1024 + 1);
  }
  assert.equal(readImageProviderConfig(options), null);
  const model = modelCachePath(root);fs.mkdirSync(path.dirname(model), { recursive: true });fs.writeFileSync(model, "");fs.truncateSync(model, 9 * 1024 * 1024 + 1);
  assert.equal(loadModelCache({ home: root }), null);
});
test("permission diagnostics are readonly, bounded and do not expose identities", t => {
  const { file } = fixture(t);fs.writeFileSync(file, "synthetic secret", { mode: 0o600 });
  const before = fs.readFileSync(file);
  assert.equal(inspectCredentialPermissions(file, { platform: "win32", exec(command, args, options) {
    assert.ok(command.endsWith("powershell.exe"));assert.ok(!args.at(-1).includes("Set-Acl"));
    assert.equal(options.env.CCDX_PERMISSION_FILE, file);assert.equal(options.timeout, 3000);return '{"review":true}';
  } }), "review");
  assert.equal(inspectCredentialPermissions(file, { platform: "win32", exec: () => "{}" }), "unavailable");
  assert.deepEqual(fs.readFileSync(file), before);
});
test("real Windows NTFS inspection detects a broader grant without changing it", { skip: process.platform !== "win32" }, t => {
  const { file } = fixture(t);fs.writeFileSync(file, "synthetic secret", { mode: 0o600 });
  const shell = path.win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const env = { ...process.env, CCDX_PERMISSION_FILE: file,
    PSModulePath: path.win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules")
      + (process.env.PSModulePath ? `;${process.env.PSModulePath}` : "") };
  execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "$a=Get-Acl -LiteralPath $env:CCDX_PERMISSION_FILE;$r=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow');$a.AddAccessRule($r);Set-Acl -LiteralPath $env:CCDX_PERMISSION_FILE -AclObject $a"], { env, windowsHide: true });
  const acl = () => execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "(Get-Acl -LiteralPath $env:CCDX_PERMISSION_FILE).Sddl"], { env, encoding: "utf8", windowsHide: true });
  // Hosted Windows runners can take several seconds just to start PowerShell.
  // Only this real-ACL fixture gets more bootstrap time; production remains 3s.
  const before = acl();assert.equal(inspectCredentialPermissions(file, {
    exec: (command, args, options) => execFileSync(command, args, { ...options, timeout: 20000 }),
  }), "review");assert.equal(acl(), before);
  assert.equal(fs.readFileSync(file, "utf8"), "synthetic secret");
});
