import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLockSnapshot(lockPath) {
  const stat = fs.statSync(lockPath);
  let record = {};
  try {
    record = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {}
  return {
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    pid: Number(record.pid),
    owner: typeof record.owner === "string" ? record.owner : "",
  };
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

function readStaleLockSnapshot(lockPath, io) {
  const before = io.lstatSync(lockPath);
  if (!before.isFile() || before.isSymbolicLink()) return { safe: false };

  const noFollow = io.constants?.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = io.openSync(lockPath, io.constants.O_RDONLY | noFollow);
    const opened = io.fstatSync(fd);
    if (!opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size) {
      return { safe: false };
    }
    const text = io.readFileSync(fd, "utf8");
    const after = io.fstatSync(fd);
    if (after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs) {
      return { safe: false };
    }
    let record = {};
    try {
      record = JSON.parse(text);
    } catch {}
    return {
      safe: true,
      dev: after.dev,
      ino: after.ino,
      mtimeMs: after.mtimeMs,
      size: after.size,
      text,
      pid: Number(record?.pid),
      owner: typeof record?.owner === "string" ? record.owner : "",
    };
  } finally {
    if (fd !== undefined) io.closeSync(fd);
  }
}

function sameLock(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size
    && left.owner === right.owner
    && left.text === right.text;
}

function lockPathExists(lockPath, io) {
  try {
    io.lstatSync(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function writeLockRecord(lockPath, record, io) {
  const fd = io.openSync(lockPath, "wx", 0o600);
  try {
    io.writeFileSync(fd, JSON.stringify(record));
  } catch (error) {
    io.closeSync(fd);
    try { io.unlinkSync(lockPath); } catch {}
    throw error;
  }
  return fd;
}

function removeOwnedLock(lockPath, owner, io) {
  try {
    const snapshot = readStaleLockSnapshot(lockPath, io);
    if (snapshot.safe && snapshot.owner === owner) io.unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function reclaimGuardPath(lockPath) {
  return `${lockPath}.reclaim`;
}

function acquireReclaimGuard(lockPath, io) {
  const guardPath = reclaimGuardPath(lockPath);
  const owner = randomUUID();
  let fd;
  try {
    fd = writeLockRecord(guardPath, {
      pid: process.pid,
      owner,
      created_at: new Date().toISOString(),
    }, io);
    io.closeSync(fd);
    return { guardPath, owner };
  } catch (error) {
    if (fd !== undefined) try { io.closeSync(fd); } catch {}
    if (error?.code === "EEXIST") return null;
    throw error;
  }
}

function maybeRemoveAbandonedGuard(guardPath, staleMs, nowMs, io, processAlive) {
  try {
    const snapshot = readStaleLockSnapshot(guardPath, io);
    if (!snapshot.safe || nowMs - snapshot.mtimeMs <= staleMs || processAlive(snapshot.pid)) return false;
    const quarantinePath = `${guardPath}.stale-${randomUUID()}`;
    io.renameSync(guardPath, quarantinePath);
    const moved = readStaleLockSnapshot(quarantinePath, io);
    if (!moved.safe || !sameLock(snapshot, moved)) {
      restoreQuarantinedLock(guardPath, quarantinePath, io);
      return false;
    }
    io.unlinkSync(quarantinePath);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function restoreQuarantinedLock(lockPath, quarantinePath, io) {
  try {
    io.linkSync(quarantinePath, lockPath);
  } catch {
    return;
  }
  try {
    io.unlinkSync(quarantinePath);
  } catch {}
}

function maybeRemoveStaleLock(lockPath, staleMs, nowMs, io, processAlive) {
  if (!Number.isFinite(staleMs) || staleMs <= 0) return false;
  try {
    const first = readStaleLockSnapshot(lockPath, io);
    if (!first.safe || nowMs - first.mtimeMs <= staleMs || processAlive(first.pid)) return false;
    const guard = acquireReclaimGuard(lockPath, io);
    if (!guard) return false;
    try {
      const current = readStaleLockSnapshot(lockPath, io);
      if (!sameLock(first, current)
        || nowMs - current.mtimeMs <= staleMs
        || processAlive(current.pid)) {
        return false;
      }
      const quarantinePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        io.renameSync(lockPath, quarantinePath);
      } catch (e) {
        return e?.code === "ENOENT";
      }
      const moved = readStaleLockSnapshot(quarantinePath, io);
      if (!moved.safe || !sameLock(current, moved)) {
        restoreQuarantinedLock(lockPath, quarantinePath, io);
        return false;
      }
      io.unlinkSync(quarantinePath);
      return true;
    } finally {
      removeOwnedLock(guard.guardPath, guard.owner, io);
    }
  } catch (e) {
    if (e?.code === "ENOENT") return true;
    return false;
  }
}

export async function withFileLock(lockPath, fn, {
  timeoutMs = 5000,
  staleMs = 15 * 60 * 1000,
  pollMs = 50,
  now = Date.now,
  fsImpl = fs,
  processAlive = processIsAlive,
} = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const started = now();
  const owner = randomUUID();
  let fd = null;
  const guardPath = reclaimGuardPath(lockPath);

  while (fd === null) {
    const beforeAcquire = now();
    if (lockPathExists(guardPath, fsImpl)) {
      maybeRemoveAbandonedGuard(guardPath, staleMs, beforeAcquire, fsImpl, processAlive);
      if (lockPathExists(guardPath, fsImpl)) {
        if (beforeAcquire - started >= timeoutMs) throw new Error(`Timed out waiting for lock: ${lockPath}`);
        await sleep(Math.min(pollMs, Math.max(1, timeoutMs - (beforeAcquire - started))));
        continue;
      }
    }
    try {
      fd = writeLockRecord(lockPath, {
        pid: process.pid,
        owner,
        created_at: new Date().toISOString(),
      }, fs);
      if (lockPathExists(guardPath, fsImpl)) {
        fs.closeSync(fd);
        fd = null;
        removeOwnedLock(lockPath, owner, fs);
        continue;
      }
      break;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      const nowMs = now();
      if (maybeRemoveStaleLock(lockPath, staleMs, nowMs, fsImpl, processAlive)) continue;
      if (nowMs - started >= timeoutMs) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      await sleep(Math.min(pollMs, Math.max(1, timeoutMs - (nowMs - started))));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      if (fd !== null) fs.closeSync(fd);
    } finally {
      let currentOwner = "";
      try {
        currentOwner = readLockSnapshot(lockPath).owner;
      } catch (e) {
        if (e?.code !== "ENOENT") throw e;
      }
      if (currentOwner === owner) {
        try {
          fs.unlinkSync(lockPath);
        } catch (e) {
          if (e?.code !== "ENOENT") throw e;
        }
      }
    }
  }
}
