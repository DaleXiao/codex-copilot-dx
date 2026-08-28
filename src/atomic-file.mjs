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

export function atomicWriteFileSync(filePath, data, {
  mode = 0o600,
  preserveMode = true,
} = {}) {
  const directory = path.dirname(filePath);
  const finalMode = preserveMode ? existingMode(filePath, mode) : mode;
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

function fileSnapshot(filePath) {
  try {
    return {
      exists: true,
      data: fs.readFileSync(filePath),
      mode: fs.statSync(filePath).mode & 0o777,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, data: null, mode: 0o600 };
    throw error;
  }
}

function removeFile(filePath, unlinkFile) {
  try {
    unlinkFile(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function writeExactMode(filePath, data, mode, writeFile) {
  writeFile(filePath, data, { mode, preserveMode: false });
  fs.chmodSync(filePath, mode);
}

function restoreFile(filePath, snapshot, { writeFile, unlinkFile }) {
  if (snapshot.exists) {
    writeExactMode(filePath, snapshot.data, snapshot.mode, writeFile);
    return;
  }
  removeFile(filePath, unlinkFile);
}

// Commit a primary file first and its metadata/activation marker last. A null
// secondary value removes stale metadata as the final transaction step.
export function atomicWriteFilePairSync(
  primaryPath,
  primaryData,
  secondaryPath,
  secondaryData,
  {
    mode = 0o600,
    writeFile = atomicWriteFileSync,
    unlinkFile = fs.unlinkSync,
  } = {},
) {
  const primarySnapshot = fileSnapshot(primaryPath);
  const secondarySnapshot = fileSnapshot(secondaryPath);

  try {
    writeExactMode(primaryPath, primaryData, mode, writeFile);
    if (secondaryData === null) removeFile(secondaryPath, unlinkFile);
    else writeExactMode(secondaryPath, secondaryData, mode, writeFile);
  } catch (error) {
    let rollbackError;
    try {
      restoreFile(primaryPath, primarySnapshot, { writeFile, unlinkFile });
    } catch (cause) {
      rollbackError = cause;
    }
    try {
      restoreFile(secondaryPath, secondarySnapshot, { writeFile, unlinkFile });
    } catch (cause) {
      rollbackError ||= cause;
    }
    if (rollbackError) error.rollbackError = rollbackError;
    throw error;
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
