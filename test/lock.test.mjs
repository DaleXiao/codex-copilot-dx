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

test("withFileLock: stale reclaim restores a lock replaced before quarantine", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-lock-stale-replaced-"));
  const lockPath = path.join(dir, "state.lock");
  const replacement = JSON.stringify({ pid: process.pid, owner: "replacement" });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, owner: "dead" }), { mode: 0o600 });
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockPath, old, old);
  let injected = false;
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property !== "renameSync") return Reflect.get(target, property);
      return (source, destination) => {
        if (!injected && source === lockPath && destination.includes(".stale-")) {
          injected = true;
          target.writeFileSync(source, replacement, { mode: 0o600 });
        }
        return target.renameSync(source, destination);
      };
    },
  });
  let entered = false;

  await assert.rejects(withFileLock(lockPath, async () => { entered = true; }, {
    timeoutMs: 20,
    staleMs: 10,
    pollMs: 2,
    fsImpl,
  }), /Timed out waiting for lock/);

  assert.equal(injected, true);
  assert.equal(entered, false);
  assert.equal(fs.readFileSync(lockPath, "utf8"), replacement);
  assert.deepEqual(fs.readdirSync(dir), ["state.lock"]);
});

test("withFileLock: stale reclaim does not remove a new canonical lock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-lock-stale-new-"));
  const lockPath = path.join(dir, "state.lock");
  const replacement = JSON.stringify({ pid: process.pid, owner: "replacement" });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, owner: "dead" }), { mode: 0o600 });
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockPath, old, old);
  let injected = false;
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property !== "renameSync") return Reflect.get(target, property);
      return (source, destination) => {
        const result = target.renameSync(source, destination);
        if (!injected && source === lockPath && destination.includes(".stale-")) {
          injected = true;
          target.writeFileSync(source, replacement, { mode: 0o600 });
        }
        return result;
      };
    },
  });
  let entered = false;

  await assert.rejects(withFileLock(lockPath, async () => { entered = true; }, {
    timeoutMs: 20,
    staleMs: 10,
    pollMs: 2,
    fsImpl,
  }), /Timed out waiting for lock/);

  assert.equal(injected, true);
  assert.equal(entered, false);
  assert.equal(fs.readFileSync(lockPath, "utf8"), replacement);
  assert.deepEqual(fs.readdirSync(dir), ["state.lock"]);
});

