import fs from "node:fs";
import path from "node:path";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maybeRemoveStaleLock(lockPath, staleMs, nowMs) {
  if (!Number.isFinite(staleMs) || staleMs <= 0) return false;
  try {
    const stat = fs.statSync(lockPath);
    if (nowMs - stat.mtimeMs <= staleMs) return false;
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
  let fd = null;

  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
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
      try {
        fs.unlinkSync(lockPath);
      } catch (e) {
        if (e?.code !== "ENOENT") throw e;
      }
    }
  }
}
