import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendRotatingLines, parseByteLimit, rotateFileIfNeededSync, rotatedFilePath } from "../src/file-rotation.mjs";

test("parseByteLimit: accepts zero as disabled and rejects malformed values", () => {
  assert.equal(parseByteLimit(undefined, 100), 100);
  assert.equal(parseByteLimit("0", 100), 0);
  assert.equal(parseByteLimit("42", 100), 42);
  assert.equal(parseByteLimit("42x", 100), 100);
  assert.equal(parseByteLimit("-1", 100), 100);
});

test("async batches preserve per-record rotation boundaries and never rotate a directory", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-rotate-batch-"));
  try {
    const filePath = path.join(dir, "log");
    await appendRotatingLines(filePath, ["1234\n", "5678\n", "next\n"], 10);
    assert.equal(fs.readFileSync(`${filePath}.1`, "utf8"), "1234\n5678\n");
    assert.equal(fs.readFileSync(filePath, "utf8"), "next\n");
    const directoryPath = path.join(dir, "directory");
    fs.mkdirSync(directoryPath);
    fs.writeFileSync(path.join(directoryPath, "keep"), "user fixture");
    await assert.rejects(appendRotatingLines(directoryPath, ["long log entry"], 1), /not a regular file/);
    assert.equal(fs.readFileSync(path.join(directoryPath, "keep"), "utf8"), "user fixture");
    assert.equal(fs.existsSync(`${directoryPath}.1`), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
