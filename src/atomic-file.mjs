import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function existingMode(filePath, fallback) {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch (e) {
    if (e?.code === "ENOENT") return fallback;
    throw e;
  }
}

function syncDirectory(directory) {
  if (process.platform === "win32") return;
  let fd;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch (e) {
    if (!["EINVAL", "ENOTSUP", "EBADF"].includes(e?.code)) throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function atomicWriteFileSync(filePath, data, { mode = 0o600 } = {}) {
  const directory = path.dirname(filePath);
  const finalMode = existingMode(filePath, mode);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  let fd;
  try {
    fd = fs.openSync(tempPath, "wx", finalMode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, finalMode);
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(tempPath);
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
  }
}

export function atomicWriteFileIfChangedSync(filePath, data, options = {}) {
  try {
    const current = fs.readFileSync(filePath);
    const next = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (current.equals(next)) return false;
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  atomicWriteFileSync(filePath, data, options);
  return true;
}
