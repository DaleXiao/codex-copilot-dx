import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

const LOCK_KIND = "ccdx-pm-studio-setup-lock";
const LOCK_SCHEMA_VERSION = 1;
const MAX_LOCK_BYTES = 2_048;
const MAX_ACQUIRE_ATTEMPTS = 8;
const LOCK_RECORD_KEYS = Object.freeze([
  "app_path_sha256",
  "kind",
  "nonce",
  "pid",
  "schema_version",
  "uid",
]);

function setupLockError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function sameFile(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function isOwnedRegularFile(stat, uid) {
  return stat?.isFile?.() === true
    && stat?.isSymbolicLink?.() !== true
    && (uid === null || stat.uid === uid);
}

function strictLockRecord(text, appPathSha256, uid) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return null;
  }
  if (!record || Array.isArray(record) || typeof record !== "object"
    || JSON.stringify(record) !== text
    || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(LOCK_RECORD_KEYS)
    || record.schema_version !== LOCK_SCHEMA_VERSION
    || record.kind !== LOCK_KIND
    || record.app_path_sha256 !== appPathSha256
    || !Number.isSafeInteger(record.pid)
    || record.pid <= 0
    || record.pid > 0x7fff_ffff
    || record.uid !== uid
    || typeof record.nonce !== "string"
    || !/^[0-9a-f]{32}$/.test(record.nonce)) {
    return null;
  }
  return record;
}

function readLockSnapshot(lockPath, appPathSha256, io, uid) {
  let before;
  try {
    before = io.lstatSync(lockPath, { bigint: false });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!isOwnedRegularFile(before, uid)
    || !Number.isSafeInteger(before.size)
    || before.size <= 0
    || before.size > MAX_LOCK_BYTES) {
    return { safe: false };
  }

  const noFollow = io.constants?.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = io.openSync(lockPath, io.constants.O_RDONLY | noFollow);
    const opened = io.fstatSync(descriptor, { bigint: false });
    if (!isOwnedRegularFile(opened, uid)
      || !sameFile(before, opened)
      || opened.size !== before.size) {
      return { safe: false };
    }
    const text = io.readFileSync(descriptor, { encoding: "utf8" });
    const after = io.fstatSync(descriptor, { bigint: false });
    if (!sameFile(opened, after)
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs) {
      return { safe: false };
    }
    const record = strictLockRecord(text, appPathSha256, uid);
    return record ? { safe: true, stat: opened, record } : { safe: false };
  } catch (error) {
    if (["ELOOP", "ENOENT"].includes(error?.code)) return { safe: false };
    throw error;
  } finally {
    if (descriptor !== undefined) io.closeSync(descriptor);
  }
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function writeCandidate(candidatePath, record, io) {
  const noFollow = io.constants?.O_NOFOLLOW || 0;
  const descriptor = io.openSync(
    candidatePath,
    io.constants.O_WRONLY | io.constants.O_CREAT | io.constants.O_EXCL | noFollow,
    0o600,
  );
  try {
    io.writeFileSync(descriptor, JSON.stringify(record), { encoding: "utf8" });
    io.fsyncSync(descriptor);
    return io.fstatSync(descriptor, { bigint: false });
  } finally {
    io.closeSync(descriptor);
  }
}

