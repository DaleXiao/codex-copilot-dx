import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFileIfChangedSync, atomicWriteFileSync } from "../src/atomic-file.mjs";

test("atomicWriteFileSync: replaces content, preserves mode, and removes temp files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-atomic-"));
  const filePath = path.join(dir, "config.json");
  fs.writeFileSync(filePath, "before", { mode: 0o640 });

  atomicWriteFileSync(filePath, "after");

  assert.equal(fs.readFileSync(filePath, "utf8"), "after");
  if (process.platform !== "win32") assert.equal(fs.statSync(filePath).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
});

test("atomicWriteFileSync: can explicitly replace an existing mode", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-atomic-mode-"));
  const filePath = path.join(dir, "secret");
  fs.writeFileSync(filePath, "before", { mode: 0o640 });

  atomicWriteFileSync(filePath, "after", { mode: 0o600, preserveMode: false });

  assert.equal(fs.readFileSync(filePath, "utf8"), "after");
  if (process.platform !== "win32") assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("atomicWriteFileIfChangedSync: does not replace identical content", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-atomic-same-"));
  const filePath = path.join(dir, "config.toml");
  fs.writeFileSync(filePath, "same", { mode: 0o600 });
  const before = fs.statSync(filePath);
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(atomicWriteFileIfChangedSync(filePath, "same"), false);
  const after = fs.statSync(filePath);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(atomicWriteFileIfChangedSync(filePath, "changed"), true);
  assert.equal(fs.readFileSync(filePath, "utf8"), "changed");
});

test('async paired writes restore both files when the activation write fails', async t => {
  const { atomicWriteFile, atomicWriteFilePair } = await import('../src/atomic-file.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdx-async-pair-'));t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = path.join(dir, 'primary'), b = path.join(dir, 'marker');
  await atomicWriteFile(a, 'before-a');await atomicWriteFile(b, 'before-b');let reject = true;
  await assert.rejects(atomicWriteFilePair(a, 'after-a', b, 'after-b', { writeFile: async (file, value, options) => {
    if (file === b && reject) { reject = false;throw Error('fixture activation failed'); }
    await atomicWriteFile(file, value, options);
  } }), /activation failed/);
  assert.equal(fs.readFileSync(a, 'utf8'), 'before-a');assert.equal(fs.readFileSync(b, 'utf8'), 'before-b');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['marker', 'primary']);
});
