import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseByteLimit, rotateFileIfNeededSync, rotatedFilePath } from "../src/file-rotation.mjs";

test("parseByteLimit: accepts zero as disabled and rejects malformed values", () => {
  assert.equal(parseByteLimit(undefined, 100), 100);
  assert.equal(parseByteLimit("0", 100), 0);
  assert.equal(parseByteLimit("42", 100), 42);
  assert.equal(parseByteLimit("42x", 100), 100);
  assert.equal(parseByteLimit("-1", 100), 100);
});

test("rotateFileIfNeededSync: retains one backup before an append would cross the limit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-rotate-"));
  const filePath = path.join(dir, "usage.jsonl");
  fs.writeFileSync(filePath, "12345678");

  assert.equal(rotateFileIfNeededSync(filePath, 2, 10), false);
  assert.equal(rotateFileIfNeededSync(filePath, 3, 10), true);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.readFileSync(rotatedFilePath(filePath), "utf8"), "12345678");
});