function removeOwnLock(lockPath, ownership, appPathSha256, io, uid) {
  let snapshot;
  try {
    snapshot = readLockSnapshot(lockPath, appPathSha256, io, uid);
  } catch {
    return;
  }
  if (!snapshot?.safe
    || snapshot.record.nonce !== ownership.nonce
    || !sameFile(snapshot.stat, ownership.stat)) {
    return;
  }
  try {
    io.unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function reclaimStaleLock(lockPath, snapshot, io, uid) {
  const quarantinePath = `${lockPath}.stale-${randomBytes(16).toString("hex")}`;
  try {
    io.renameSync(lockPath, quarantinePath);
  } catch (error) {
    if (["ENOENT", "EEXIST"].includes(error?.code)) return false;
    throw error;
  }

  let moved;
  try {
    moved = io.lstatSync(quarantinePath, { bigint: false });
    if (!isOwnedRegularFile(moved, uid) || !sameFile(moved, snapshot.stat)) {
      try {
        io.linkSync(quarantinePath, lockPath);
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw setupLockError(
            "PM_STUDIO_SETUP_LOCK_UNSAFE",
            "PM Studio setup lock changed and could not be restored safely",
            error,
          );
        }
      }
      try {
        io.unlinkSync(quarantinePath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      throw setupLockError(
        "PM_STUDIO_SETUP_LOCK_UNSAFE",
        "PM Studio setup lock changed while a stale record was being isolated",
      );
    }
    io.unlinkSync(quarantinePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function createLockRecord(appPathSha256, uid) {
  return {
    app_path_sha256: appPathSha256,
    kind: LOCK_KIND,
    nonce: randomBytes(16).toString("hex"),
    pid: process.pid,
    schema_version: LOCK_SCHEMA_VERSION,
    uid,
  };
}

export function pmStudioSetupLockPath({ appPath, temporaryRoot = os.tmpdir() } = {}) {
  if (typeof appPath !== "string" || appPath.length === 0) {
    throw new TypeError("PM Studio app path is required for the setup lock");
  }
  if (typeof temporaryRoot !== "string" || temporaryRoot.length === 0) {
    throw new TypeError("PM Studio setup lock temporary root is required");
  }
  const appPathSha256 = sha256Hex(path.resolve(appPath));
  return path.join(path.resolve(temporaryRoot), `.ccdx-pm-studio-setup-${appPathSha256}.lock`);
}

export async function withPmStudioSetupLock({
  appPath,
  temporaryRoot = os.tmpdir(),
  fsImpl = fs,
  processAlive = defaultProcessAlive,
} = {}, fn) {
  if (typeof fn !== "function") throw new TypeError("PM Studio setup lock callback is required");
  if (!fsImpl || typeof processAlive !== "function") {
    throw new TypeError("PM Studio setup lock dependencies are invalid");
  }

  const lockPath = pmStudioSetupLockPath({ appPath, temporaryRoot });
  const appPathSha256 = path.basename(lockPath).slice(
    ".ccdx-pm-studio-setup-".length,
    -".lock".length,
  );
  const uid = currentUid();
  let ownership = null;

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS && !ownership; attempt += 1) {
    const record = createLockRecord(appPathSha256, uid);
    const candidatePath = `${lockPath}.candidate-${record.nonce}`;
    let publicationError = null;
    try {
      const candidateStat = writeCandidate(candidatePath, record, fsImpl);
      try {
        fsImpl.linkSync(candidatePath, lockPath);
        ownership = { nonce: record.nonce, stat: candidateStat };
        const stat = fsImpl.lstatSync(lockPath, { bigint: false });
        if (!isOwnedRegularFile(stat, uid) || !sameFile(stat, candidateStat)) {
          throw setupLockError(
            "PM_STUDIO_SETUP_LOCK_UNSAFE",
            "PM Studio setup lock was not published as an owned regular file",
          );
        }
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    } catch (error) {
      publicationError = error;
    } finally {
      try {
        fsImpl.unlinkSync(candidatePath);
      } catch (error) {
        if (error?.code !== "ENOENT" && !publicationError) publicationError = error;
      }
    }
    if (publicationError) {
      if (ownership?.nonce === record.nonce) {
        removeOwnLock(lockPath, ownership, appPathSha256, fsImpl, uid);
        ownership = null;
      }
      throw publicationError;
    }

    if (ownership) break;
    let snapshot;
    try {
      snapshot = readLockSnapshot(lockPath, appPathSha256, fsImpl, uid);
    } catch (error) {
      throw setupLockError(
        "PM_STUDIO_SETUP_LOCK_FAILED",
        "PM Studio setup lock could not be inspected safely",
        error,
      );
    }
    if (!snapshot) continue;
    if (!snapshot.safe) {
      throw setupLockError(
        "PM_STUDIO_SETUP_BUSY",
        "PM Studio setup is locked by an unverified lock record; no files were changed",
      );
    }

    let alive = true;
    try {
      alive = processAlive(snapshot.record.pid) !== false;
    } catch {
      alive = true;
    }
    if (alive) {
      throw setupLockError(
        "PM_STUDIO_SETUP_BUSY",
        `PM Studio setup is already running in process ${snapshot.record.pid}; no files were changed`,
      );
    }
    try {
      reclaimStaleLock(lockPath, snapshot, fsImpl, uid);
    } catch (error) {
      if (error?.code === "PM_STUDIO_SETUP_LOCK_UNSAFE") throw error;
      throw setupLockError(
        "PM_STUDIO_SETUP_LOCK_FAILED",
        "PM Studio stale setup lock could not be reclaimed safely",
        error,
      );
    }
  }

  if (!ownership) {
    throw setupLockError(
      "PM_STUDIO_SETUP_BUSY",
      "PM Studio setup lock changed repeatedly; no files were changed",
    );
  }

  try {
    return await fn();
  } finally {
    removeOwnLock(lockPath, ownership, appPathSha256, fsImpl, uid);
  }
}
