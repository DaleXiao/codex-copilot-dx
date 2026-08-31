import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { sha256Hex } from "./pm-studio-asar.mjs";

const BUNDLE_CONTENT_SCHEME = "ccdx-bundle-content-v2";

function setupError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function hashRegularFile(filePath, expected, readBuffer) {
  const hash = createHash("sha256");
  const file = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const buffer = readBuffer || Buffer.allocUnsafe(1024 * 1024);
  try {
    const before = fs.fstatSync(file, { bigint: true });
    if (before.dev !== BigInt(expected.dev)
      || before.ino !== BigInt(expected.ino)
      || before.size !== BigInt(expected.size)) {
      throw setupError("PM_STUDIO_BUNDLE_CHANGED", `PM Studio bundle changed while reading ${filePath}`);
    }
    for (;;) {
      const length = fs.readSync(file, buffer, 0, buffer.length, null);
      if (length === 0) break;
      hash.update(buffer.subarray(0, length));
    }
    const after = fs.fstatSync(file, { bigint: true });
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs) {
      throw setupError("PM_STUDIO_BUNDLE_CHANGED", `PM Studio bundle changed while hashing ${filePath}`);
    }
  } finally {
    fs.closeSync(file);
  }
  return hash.digest("hex");
}

function parseXattrHex(output, root, ignoredXattrs) {
  const records = [];
  const ignored = new Set(ignoredXattrs);
  const seen = new Set();
  let current = null;
  const flush = () => {
    if (!current) return;
    if (!ignored.has(current.name)) {
      const key = `${current.path}\0${current.name}`;
      if (seen.has(key)) throw setupError("PM_STUDIO_XATTR_INVALID", `Duplicate extended attribute ${current.name}`);
      seen.add(key);
      const value = Buffer.from(current.hex.join(""), "hex");
      records.push(["xattr", current.path, current.name, value.length, sha256Hex(value)]);
    }
    current = null;
  };

  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.lastIndexOf(": ");
    if ((line === `${root}:` || line.startsWith(`${root}: `) || line.startsWith(`${root}${path.sep}`))
      && separator >= root.length && line.endsWith(":")) {
      flush();
      const target = line.slice(0, separator);
      const relative = target === root ? "." : path.relative(root, target).split(path.sep).join("/");
      if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
        throw setupError("PM_STUDIO_XATTR_INVALID", `Extended attribute path escapes PM Studio: ${target}`);
      }
      current = { path: relative, name: line.slice(separator + 2, -1), hex: [] };
      continue;
    }
    if (!current) throw setupError("PM_STUDIO_XATTR_INVALID", "Could not parse PM Studio extended attributes");
    const data = line.includes("  |") ? line.slice(0, line.indexOf("  |")) : line;
    const tokens = data.trim().split(/\s+/);
    if (!/^[0-9a-f]{8}$/i.test(tokens[0]) || tokens.slice(1).some((token) => !/^[0-9a-f]{2}$/i.test(token))) {
      throw setupError("PM_STUDIO_XATTR_INVALID", "Could not parse PM Studio extended attribute bytes");
    }
    current.hex.push(...tokens.slice(1));
  }
  flush();
  return records.sort((left, right) => Buffer.compare(
    Buffer.from(`${left[1]}\0${left[2]}`),
    Buffer.from(`${right[1]}\0${right[2]}`),
  ));
}

export function inspectBundleContent(appPath, {
  xattrOutput = "",
  ignoredXattrs = [],
  readBuffer,
} = {}) {
  const root = path.resolve(appPath);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw setupError("PM_STUDIO_APP_INVALID", `PM Studio path is not a regular app bundle: ${appPath}`);
  }
  const records = [];
  const normalizedPaths = new Map();
  let regularFileCount = 0;
  let regularBytes = 0;
  let symlinkCount = 0;

  const rememberPath = (relative) => {
    const normalized = relative.normalize("NFC");
    const existing = normalizedPaths.get(normalized);
    if (existing && existing !== relative) {
      throw setupError("PM_STUDIO_BUNDLE_PATH_COLLISION", `PM Studio contains colliding paths: ${existing} and ${relative}`);
    }
    normalizedPaths.set(normalized, relative);
  };
  rememberPath(".");
  records.push(["directory", ".", rootStat.mode & 0o7777]);
  const visit = (directory) => {
    const names = fs.readdirSync(directory).sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)));
    for (const name of names) {
      const fullPath = path.join(directory, name);
      const stat = fs.lstatSync(fullPath);
      const relative = path.relative(root, fullPath).split(path.sep).join("/");
      const mode = stat.mode & 0o7777;
      rememberPath(relative);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        records.push(["directory", relative, mode]);
        visit(fullPath);
      } else if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(fullPath);
        const resolved = path.resolve(path.dirname(fullPath), target);
        if (path.isAbsolute(target)
          || (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
          || !fs.existsSync(resolved)) {
          throw setupError("PM_STUDIO_BUNDLE_SYMLINK_INVALID", `PM Studio contains an unsafe symlink: ${relative}`);
        }
        symlinkCount += 1;
        records.push(["symlink", relative, mode, target]);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) {
          throw setupError("PM_STUDIO_BUNDLE_HARDLINK_INVALID", `PM Studio contains a hard-linked file: ${relative}`);
        }
        regularFileCount += 1;
        regularBytes += stat.size;
        records.push(["file", relative, mode, stat.size, hashRegularFile(fullPath, stat, readBuffer)]);
      } else {
        throw setupError("PM_STUDIO_BUNDLE_ENTRY_INVALID", `PM Studio contains an unsupported entry: ${relative}`);
      }
    }
  };
  visit(root);

  const xattrRecords = parseXattrHex(xattrOutput, root, ignoredXattrs);
  const hash = createHash("sha256");
  for (const record of [...records, ...xattrRecords]) hash.update(`${JSON.stringify(record)}\n`);
  return {
    scheme: BUNDLE_CONTENT_SCHEME,
    sha256: hash.digest("hex"),
    entryCount: records.length,
    regularFileCount,
    regularBytes,
    symlinkCount,
    xattrCount: xattrRecords.length,
  };
}
