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
