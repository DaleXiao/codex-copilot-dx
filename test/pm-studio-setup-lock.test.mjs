import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  pmStudioSetupLockPath,
  withPmStudioSetupLock,
} from "../src/pm-studio-setup-lock.mjs";

const roots = new Set();

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-pms-lock-"));
  roots.add(root);
  return root;
}

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function appHash(appPath) {
  return createHash("sha256").update(path.resolve(appPath)).digest("hex");
}

function lockRecord(appPath, overrides = {}) {
  return {
    app_path_sha256: appHash(appPath),
    kind: "ccdx-pm-studio-setup-lock",
    nonce: "a".repeat(32),
    pid: process.pid,
    schema_version: 1,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    ...overrides,
  };
}

function writeLock(lockPath, record) {
  fs.writeFileSync(lockPath, JSON.stringify(record), { mode: 0o600 });
}

test("setup lock path contains only the resolved app-path digest", () => {
  const root = temporaryRoot();
  const appPath = path.join(root, "private customer name", "..", "PM Studio.app");
  const lockPath = pmStudioSetupLockPath({ appPath, temporaryRoot: root });

  assert.equal(path.dirname(lockPath), path.resolve(root));
  assert.match(path.basename(lockPath), /^\.ccdx-pm-studio-setup-[0-9a-f]{64}\.lock$/);
  assert.doesNotMatch(lockPath, /private customer name|PM Studio/);
  assert.equal(lockPath, pmStudioSetupLockPath({
    appPath: path.resolve(appPath),
    temporaryRoot: root,
  }));
});

test("two concurrent setup calls allow only one callback to enter", async () => {
  const root = temporaryRoot();
  const appPath = path.join(root, "PM Studio.app");
  let release;
  let entered = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = withPmStudioSetupLock({ appPath, temporaryRoot: root }, async () => {
    entered += 1;
    await gate;
    return "first";
  });

  await assert.rejects(withPmStudioSetupLock({ appPath, temporaryRoot: root }, async () => {
    entered += 1;
  }), { code: "PM_STUDIO_SETUP_BUSY" });
  assert.equal(entered, 1);
  release();
  assert.equal(await first, "first");
  assert.equal(fs.existsSync(pmStudioSetupLockPath({ appPath, temporaryRoot: root })), false);
});

test("callback success, failure, and abort all release the owned lock", async (t) => {
  for (const [name, callback, expected] of [
    ["success", async () => 42, null],
    ["failure", async () => { throw new Error("fixture failure"); }, /fixture failure/],
    ["abort", async () => {
      const error = new Error("fixture abort");
      error.name = "AbortError";
      throw error;
    }, { name: "AbortError" }],
  ]) {
    await t.test(name, async () => {
      const root = temporaryRoot();
      const appPath = path.join(root, "PM Studio.app");
      if (expected) await assert.rejects(withPmStudioSetupLock({
        appPath, temporaryRoot: root,
      }, callback), expected);
      else assert.equal(await withPmStudioSetupLock({
        appPath, temporaryRoot: root,
      }, callback), 42);
      assert.equal(fs.existsSync(pmStudioSetupLockPath({ appPath, temporaryRoot: root })), false);
      assert.deepEqual(fs.readdirSync(root), []);
    });
  }
});

