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

function sameLock(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size
    && left.owner === right.owner;
}

function maybeRemoveStaleLock(lockPath, staleMs, nowMs) {
  if (!Number.isFinite(staleMs) || staleMs <= 0) return false;
  try {
    const first = readLockSnapshot(lockPath);
    if (nowMs - first.mtimeMs <= staleMs || processIsAlive(first.pid)) return false;
    const current = readLockSnapshot(lockPath);
    if (!sameLock(first, current)) return false;
    fs.unlinkSync(lockPath);
    return true;
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
} = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const started = now();
  const owner = randomUUID();
  let fd = null;

  while (fd === null) {
    try {
      const candidateFd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(candidateFd, JSON.stringify({ pid: process.pid, owner, created_at: new Date().toISOString() }));
        fd = candidateFd;
      } catch (e) {
        fs.closeSync(candidateFd);
        try { fs.unlinkSync(lockPath); } catch {}
        throw e;
      }
      break;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      const nowMs = now();
      if (maybeRemoveStaleLock(lockPath, staleMs, nowMs)) continue;
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
