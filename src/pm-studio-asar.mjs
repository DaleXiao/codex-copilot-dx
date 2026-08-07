import { createHash } from "node:crypto";

export const PM_STUDIO_ORIGIN = "https://api.githubcopilot.com";
export const CCDX_PM_STUDIO_ORIGIN = "http://127.0.0.1:2026/pm-ccdx";
export const ELECTRON_ASAR_INTEGRITY_SENTINEL = "AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A";

export const PM_STUDIO_2_9_7_RECIPE = Object.freeze({
  id: "pm-studio-2.9.7-build-2.9.7",
  version: "2.9.7",
  build: "2.9.7",
  bundleIdentifier: "com.pm-studio.app",
  sourceTeamIdentifier: "HL75GKK4W4",
  executable: "PM Studio",
  sourceExecutableSha256: "6364edd0561790610ee82399865f42f160523551d8d72220e26c4b18da324017",
  electronFrameworkPath: "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
  sourceElectronFrameworkSha256: "e684d310334840f7a64f2d5171052eb514822af155779d3185e4f068daee4387",
  embeddedAsarIntegrity: "absent",
  asarPath: "Contents/Resources/app.asar",
  infoPlistPath: "Contents/Info.plist",
  integrityKey: "ElectronAsarIntegrity.Resources/app.asar",
  dataOffset: 3_832_764,
  sourceAsarSha256: "36fb8bf2fc9326ddf49baab5cc0b54b38751a7db041bda3c42a3b01107b54118",
  sourceHeaderSha256: "87746d92e00db2d40c03830ea06de22ec7cba112d07729801ccd02e226ffd961",
  patchedAsarSha256: "3dd0f53cdaa35a644d2cf56e4fc2dd20f5c90dc2989b6d81a467ef00ebb620a7",
  patchedHeaderSha256: "86ed1113a563b82ecec05de89aab87a5fd1666f35bee76e2d76e2ed5f6dcb3fa",
  sourceSentinel: PM_STUDIO_ORIGIN,
  patchedSentinel: CCDX_PM_STUDIO_ORIGIN,
  targets: Object.freeze([
    Object.freeze({
      path: "dist/main/main.js",
      offset: 101_621_627,
      size: 9_909_974,
      sentinelOffset: 1_120_480,
      absoluteSentinelOffset: 106_574_871,
      sentinelCount: 1,
      blockSize: 4_194_304,
      sourceSha256: "58383be112886becdb8d8e7cce1b3efce07be6716190aa4940627f456eb8edb2",
      patchedSha256: "24f1c47831c30f59e8464a66237c6bc9ed771d79f3a6889019dfdf53bc20fe42",
      sourceBlocks: Object.freeze([
        "3ce05a21e8992ccf12966cf9b78fcd28b2f66e6786489b5bb0a06f1d4b2a0c1e",
        "0a4832413d8d8cdda67c8bb318c0e5c25df20c75802d637097ffd045a31cd443",
        "bcc10582d8a74717f8f81b98182d3551f1eaf23eb9cadd908d160ce5e4ef8cba",
      ]),
      patchedBlocks: Object.freeze([
        "afc18cc7d56cce6dd6f3bade8661268a534f2de93de5ba638f6609d2638c7436",
        "0a4832413d8d8cdda67c8bb318c0e5c25df20c75802d637097ffd045a31cd443",
        "bcc10582d8a74717f8f81b98182d3551f1eaf23eb9cadd908d160ce5e4ef8cba",
      ]),
    }),
    Object.freeze({
      path: "dist/renderer/js/main.09f18d95.js",
      offset: 137_002_230,
      size: 2_469_533,
      sentinelOffset: 489_935,
      absoluteSentinelOffset: 141_324_929,
      sentinelCount: 1,
      blockSize: 4_194_304,
      sourceSha256: "eb63abf35be3db101da179789e8ffdcc5b67131258ac8d7976109713ff0cc994",
      patchedSha256: "89bbea9516a914da3fa4f32befd33d0dbb0e63b09545e4d85392bccb52adc145",
      sourceBlocks: Object.freeze([
        "eb63abf35be3db101da179789e8ffdcc5b67131258ac8d7976109713ff0cc994",
      ]),
      patchedBlocks: Object.freeze([
        "89bbea9516a914da3fa4f32befd33d0dbb0e63b09545e4d85392bccb52adc145",
      ]),
    }),
  ]),
});