test("a strict same-owner record is reclaimed only when its pid is dead", async () => {
  const root = temporaryRoot();
  const appPath = path.join(root, "PM Studio.app");
  const lockPath = pmStudioSetupLockPath({ appPath, temporaryRoot: root });
  writeLock(lockPath, lockRecord(appPath, { pid: 1_234_567 }));
  const checked = [];

  const value = await withPmStudioSetupLock({
    appPath,
    temporaryRoot: root,
    processAlive: (pid) => {
      checked.push(pid);
      return false;
    },
  }, async () => "recovered");

  assert.equal(value, "recovered");
  assert.deepEqual(checked, [1_234_567]);
  assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("live, malformed, non-canonical, and foreign records remain untouched", async (t) => {
  const cases = [
    ["live", (appPath) => JSON.stringify(lockRecord(appPath)), () => true],
    ["malformed", () => "{", () => false],
    ["non-canonical", (appPath) => `${JSON.stringify(lockRecord(appPath))}\n`, () => false],
    ["extra field", (appPath) => JSON.stringify({ ...lockRecord(appPath), extra: true }), () => false],
    ["wrong app", (appPath) => JSON.stringify(lockRecord(appPath, { app_path_sha256: "b".repeat(64) })), () => false],
  ];
  for (const [name, contents, processAlive] of cases) {
    await t.test(name, async () => {
      const root = temporaryRoot();
      const appPath = path.join(root, "PM Studio.app");
      const lockPath = pmStudioSetupLockPath({ appPath, temporaryRoot: root });
      const original = contents(appPath);
      fs.writeFileSync(lockPath, original, { mode: 0o600 });

      await assert.rejects(withPmStudioSetupLock({
        appPath, temporaryRoot: root, processAlive,
      }, async () => {}), { code: "PM_STUDIO_SETUP_BUSY" });
      assert.equal(fs.readFileSync(lockPath, "utf8"), original);
    });
  }
});

test("a lock owned by another uid is never inspected as reclaimable", async () => {
  if (typeof process.getuid !== "function") return;
  const root = temporaryRoot();
  const appPath = path.join(root, "PM Studio.app");
  const lockPath = pmStudioSetupLockPath({ appPath, temporaryRoot: root });
  writeLock(lockPath, lockRecord(appPath, { pid: 1_234_567 }));
  let processChecked = false;
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property !== "lstatSync") return Reflect.get(target, property);
      return (...args) => {
        const stat = target.lstatSync(...args);
        return new Proxy(stat, {
          get(statTarget, statProperty) {
            if (statProperty === "uid") return process.getuid() + 1;
            return Reflect.get(statTarget, statProperty);
          },
        });
      };
    },
  });

  await assert.rejects(withPmStudioSetupLock({
    appPath,
    temporaryRoot: root,
    fsImpl,
    processAlive: () => {
      processChecked = true;
      return false;
    },
  }, async () => {}), { code: "PM_STUDIO_SETUP_BUSY" });
  assert.equal(processChecked, false);
  assert.equal(fs.existsSync(lockPath), true);
});

test("symlink and directory lock paths fail closed without touching their targets", async (t) => {
  await t.test("symlink", async () => {
    const root = temporaryRoot();
    const appPath = path.join(root, "PM Studio.app");
    const lockPath = pmStudioSetupLockPath({ appPath, temporaryRoot: root });
    const target = path.join(root, "target");
    fs.writeFileSync(target, "do not touch");
    fs.symlinkSync(target, lockPath);

    await assert.rejects(withPmStudioSetupLock({
      appPath, temporaryRoot: root, processAlive: () => false,
    }, async () => {}), { code: "PM_STUDIO_SETUP_BUSY" });
    assert.equal(fs.lstatSync(lockPath).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(target, "utf8"), "do not touch");
  });

  await t.test("directory", async () => {
    const root = temporaryRoot();
    const appPath = path.join(root, "PM Studio.app");
    const lockPath = pmStudioSetupLockPath({ appPath, temporaryRoot: root });
    fs.mkdirSync(lockPath);

    await assert.rejects(withPmStudioSetupLock({
      appPath, temporaryRoot: root, processAlive: () => false,
    }, async () => {}), { code: "PM_STUDIO_SETUP_BUSY" });
    assert.equal(fs.lstatSync(lockPath).isDirectory(), true);
  });
});

test("finally leaves a replacement lock with a different nonce untouched", async () => {
  const root = temporaryRoot();
  const appPath = path.join(root, "PM Studio.app");
  const lockPath = pmStudioSetupLockPath({ appPath, temporaryRoot: root });
  const replacement = lockRecord(appPath, { nonce: "b".repeat(32) });

  await withPmStudioSetupLock({ appPath, temporaryRoot: root }, async () => {
    fs.unlinkSync(lockPath);
    writeLock(lockPath, replacement);
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")), replacement);
});

test("stale reclamation never displaces a concurrently published live lock", async () => {
  const root = temporaryRoot();
  const appPath = path.join(root, "PM Studio.app");
  const lockPath = pmStudioSetupLockPath({ appPath, temporaryRoot: root });
  const replacement = lockRecord(appPath, { nonce: "b".repeat(32) });
  writeLock(lockPath, lockRecord(appPath, { nonce: "a".repeat(32), pid: 1_234_567 }));

  let injected = false;
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (!["linkSync", "renameSync"].includes(property)) return Reflect.get(target, property);
      return (source, destination) => {
        if (!injected && source === lockPath && destination.includes(".stale-")) {
          injected = true;
          const displacedStale = path.join(root, "displaced-stale");
          target.renameSync(source, displacedStale);
          target.unlinkSync(displacedStale);
          writeLock(lockPath, replacement);
        }
        return target[property](source, destination);
      };
    },
  });
  let entered = false;

  await assert.rejects(withPmStudioSetupLock({
    appPath,
    temporaryRoot: root,
    fsImpl,
    processAlive: () => false,
  }, async () => { entered = true; }), { code: "PM_STUDIO_SETUP_LOCK_UNSAFE" });

  assert.equal(injected, true);
  assert.equal(entered, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")), replacement);
  assert.deepEqual(fs.readdirSync(root), [path.basename(lockPath)]);
});
