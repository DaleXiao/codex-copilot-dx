import fs from "node:fs";

export const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;
export const MAX_TOKEN_FILE_BYTES = 64 * 1024;
export const MAX_MODEL_CACHE_FILE_BYTES = 9 * 1024 * 1024;

// Read one regular-file snapshot. Symlinks retain existing configuration
// semantics; this is a byte boundary, not an ownership or path-policy change.
export function readBoundedFileSync(filePath, { maxBytes = MAX_SETTINGS_FILE_BYTES, encoding } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("Invalid local file byte limit");
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) {
      const error = new Error("Local configuration file exceeds its read limit or is not a regular file");
      error.code = "ccdx_local_file_limit";throw error;
    }
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0, count;
    while (size < buffer.length && (count = fs.readSync(fd, buffer, size, buffer.length - size, size)) > 0) size += count;
    if (size > stat.size) {
      const error = new Error("Local configuration file grew during reading; retry after the write finishes");
      error.code = "ccdx_local_file_changed";throw error;
    }
    const value = buffer.subarray(0, size);
    return encoding ? value.toString(encoding) : value;
  } finally { fs.closeSync(fd); }
}
