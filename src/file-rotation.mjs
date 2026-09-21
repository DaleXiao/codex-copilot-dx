import fs from "node:fs";

export function parseByteLimit(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function rotatedFilePath(filePath) {
  return `${filePath}.1`;
}

export function rotateFileIfNeededSync(filePath, incomingBytes, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return false;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    if (e?.code === "ENOENT") return false;
    throw e;
  }
  if (!stat.isFile() || stat.size === 0 || stat.size + incomingBytes <= maxBytes) return false;

  const backupPath = rotatedFilePath(filePath);
  fs.rmSync(backupPath, { force: true });
  fs.renameSync(filePath, backupPath);
  return true;
}

// Callers serialize writers (usage also holds its cross-process file lock).
// Group adjacent lines without changing the existing per-record rotation rule.
export async function appendRotatingLines(filePath, lines, maxBytes) {
  let size = 0;
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) throw new Error("Log destination is not a regular file");
    size = stat.size;
  }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  let group = [];
  let bytes = 0;
  const flush = async () => {
    if (!group.length) return;
    await fs.promises.appendFile(filePath, group.join(""), { encoding: "utf8", mode: 0o600 });
    group = [];
    bytes = 0;
  };
  for (const line of lines) {
    const length = Buffer.byteLength(line);
    if (maxBytes > 0 && size > 0 && size + length > maxBytes) {
      await flush();
      await fs.promises.rm(rotatedFilePath(filePath), { force: true });
      await fs.promises.rename(filePath, rotatedFilePath(filePath));
      size = 0;
    }
    group.push(line);
    size += length;
    bytes += length;
    if (bytes >= 256 * 1024) await flush();
  }
  await flush();
}