export const PM_STUDIO_RECIPES = Object.freeze([PM_STUDIO_2_9_7_RECIPE]);

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function checkedBuffer(value) {
  if (!Buffer.isBuffer(value)) throw new TypeError("ASAR input must be a Buffer");
  return value;
}

function checkedUInt32(buffer, offset, name) {
  if (offset < 0 || offset + 4 > buffer.length) throw new Error(`Invalid ASAR: missing ${name}`);
  return buffer.readUInt32LE(offset);
}

function integer(value, name) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Invalid ASAR ${name}: ${value}`);
  return result;
}

function entryOffset(value, name) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Invalid ASAR ${name}: ${value}`);
  }
  return integer(value, name);
}

function entrySize(value, name) {
  if (typeof value !== "number") throw new Error(`Invalid ASAR ${name}: ${value}`);
  return integer(value, name);
}

function aligned4(value) {
  return (value + 3) & ~3;
}

export function parseAsarBuffer(value) {
  const buffer = checkedBuffer(value);
  if (buffer.length < 16) throw new Error("Invalid ASAR: header is truncated");

  const sizePicklePayload = checkedUInt32(buffer, 0, "size pickle");
  const headerPickleSize = checkedUInt32(buffer, 4, "header pickle size");
  const headerPicklePayload = checkedUInt32(buffer, 8, "header pickle payload");
  const headerLength = checkedUInt32(buffer, 12, "header string size");
  const headerStart = 16;
  const headerEnd = headerStart + headerLength;
  const dataOffset = 8 + headerPickleSize;

  if (sizePicklePayload !== 4
    || headerPickleSize < 8
    || headerPickleSize % 4 !== 0
    || headerPicklePayload !== headerPickleSize - 4
    || headerPicklePayload !== 4 + aligned4(headerLength)) {
    throw new Error("Invalid ASAR: malformed pickle sizes");
  }
  if (headerEnd > dataOffset || dataOffset > buffer.length) {
    throw new Error("Invalid ASAR: header extends outside the archive");
  }
  if (buffer.subarray(headerEnd, dataOffset).some((byte) => byte !== 0)) {
    throw new Error("Invalid ASAR: header padding is not zeroed");
  }

  const headerBytes = buffer.subarray(headerStart, headerEnd);
  let header;
  try {
    header = JSON.parse(headerBytes.toString("utf8"));
  } catch {
    throw new Error("Invalid ASAR: header JSON could not be parsed");
  }
  if (!header || typeof header !== "object" || !header.files || typeof header.files !== "object") {
    throw new Error("Invalid ASAR: header has no files tree");
  }

  return {
    buffer,
    header,
    headerBytes,
    headerLength,
    headerStart,
    headerEnd,
    headerPickleSize,
    dataOffset,
  };
}

export function findAsarEntry(header, filePath) {
  const parts = String(filePath || "").split("/").filter(Boolean);
  if (parts.length === 0) return null;
  let node = { files: header?.files };
  for (const part of parts) {
    node = node?.files?.[part];
    if (!node) return null;
  }
  return node;
}

function occurrencePositions(haystack, needle) {
  const positions = [];
  if (needle.length === 0) return positions;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const position = haystack.indexOf(needle, offset);
    if (position < 0) break;
    positions.push(position);
    offset = position + needle.length;
  }
  return positions;
}

export function blockSha256(buffer, blockSize) {
  const size = integer(blockSize, "block size");
  if (size === 0) throw new Error("Invalid ASAR block size: 0");
  const hashes = [];
  if (buffer.length === 0) return [sha256Hex(buffer)];
  for (let offset = 0; offset < buffer.length; offset += size) {
    hashes.push(sha256Hex(buffer.subarray(offset, Math.min(offset + size, buffer.length))));
  }
  return hashes;
}

