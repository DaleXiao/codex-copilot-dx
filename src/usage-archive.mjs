import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";

export const USAGE_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
export const USAGE_ARCHIVE_DAYS = 365;
const archivePattern = /^\d{13}-[a-f0-9]{32}\.jsonl\.gz$/;
const directoryFor = file => path.resolve(file) + ".archive";
const identity = stat => createHash("sha256").update([stat.dev, stat.ino, stat.size, stat.ctimeNs].join(":")).digest("hex").slice(0, 32);

async function segments(file) {
  const directory = directoryFor(file);
  try {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && archivePattern.test(entry.name)).map(entry => entry.name).sort();
  } catch (error) { if (error.code === "ENOENT") return [];throw error; }
}

export async function usageArchiveFiles(file) {
  return (await segments(file)).map(name => path.join(directoryFor(file), name));
}

export async function archivedUsageBackup(file, archive, stat) {
  const key = identity(stat ?? await fs.promises.stat(file + ".1", { bigint: true }));
  return archive.some(name => name.endsWith("-" + key + ".jsonl.gz"));
}

async function verifyCompressedUsage(file, size, expected) {
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(fs.createReadStream(file), createGunzip(), new Writable({ write(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > size) return callback(new Error("Usage archive exceeds its source size"));
    hash.update(chunk);
    callback();
  } }));
  if (bytes !== size || hash.digest("hex") !== expected) throw new Error("Usage archive did not verify");
}

export async function sealUsageBackup(file) {
  const backup = file + ".1";
  let stat;
  try { stat = await fs.promises.stat(backup, { bigint: true }); }
  catch (error) { if (error.code === "ENOENT") return;throw error; }
  if (!stat.isFile()) throw new Error("Usage backup is not a regular file");
  const directory = directoryFor(file);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const archive = await usageArchiveFiles(file);
  const matching = archive.find(name => name.endsWith("-" + identity(stat) + ".jsonl.gz"));
  const sealed = matching || path.join(directory, `${Date.now()}-${identity(stat)}.jsonl.gz`);
  const temporary = path.join(directory, `.seal-${randomUUID()}.tmp`);
  const hash = createHash("sha256");
  try {
    if (matching) {
      for await (const chunk of fs.createReadStream(backup)) hash.update(chunk);
      await verifyCompressedUsage(matching, Number(stat.size), hash.digest("hex"));
      return;
    }
    await pipeline(fs.createReadStream(backup), new Transform({ transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    } }), createGzip({ level: 3 }), fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    await verifyCompressedUsage(temporary, Number(stat.size), hash.digest("hex"));
    const handle = await fs.promises.open(temporary, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.promises.rename(temporary, sealed);
    if (process.platform !== "win32") {
      const dir = await fs.promises.open(directory, "r");
      try { await dir.sync(); }
      catch (error) { if (!["EINVAL", "ENOTSUP", "EBADF"].includes(error.code)) throw error; }
      finally { await dir.close(); }
    }
    await pruneUsageArchive([...archive, sealed]);
  } finally { await fs.promises.rm(temporary, { force: true }); }
}

async function pruneUsageArchive(files) {
  const sizes = await Promise.all(files.map(name => fs.promises.stat(name).then(stat => stat.size)));
  let bytes = sizes.reduce((sum, size) => sum + size, 0);
  const before = Date.now() - USAGE_ARCHIVE_DAYS * 86400000;
  // Preserve the newest verified segment even if one custom log exceeds the archive budget.
  for (let i = 0; i < files.length - 1; i++) {
    if (bytes <= USAGE_ARCHIVE_MAX_BYTES && Number(path.basename(files[i]).slice(0, 13)) >= before) break;
    await fs.promises.unlink(files[i]);
    bytes -= sizes[i];
  }
}