test("withFileLock: reclaims a malformed legacy stale regular file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-lock-stale-malformed-"));
  const lockPath = path.join(dir, "state.lock");
  fs.writeFileSync(lockPath, "{", { mode: 0o600 });
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockPath, old, old);
  let entered = false;

  await withFileLock(lockPath, async () => { entered = true; }, {
    timeoutMs: 100,
    staleMs: 10,
    pollMs: 2,
  });

  assert.equal(entered, true);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("withFileLock: a cooperating acquirer cannot enter during stale quarantine", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-lock-reclaim-guard-"));
  const lockPath = path.join(dir, "state.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, owner: "dead" }), { mode: 0o600 });
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockPath, old, old);
  const events = [];
  let contender;
  let releaseFirst;
  let firstEntered;
  const firstIsEntered = new Promise((resolve) => { firstEntered = resolve; });
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property !== "renameSync") return Reflect.get(target, property);
      return (source, destination) => {
        const result = target.renameSync(source, destination);
        if (!contender && source === lockPath && destination.includes(".stale-")) {
          contender = withFileLock(lockPath, async () => { events.push("contender"); }, {
            timeoutMs: 1000,
            staleMs: 10,
            pollMs: 2,
          });
        }
        return result;
      };
    },
  });

  const first = withFileLock(lockPath, async () => {
    events.push("first:start");
    firstEntered();
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push("first:end");
  }, { timeoutMs: 1000, staleMs: 10, pollMs: 2, fsImpl });

  await firstIsEntered;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, contender]);
  assert.deepEqual(events, ["first:start", "first:end", "contender"]);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("withFileLock: retries stale reclaim after a transient quarantine unlink failure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-lock-stale-unlink-"));
  const lockPath = path.join(dir, "state.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, owner: "dead" }), { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);
  let failed = false;
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property !== "unlinkSync") return Reflect.get(target, property);
      return (targetPath) => {
        if (!failed && targetPath.startsWith(`${lockPath}.stale-`)) {
          failed = true;
          const error = new Error("transient unlink failure");
          error.code = "EIO";
          throw error;
        }
        return target.unlinkSync(targetPath);
      };
    },
  });
  let entered = false;

  await withFileLock(lockPath, async () => { entered = true; }, {
    timeoutMs: 100,
    staleMs: 10,
    pollMs: 2,
    fsImpl,
    processAlive: () => false,
  });

  assert.equal(failed, true);
  assert.equal(entered, true);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("withFileLock: retries abandoned guard cleanup after a transient quarantine unlink failure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-lock-guard-unlink-"));
  const lockPath = path.join(dir, "state.lock");
  const guardPath = `${lockPath}.reclaim`;
  fs.writeFileSync(guardPath, JSON.stringify({ pid: 2147483647, owner: "dead" }), { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(guardPath, old, old);
  let failed = false;
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property !== "unlinkSync") return Reflect.get(target, property);
      return (targetPath) => {
        if (!failed && targetPath.startsWith(`${guardPath}.stale-`)) {
          failed = true;
          const error = new Error("transient unlink failure");
          error.code = "EIO";
          throw error;
        }
        return target.unlinkSync(targetPath);
      };
    },
  });

  await withFileLock(lockPath, async () => {}, {
    timeoutMs: 100,
    staleMs: 10,
    pollMs: 2,
    fsImpl,
    processAlive: () => false,
  });

  assert.equal(failed, true);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("withFileLock: a persistent quarantine unlink failure stays available without amplifying leftovers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-lock-persistent-unlink-"));
  const lockPath = path.join(dir, "state.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, owner: "dead" }), { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);
  let failures = 0;
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property !== "unlinkSync") return Reflect.get(target, property);
      return (targetPath) => {
        if (targetPath.startsWith(`${lockPath}.stale-`)) {
          failures += 1;
          const error = new Error("persistent unlink failure");
          error.code = "EIO";
          throw error;
        }
        return target.unlinkSync(targetPath);
      };
    },
  });
  let entered = false;

  await withFileLock(lockPath, async () => { entered = true; }, {
    timeoutMs: 100,
    staleMs: 10,
    pollMs: 2,
    fsImpl,
    processAlive: () => false,
  });

  assert.equal(entered, true);
  assert.equal(failures, 2, "one failed removal plus one best-effort recovery attempt");
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith("state.lock.stale-")).length, 1);
});

test("withFileLock: quarantine recovery never overwrites a concurrent canonical owner", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-lock-stale-owner-race-"));
  const lockPath = path.join(dir, "state.lock");
  const stale = JSON.stringify({ pid: 2147483647, owner: "dead" });
  const replacement = JSON.stringify({ pid: process.pid, owner: "replacement" });
  fs.writeFileSync(lockPath, stale, { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);
  let injected = false;
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property !== "unlinkSync") return Reflect.get(target, property);
      return (targetPath) => {
        if (!injected && targetPath.startsWith(`${lockPath}.stale-`)) {
          injected = true;
          target.writeFileSync(lockPath, replacement, { mode: 0o600 });
          const error = new Error("transient unlink failure");
          error.code = "EIO";
          throw error;
        }
        return target.unlinkSync(targetPath);
      };
    },
  });
  let entered = false;

  await assert.rejects(withFileLock(lockPath, async () => { entered = true; }, {
    timeoutMs: 20,
    staleMs: 10,
    pollMs: 2,
    fsImpl,
  }), /Timed out waiting for lock/);

  assert.equal(injected, true);
  assert.equal(entered, false);
  assert.equal(fs.readFileSync(lockPath, "utf8"), replacement);
  const quarantine = fs.readdirSync(dir).filter((name) => name.startsWith("state.lock.stale-"));
  assert.equal(quarantine.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, quarantine[0]), "utf8"), stale);
});
