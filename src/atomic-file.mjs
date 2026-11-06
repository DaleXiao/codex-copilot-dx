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

export async function atomicWriteFile(filePath, data, { mode = 0o600, preserveMode = true } = {}) {
  const io = fs.promises, directory = path.dirname(filePath);
  let finalMode = mode;
  if (preserveMode) { try { finalMode = (await io.stat(filePath)).mode & 0o777; } catch (error) { if (error.code !== "ENOENT") throw error; } }
  await io.mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let file;
  try {
    file = await io.open(tempPath, "wx", finalMode);await file.writeFile(data);await file.sync();await file.close();file = null;
    await io.rename(tempPath, filePath);await io.chmod(filePath, finalMode);
    if (process.platform !== "win32") {
      let dir;
      try { dir = await io.open(directory, "r");await dir.sync(); }
      catch (error) { if (!["EINVAL", "ENOTSUP", "EBADF"].includes(error.code)) throw error; }
      finally { await dir?.close(); }
    }
  } finally {
    await file?.close();
    try { await io.unlink(tempPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export async function atomicWriteFilePair(primaryPath, primaryData, secondaryPath, secondaryData, { mode = 0o600, writeFile = atomicWriteFile, unlinkFile = file => fs.promises.unlink(file) } = {}) {
  const snapshot = async file => {
    try { return { data: await fs.promises.readFile(file), mode: (await fs.promises.stat(file)).mode & 0o777 }; }
    catch (error) { if (error.code === "ENOENT") return null;throw error; }
  };
  const remove = async file => { try { await unlinkFile(file); } catch (error) { if (error.code !== "ENOENT") throw error; } };
  const write = (file, data, mode) => writeFile(file, data, { mode, preserveMode: false });
  const before = [await snapshot(primaryPath), await snapshot(secondaryPath)];
  try {
    await write(primaryPath, primaryData, mode);
    if (secondaryData === null) await remove(secondaryPath);else await write(secondaryPath, secondaryData, mode);
  } catch (error) {
    for (const [file, saved] of [[primaryPath, before[0]], [secondaryPath, before[1]]]) {
      try { if (saved) await write(file, saved.data, saved.mode);else await remove(file); }
      catch (cause) { error.rollbackError ||= cause; }
    }
    throw error;
  }
}
