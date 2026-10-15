import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectWindowsCommand } from "../src/windows-command.mjs";

const template = fs.readFileSync(new URL("./fixtures/npm-ccdx.ps1", import.meta.url), "utf8");
function fixture(t) {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-command test-"));
  t.after(() => fs.rmSync(prefix, { recursive: true, force: true }));
  const root = path.join(prefix, "node_modules", "codex-copilot-dx");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "codex-copilot-dx", bin: { ccdx: "bin/cli.mjs", "codex-copilot-dx": "bin/codex-copilot-dx.mjs" } }));
  for (const [name, script] of [["ccdx", "cli.mjs"], ["codex-copilot-dx", "codex-copilot-dx.mjs"]]) {
    fs.writeFileSync(path.join(prefix, `${name}.ps1`), template.replaceAll("/cli.mjs", `/${script}`).replaceAll("\n", "\r\n"));
    fs.writeFileSync(path.join(prefix, `${name}.cmd`), `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\codex-copilot-dx\\bin\\${script}" %*\r\n`);
  }
  return { prefix, options: { platform: "win32", packageRoot: root } };
}

test("Windows command repair removes only exact npm-owned PS shims, preserves cmd and is idempotent", t => {
  const { prefix, options } = fixture(t);
  assert.equal(inspectWindowsCommand(options).status, "repairable");
  assert.equal(fs.existsSync(path.join(prefix, "ccdx.ps1")), true);
  const result = inspectWindowsCommand({ ...options, repair: true });
  assert.equal(result.status, "ready");assert.equal(result.changed, true);
  assert.equal(fs.existsSync(path.join(prefix, "ccdx.ps1")), false);
  assert.equal(fs.existsSync(path.join(prefix, "ccdx.cmd")), true);
  assert.equal(inspectWindowsCommand({ ...options, repair: true }).changed, false);
});

test("custom, symlinked, oversized, absent cmd and wrong-package launchers are preserved", t => {
  for (const variant of ["custom", "oversized", "missing-cmd", "package", ...(process.platform === "win32" ? [] : ["symlink"])]) {
    const { prefix, options } = fixture(t), file = path.join(prefix, "ccdx.ps1");
    if (variant === "custom") fs.appendFileSync(file, "# custom\n");
    if (variant === "oversized") fs.writeFileSync(file, "x".repeat(10000));
    if (variant === "missing-cmd") fs.unlinkSync(path.join(prefix, "ccdx.cmd"));
    if (variant === "package") fs.writeFileSync(path.join(options.packageRoot, "package.json"), "{}");
    if (variant === "symlink") { fs.renameSync(file, file + ".original"); fs.symlinkSync(file + ".original", file); }
    const before = fs.readFileSync(file);
    inspectWindowsCommand({ ...options, repair: true });
    assert.deepEqual(fs.readFileSync(file), before, variant);
  }
});

test("macOS/Linux and source checkouts are untouched", t => {
  const { prefix, options } = fixture(t);
  for (const platform of ["darwin", "linux"]) assert.equal(inspectWindowsCommand({ ...options, platform, repair: true }).status, "not_applicable");
  assert.equal(inspectWindowsCommand({ platform: "win32", packageRoot: prefix, repair: true }).status, "checkout");
  assert.equal(fs.existsSync(path.join(prefix, "ccdx.ps1")), true);
});
