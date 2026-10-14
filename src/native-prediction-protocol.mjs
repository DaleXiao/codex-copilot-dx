import fs from "node:fs";

const MAX_HEADER_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_BYTES = 36 * 1024 * 1024;

// Inspect only packed, named protocol/settings candidates in the installed
// archive. A small forwarding chunk must not hide its real implementation.
export function inspectPredictionArchive(archive) {
  const fd = fs.openSync(archive, "r");
  try {
    const before = fs.fstatSync(fd);
    const read = (size, offset) => {
      if (!before.isFile() || !Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(offset)
        || offset < 0 || offset + size > before.size) throw new Error("Invalid prediction App archive bounds");
      const bytes = Buffer.alloc(size);
      if (fs.readSync(fd, bytes, 0, size, offset) !== size) throw new Error("Prediction App archive changed during inspection");
      return bytes;
    };
    const prefix = read(16, 0), headerSize = prefix.readUInt32LE(12);
    if (headerSize > MAX_HEADER_BYTES) throw new Error("Prediction App archive header exceeds its inspection limit");
    const tree = JSON.parse(read(headerSize, 16)).files;
    const base = 8 + prefix.readUInt32LE(4);
    let sourceBytes = 0;
    const contains = (files, pattern, markers, maxEntryBytes) => {
      const entries = Object.entries(files || {}).filter(([name]) => pattern.test(name));
      if (entries.length > 16) throw new Error("Prediction App protocol candidates exceed their inspection limit");
      for (const [, entry] of entries) {
        if (!entry || typeof entry !== "object") throw new Error("Invalid prediction App archive entry");
        if (entry.unpacked) continue;
        if (!Number.isSafeInteger(entry.size) || entry.size > maxEntryBytes
          || sourceBytes + entry.size > MAX_SOURCE_BYTES) throw new Error("Prediction App source exceeds its inspection limit");
        sourceBytes += entry.size;
        const bytes = read(entry.size, base + Number(entry.offset));
        if (markers.every(marker => bytes.includes(Buffer.from(marker)))) return true;
      }
      return false;
    };
    const compatible = contains(tree?.[".vite"]?.files?.build?.files, /^main-[\w-]+\.js$/,
      ["/wham/predictions/config", "experimentalPredictionMode"], 32 * 1024 * 1024)
      && contains(tree?.webview?.files?.assets?.files, /^general-settings-[\w-]+\.js$/, ["4290031608"], 4 * 1024 * 1024);
    const after = fs.fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("Prediction App archive changed during inspection");
    return { compatible, size: after.size, mtimeMs: after.mtimeMs };
  } finally { fs.closeSync(fd); }
}
