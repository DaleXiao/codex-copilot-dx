import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "../src/lock.mjs";

test("withFileLock: serializes concurrent lock holders", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-lock-"));
  const lockPath = path.join(dir, "state.lock");
  const events = [];
  let releaseFirst;
  let firstLocked;
  const firstIsLocked = new Promise((resolve) => { firstLocked = resolve; });

  const first = withFileLock(lockPath, async () => {
    events.push("first:start");
    firstLocked();
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push("first:end");
  }, { timeoutMs: 1000, pollMs: 5 });

  await firstIsLocked;
  const second = withFileLock(lockPath, async () => {
    events.push("second");
  }, { timeoutMs: 1000, pollMs: 5 });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ["first:start"]);

  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(events, ["first:start", "first:end", "second"]);
  assert.equal(fs.existsSync(lockPath), false);
});
