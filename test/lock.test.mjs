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

test("withFileLock: does not reclaim a live owner after the stale interval", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-lock-live-"));
  const lockPath = path.join(dir, "state.lock");
  let releaseFirst;
  let firstLocked;
  const firstIsLocked = new Promise((resolve) => { firstLocked = resolve; });

  const first = withFileLock(lockPath, async () => {
    firstLocked();
    await new Promise((resolve) => { releaseFirst = resolve; });
  }, { timeoutMs: 1000, staleMs: 5, pollMs: 2 });

  await firstIsLocked;
  await new Promise((resolve) => setTimeout(resolve, 15));
  await assert.rejects(
    withFileLock(lockPath, async () => {}, { timeoutMs: 20, staleMs: 5, pollMs: 2 }),
    /Timed out waiting for lock/,
  );

  releaseFirst();
  await first;
});

test("withFileLock: an old owner does not delete a replacement lock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-lock-owner-"));
  const lockPath = path.join(dir, "state.lock");
  const replacement = JSON.stringify({ pid: process.pid, owner: "replacement" });

  await withFileLock(lockPath, async () => {
    fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, replacement, { mode: 0o600 });
  });

  assert.equal(fs.readFileSync(lockPath, "utf8"), replacement);
  fs.unlinkSync(lockPath);
});

test("withFileLock: reclaims a stale lock whose process is gone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-lock-stale-"));
  const lockPath = path.join(dir, "state.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, owner: "dead" }), { mode: 0o600 });
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockPath, old, old);
  let entered = false;

  await withFileLock(lockPath, async () => {
    entered = true;
  }, { timeoutMs: 100, staleMs: 10, pollMs: 2 });

  assert.equal(entered, true);
  assert.equal(fs.existsSync(lockPath), false);
});