export function inspectElectronAsarIntegritySlots(value) {
  const buffer = checkedBuffer(value);
  const sentinel = Buffer.from(ELECTRON_ASAR_INTEGRITY_SENTINEL);
  const slots = [];
  let searchOffset = 0;
  let truncated = false;
  while (searchOffset <= buffer.length - sentinel.length) {
    const offset = buffer.indexOf(sentinel, searchOffset);
    if (offset < 0) break;
    if (offset + 66 > buffer.length) {
      truncated = true;
      break;
    }
    const used = buffer[offset + 32];
    const version = buffer[offset + 33];
    slots.push({
      offset,
      used,
      version,
      digest: buffer.subarray(offset + 34, offset + 66).toString("hex"),
    });
    searchOffset = offset + sentinel.length;
  }
  const malformed = truncated
    || slots.length > 1
    || slots.some((slot) => ![0, 1].includes(slot.used) || (slot.used === 1 && slot.version !== 1));
  const active = slots.some((slot) => slot.used === 1);
  return {
    state: malformed ? "drift" : active ? "active" : slots.length === 1 ? "inactive" : "absent",
    active,
    supported: !malformed && !active,
    slots,
  };
}

function sameArray(actual, expected) {
  return Array.isArray(actual)
    && Array.isArray(expected)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function addMismatch(issues, label, actual, expected) {
  if (actual !== expected) issues.push(`${label}: expected ${expected}, got ${actual}`);
}

function inspectTarget(parsed, target, recipe) {
  const entry = findAsarEntry(parsed.header, target.path);
  if (!entry) return { path: target.path, missing: true };

  let offset;
  let size;
  try {
    offset = entryOffset(entry.offset, `${target.path} offset`);
    size = entrySize(entry.size, `${target.path} size`);
  } catch (error) {
    return { path: target.path, malformed: error.message };
  }
  const absoluteOffset = parsed.dataOffset + offset;
  if (entry.unpacked || absoluteOffset + size > parsed.buffer.length) {
    return { path: target.path, offset, size, absoluteOffset, malformed: "entry data is outside the packed archive" };
  }

  const bytes = parsed.buffer.subarray(absoluteOffset, absoluteOffset + size);
  const sourceSentinel = Buffer.from(recipe.sourceSentinel);
  const patchedSentinel = Buffer.from(recipe.patchedSentinel);
  return {
    path: target.path,
    offset,
    size,
    absoluteOffset,
    sha256: sha256Hex(bytes),
    blockSize: entry.integrity?.blockSize,
    blocks: blockSha256(bytes, target.blockSize),
    integrity: entry.integrity || null,
    sourceSentinelPositions: occurrencePositions(bytes, sourceSentinel),
    patchedSentinelPositions: occurrencePositions(bytes, patchedSentinel),
  };
}

function targetStateIssues(detail, target, recipe, state) {
  const issues = [];
  if (detail.missing) return [`${target.path}: entry is missing`];
  if (detail.malformed) return [`${target.path}: ${detail.malformed}`];

  addMismatch(issues, `${target.path} offset`, detail.offset, target.offset);
  addMismatch(issues, `${target.path} size`, detail.size, target.size);
  addMismatch(issues, `${target.path} absolute sentinel offset`,
    detail.absoluteOffset + target.sentinelOffset, target.absoluteSentinelOffset);
  addMismatch(issues, `${target.path} integrity algorithm`,
    detail.integrity?.algorithm, "SHA256");
  addMismatch(issues, `${target.path} block size`, detail.integrity?.blockSize, target.blockSize);

  const patched = state === "patched";
  const expectedHash = patched ? target.patchedSha256 : target.sourceSha256;
  const expectedBlocks = patched ? target.patchedBlocks : target.sourceBlocks;
  const expectedSentinelPositions = [target.sentinelOffset];
  const presentPositions = patched ? detail.patchedSentinelPositions : detail.sourceSentinelPositions;
  const absentPositions = patched ? detail.sourceSentinelPositions : detail.patchedSentinelPositions;

  addMismatch(issues, `${target.path} SHA-256`, detail.sha256, expectedHash);
  addMismatch(issues, `${target.path} integrity hash`, detail.integrity?.hash, expectedHash);
  if (!sameArray(detail.blocks, expectedBlocks)) issues.push(`${target.path} computed block hashes do not match ${state} recipe`);
  if (!sameArray(detail.integrity?.blocks, expectedBlocks)) issues.push(`${target.path} header block hashes do not match ${state} recipe`);
  if (!sameArray(presentPositions, expectedSentinelPositions)) {
    issues.push(`${target.path} ${state} sentinel position/count does not match recipe`);
  }
  if (absentPositions.length !== 0) issues.push(`${target.path} contains the opposite-state sentinel`);
  if (presentPositions.length !== target.sentinelCount) {
    issues.push(`${target.path} ${state} sentinel count is ${presentPositions.length}, expected ${target.sentinelCount}`);
  }
  return issues;
}

export function inspectAsarBuffer(value, recipe = PM_STUDIO_2_9_7_RECIPE) {
  const parsed = parseAsarBuffer(value);
  const asarSha256 = sha256Hex(parsed.buffer);
  const headerSha256 = sha256Hex(parsed.headerBytes);
  const targets = recipe.targets.map((target) => inspectTarget(parsed, target, recipe));
  const commonIssues = [];
  addMismatch(commonIssues, "ASAR data offset", parsed.dataOffset, recipe.dataOffset);

  const issuesFor = (state) => {
    const patched = state === "patched";
    const issues = [...commonIssues];
    addMismatch(issues, "ASAR SHA-256", asarSha256,
      patched ? recipe.patchedAsarSha256 : recipe.sourceAsarSha256);
    addMismatch(issues, "ASAR header SHA-256", headerSha256,
      patched ? recipe.patchedHeaderSha256 : recipe.sourceHeaderSha256);
    for (let index = 0; index < recipe.targets.length; index += 1) {
      issues.push(...targetStateIssues(targets[index], recipe.targets[index], recipe, state));
    }
    return issues;
  };

  const cleanIssues = issuesFor("clean");
  const patchedIssues = issuesFor("patched");
  const state = cleanIssues.length === 0 ? "clean" : patchedIssues.length === 0 ? "patched" : "drift";
  return {
    recipeId: recipe.id,
    state,
    asarSha256,
    headerSha256,
    dataOffset: parsed.dataOffset,
    targets,
    cleanIssues,
    patchedIssues,
  };
}

export function patchAsarBuffer(value, recipe = PM_STUDIO_2_9_7_RECIPE) {
  if (Buffer.byteLength(recipe.sourceSentinel) !== Buffer.byteLength(recipe.patchedSentinel)) {
    throw new Error("PM Studio patch requires equal-length origin sentinels");
  }
  const before = inspectAsarBuffer(value, recipe);
  if (before.state === "patched") {
    return { changed: false, buffer: Buffer.from(value), before, after: before };
  }
  if (before.state !== "clean") {
    const error = new Error("PM Studio ASAR does not match the clean or patched recipe");
    error.code = "PM_STUDIO_ASAR_DRIFT";
    error.inspection = before;
    throw error;
  }

  const output = Buffer.from(value);
  const parsed = parseAsarBuffer(output);
  const sourceSentinel = Buffer.from(recipe.sourceSentinel);
  const patchedSentinel = Buffer.from(recipe.patchedSentinel);

  for (const target of recipe.targets) {
    const entry = findAsarEntry(parsed.header, target.path);
    const offset = entryOffset(entry.offset, `${target.path} offset`);
    const absoluteSentinelOffset = parsed.dataOffset + offset + target.sentinelOffset;
    const existing = output.subarray(absoluteSentinelOffset, absoluteSentinelOffset + sourceSentinel.length);
    if (!existing.equals(sourceSentinel)) throw new Error(`${target.path} source sentinel moved before patching`);
    patchedSentinel.copy(output, absoluteSentinelOffset);
    entry.integrity = {
      ...entry.integrity,
      algorithm: "SHA256",
      hash: target.patchedSha256,
      blockSize: target.blockSize,
      blocks: [...target.patchedBlocks],
    };
  }

  const nextHeaderBytes = Buffer.from(JSON.stringify(parsed.header));
  if (nextHeaderBytes.length !== parsed.headerLength) {
    throw new Error(`Patched ASAR header changed size (${parsed.headerLength} -> ${nextHeaderBytes.length})`);
  }
  nextHeaderBytes.copy(output, parsed.headerStart);

  const after = inspectAsarBuffer(output, recipe);
  if (after.state !== "patched") {
    const error = new Error("Patched PM Studio ASAR failed recipe verification");
    error.code = "PM_STUDIO_ASAR_PATCH_VERIFY_FAILED";
    error.inspection = after;
    throw error;
  }
  return { changed: true, buffer: output, before, after };
}
