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
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
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
