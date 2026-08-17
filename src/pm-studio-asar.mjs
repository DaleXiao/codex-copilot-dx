import { createHash } from "node:crypto";

export const PM_STUDIO_ORIGIN = "https://api.githubcopilot.com";
export const CCDX_PM_STUDIO_ORIGIN = "http://127.0.0.1:2026/pm-ccdx";
export const PM_STUDIO_SPLIT_ORIGIN_MARKER = "split-origin-v1";
export const ELECTRON_ASAR_INTEGRITY_SENTINEL = "AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A";

const PM_STUDIO_COPILOT_CONFIG_MODULE_LENGTH = 2_121;
const PM_STUDIO_COPILOT_CONFIG_MODULE_SOURCE_SHA256 = "3da6245d676015ab6cd26e4d6a0d2f54894a687c370aa419c5ad170533d086aa";

function splitOriginConfigModule() {
  const source = `47024(I,e,t){"use strict";t.d(e,{qn:()=>l});const l={CLIENT_ID:"Iv1.b507a08c87ecfe98",CLIENT_SECRET:void 0,API_ENDPOINT:"${PM_STUDIO_ORIGIN}",DEVICE_CODE_URL:"https://github.com/login/device/code",ACCESS_TOKEN_URL:"https://github.com/login/oauth/access_token",COPILOT_TOKEN_URL:"https://api.github.com/copilot_internal/v2/token",USER_AGENT:"GitHubCopilotChat/0.26.7",EDITOR_VERSION:"vscode/1.99.3",EDITOR_PLUGIN_VERSION:"copilot-chat/0.26.7",INTEGRATION_ID:"vscode-chat",STANDARD_HEADERS:{Accept:"application/json","Content-Type":"application/json","User-Agent":"GitHubCopilotChat/0.26.7","Editor-Version":"vscode/1.99.3","Editor-Plugin-Version":"copilot-chat/0.26.7","Copilot-Integration-Id":"vscode-chat","X-Request-Id":()=>\`req_\${Date.now()}_\${Math.random().toString(36).substr(2,9)}\`}};const c=fetch.bind(globalThis),n="${CCDX_PM_STUDIO_ORIGIN}",a="${PM_STUDIO_SPLIT_ORIGIN_MARKER}",h="X-CCDX-PM-Relay",d=new Set,m=I=>I.headers.get(h)===a,q=I=>AbortSignal.any([I,AbortSignal.timeout(750)].filter(Boolean)),f=(I,e=400)=>Response.json({error:{code:I}},{status:e,headers:{[h]:a}});globalThis.fetch=async(I,e)=>{const t=I.url||I+"";if(t===\`\${l.API_ENDPOINT}/models\`){try{const t=await c(\`\${n}/models\`,e);if(t.ok&&m(t))try{let I=await t.clone().json(),e=I.data||I;if(Array.isArray(e)){d.clear();for(const I of e)/anthropic/i.test(I.vendor||I.owned_by)&&d.add(I.id);return t}}catch{}t.body?.cancel?.()?.catch?.(()=>{})}catch(I){if(e?.signal?.aborted)throw e.signal.reason||I}return c(I,e)}const s=t.startsWith(l.API_ENDPOINT)?t.slice(l.API_ENDPOINT.length):"";if("POST"===e?.method&&["/chat/completions","/responses","/embeddings"].includes(s)){let t="";try{t=(JSON.parse(e.body).model||"").trim()}catch{}if(d.has(t)||/^claude-/i.test(t)){if("/chat/completions"!==s)return f("model_not_supported");try{const I=await c(\`\${n}/models\`,{signal:q(e?.signal)}),t=401===I.status&&m(I);await I.text();if(!t)throw 0;const l=await c(\`\${n}\${s}\`,e);if(!m(l)){await l.body?.cancel?.();throw 0}return l}catch(I){if(e?.signal?.aborted)throw e.signal.reason||I;return f("relay_incompatible",503)}}}return c(I,e)}}`;
  if (source.length > PM_STUDIO_COPILOT_CONFIG_MODULE_LENGTH) {
    throw new Error("PM Studio split-origin module exceeds its exact source window");
  }
  return `${source.slice(0, -1)}${" ".repeat(PM_STUDIO_COPILOT_CONFIG_MODULE_LENGTH - source.length)}}`;
}

export const PM_STUDIO_SPLIT_ORIGIN_CONFIG_MODULE = splitOriginConfigModule();

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
  patchedAsarSha256: "799dc18103a4553daefcaaddbe3410a1bfaf68d84407f4c10ef3d996afd71ad0",
  patchedHeaderSha256: "08253795176d5471c6f406a29ccb134875d503bb55bca909b2cd131cd7708510",
  predecessor: Object.freeze({
    id: "split-origin-v1-model-discovery-750ms",
    kind: "split-origin-predecessor",
    asarSha256: "d520d115604225c1a3feb749dbe29ad0d2cd175c5233c010de0e1fade527fa0b",
    headerSha256: "83e5fba3b6751b3098d8f6901db361a9b620ab3b924e0e551d3df612ff412642",
    signingMetadata: Object.freeze({
      identifier: "com.pm-studio.app",
      flags: "0x10002(adhoc,runtime)",
      runtime_version: "26.0.0",
      entitlements_sha256: "9d4ccbda4fe0c81a70df3db93b3e61fe0500f67f14cdcbee4dea230e6512d05c",
    }),
  }),
  targets: Object.freeze([
    Object.freeze({
      path: "dist/main/main.js",
      offset: 101_621_627,
      size: 9_909_974,
      blockSize: 4_194_304,
      sourceSha256: "58383be112886becdb8d8e7cce1b3efce07be6716190aa4940627f456eb8edb2",
      patchedSha256: "b219d08290b208fe41fa29b1e8ac4a1dee789e15f68fd4ff01eb5cd21249099b",
      predecessorSha256: "69156040fb233a835b7be2f86fbe2f653380f03379adfedf46c63ab45de9d39d",
      sourceBlocks: Object.freeze([
        "3ce05a21e8992ccf12966cf9b78fcd28b2f66e6786489b5bb0a06f1d4b2a0c1e",
        "0a4832413d8d8cdda67c8bb318c0e5c25df20c75802d637097ffd045a31cd443",
        "bcc10582d8a74717f8f81b98182d3551f1eaf23eb9cadd908d160ce5e4ef8cba",
      ]),
      patchedBlocks: Object.freeze([
        "dcbffb0f3aaa79a5ca8f1ee9170826b874d9db237c230abcdc0490335b2dc6a8",
        "0a4832413d8d8cdda67c8bb318c0e5c25df20c75802d637097ffd045a31cd443",
        "bcc10582d8a74717f8f81b98182d3551f1eaf23eb9cadd908d160ce5e4ef8cba",
      ]),
      predecessorBlocks: Object.freeze([
        "f0b5585d2ff0d403e5c4d35e9bd0b8cbfec5c41a9b9057b8cc808107e889cf46",
        "0a4832413d8d8cdda67c8bb318c0e5c25df20c75802d637097ffd045a31cd443",
        "bcc10582d8a74717f8f81b98182d3551f1eaf23eb9cadd908d160ce5e4ef8cba",
      ]),
      edit: Object.freeze({
        offset: 1_120_359,
        absoluteOffset: 106_574_750,
        length: PM_STUDIO_COPILOT_CONFIG_MODULE_LENGTH,
        anchor: "47024(I,e,t){",
        anchorCount: 1,
        sourceSha256: PM_STUDIO_COPILOT_CONFIG_MODULE_SOURCE_SHA256,
        patchedSha256: "873d2dd276bd12a7dc2876f5eaf8c67d4ae34749ead8911d0588badf4e9fc0cf",
        predecessorSha256: "a5b9312ed78e8a7fc3bd38f7ea5d4ab008f21bae18ba3dd6aa2d4be6b69191db",
        replacement: PM_STUDIO_SPLIT_ORIGIN_CONFIG_MODULE,
      }),
    }),
  ]),
  legacy: Object.freeze({
    kind: "global-origin-replacement",
    asarSha256: "3dd0f53cdaa35a644d2cf56e4fc2dd20f5c90dc2989b6d81a467ef00ebb620a7",
    headerSha256: "86ed1113a563b82ecec05de89aab87a5fd1666f35bee76e2d76e2ed5f6dcb3fa",
  }),
});

export const PM_STUDIO_2_9_10_RECIPE = Object.freeze({
  id: "pm-studio-2.9.10-build-2.9.10",
  version: "2.9.10",
  build: "2.9.10",
  bundleIdentifier: "com.pm-studio.app",
  sourceTeamIdentifier: "HL75GKK4W4",
  sourceArtifact: Object.freeze({
    releaseUrl: "https://github.com/gim-home/max-studio/releases/tag/v2.9.10",
    asset: "PM-Studio-2.9.10-mac-arm64.zip",
    sha256: "85654e6ed173ce2565b5ef3694137de2c5f92eba1b749316c9e5b63181ccc3b0",
  }),
  sourceBundleContent: Object.freeze({
    scheme: "ccdx-bundle-content-v2",
    sha256: "478ca7f1f0826b07b7706fd1f410dee01b6dbaae21c40c63ecbdc0942eab63d9",
    entryCount: 1_521,
    regularFileCount: 1_013,
    regularBytes: 494_995_602,
    symlinkCount: 14,
    xattrCount: 735,
    ignoredXattrs: Object.freeze([
      "com.apple.macl",
      "com.apple.provenance",
      "com.apple.quarantine",
    ]),
  }),
  sourceCodeSignature: Object.freeze({
    identifier: "com.pm-studio.app",
    teamIdentifier: "HL75GKK4W4",
    flags: "0x10000(runtime)",
    runtimeVersion: "26.0.0",
    cdHashFull: "86a4d64946123d21d20918041e88f58e8c497ce1a1f75a9f9d8cd592ce86e158",
    notarizationTicket: "stapled",
  }),
  patchedSigningMetadata: Object.freeze({
    identifier: "com.pm-studio.app",
    flags: "0x10002(adhoc,runtime)",
    runtime_version: "26.0.0",
    entitlements_sha256: "9d4ccbda4fe0c81a70df3db93b3e61fe0500f67f14cdcbee4dea230e6512d05c",
  }),
  executable: "PM Studio",
  sourceExecutableSha256: "a38f2054abb9770ba35d054d447be0de8e7c9d4fed6b37486bf15cf28de1e122",
  electronFrameworkPath: "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
  sourceElectronFrameworkSha256: "a562a31f8f8d14440974466e5e611b19d93705dcf3ca2f57647578ffc002f5b4",
  embeddedAsarIntegrity: "absent",
  asarPath: "Contents/Resources/app.asar",
  infoPlistPath: "Contents/Info.plist",
  integrityKey: "ElectronAsarIntegrity.Resources/app.asar",
  dataOffset: 3_833_292,
  sourceAsarSha256: "d243860770e8b1d8044213924f9704d1fc52f900d6c33461eff6358962330b78",
  sourceHeaderSha256: "5fc77d5b61e9647fba10fd2bd5752d0889c14da5a00b21d31bc48fdcccf74a69",
  patchedAsarSha256: "f309fc7e86bb4edaf1fecd9061fb4ddc634357c0ba9299f1d13f8b2ff33efd90",
  patchedHeaderSha256: "98c4af8656e61cc1a1a8b2188592a499a987136f8e6b763b0e83abda788e798d",
  predecessor: Object.freeze({
    id: "split-origin-v1-model-discovery-750ms",
    kind: "split-origin-predecessor",
    asarSha256: "ea28d998056b32ca4115d208a4d81ce629c83f3f5f89c6a66d50749849beb6fc",
    headerSha256: "348d80f5f2d1ebb92e6089195b1703b87467678f80d8946b8ab83b3ead03e5be",
    signingMetadata: Object.freeze({
      identifier: "com.pm-studio.app",
      flags: "0x10002(adhoc,runtime)",
      runtime_version: "26.0.0",
      entitlements_sha256: "9d4ccbda4fe0c81a70df3db93b3e61fe0500f67f14cdcbee4dea230e6512d05c",
    }),
  }),
  targets: Object.freeze([
    Object.freeze({
      path: "dist/main/main.js",
      offset: 101_622_115,
      size: 10_150_157,
      blockSize: 4_194_304,
      sourceSha256: "03607bb1edc068396b99f02b9c9e0d8e10388fb658afc112e06e875c123dbc27",
      patchedSha256: "71e936c79c3560ab5bd9813479f8a66f4a7b06629edca74953feaaf7904a6564",
      predecessorSha256: "b5b5e37af3d06ffc603bdef620fc1e0254580f0ee325f1a77096af6c78379b79",
      sourceBlocks: Object.freeze([
        "3910a9bc5459f493956aafee7b3644e8d242027758f0dcdea97d7c10a324c6bf",
        "49fa64c68425d35b1baff0d5745d856d377e014a7a7829322cd1b39aade9532e",
        "bd7cc14a1d2e02abe66c0ec6fc4e97b263cfc1f67c4ae39e956c06d3bcc2fe67",
      ]),
      patchedBlocks: Object.freeze([
        "203ad1efbdcd869314510086632fdb0089196eb25179c46fb4108133cc65412f",
        "49fa64c68425d35b1baff0d5745d856d377e014a7a7829322cd1b39aade9532e",
        "bd7cc14a1d2e02abe66c0ec6fc4e97b263cfc1f67c4ae39e956c06d3bcc2fe67",
      ]),
      predecessorBlocks: Object.freeze([
        "63aa15d8c44614a7b2d9656ddba23109d40bab66b66b36339154953bd164da75",
        "49fa64c68425d35b1baff0d5745d856d377e014a7a7829322cd1b39aade9532e",
        "bd7cc14a1d2e02abe66c0ec6fc4e97b263cfc1f67c4ae39e956c06d3bcc2fe67",
      ]),
      edit: Object.freeze({
        offset: 1_241_223,
        absoluteOffset: 106_696_630,
        length: PM_STUDIO_COPILOT_CONFIG_MODULE_LENGTH,
        anchor: "47024(I,e,t){",
        anchorCount: 1,
        sourceSha256: PM_STUDIO_COPILOT_CONFIG_MODULE_SOURCE_SHA256,
        patchedSha256: "873d2dd276bd12a7dc2876f5eaf8c67d4ae34749ead8911d0588badf4e9fc0cf",
        predecessorSha256: "a5b9312ed78e8a7fc3bd38f7ea5d4ab008f21bae18ba3dd6aa2d4be6b69191db",
        replacement: PM_STUDIO_SPLIT_ORIGIN_CONFIG_MODULE,
      }),
    }),
  ]),
  legacy: Object.freeze({
    kind: "global-origin-replacement",
    asarSha256: "49f72d999a6085102341c2d551577e164db6f22e4707d2112efa3fd280e7315e",
    headerSha256: "b264ece5b8e469cd3885a7a91f904f1902e1991f214ecbf228dfe91059ac7008",
  }),
});

export const PM_STUDIO_RECIPES = Object.freeze([
  PM_STUDIO_2_9_7_RECIPE,
  PM_STUDIO_2_9_10_RECIPE,
]);

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

function inspectTarget(parsed, target) {
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
  let edit = null;
  if (target.edit) {
    let editOffset;
    let editLength;
    try {
      editOffset = integer(target.edit.offset, `${target.path} edit offset`);
      editLength = integer(target.edit.length, `${target.path} edit length`);
    } catch (error) {
      return { path: target.path, offset, size, absoluteOffset, malformed: error.message };
    }
    if (editLength === 0 || editOffset + editLength > bytes.length) {
      return { path: target.path, offset, size, absoluteOffset, malformed: "edit window is outside the target" };
    }
    const anchor = Buffer.from(target.edit.anchor || "");
    edit = {
      offset: editOffset,
      absoluteOffset: absoluteOffset + editOffset,
      length: editLength,
      sha256: sha256Hex(bytes.subarray(editOffset, editOffset + editLength)),
      anchorPositions: occurrencePositions(bytes, anchor),
    };
  }
  return {
    path: target.path,
    offset,
    size,
    absoluteOffset,
    sha256: sha256Hex(bytes),
    blockSize: entry.integrity?.blockSize,
    blocks: blockSha256(bytes, target.blockSize),
    integrity: entry.integrity || null,
    edit,
  };
}

function targetStateIssues(detail, target, state) {
  const issues = [];
  if (detail.missing) return [`${target.path}: entry is missing`];
  if (detail.malformed) return [`${target.path}: ${detail.malformed}`];

  addMismatch(issues, `${target.path} offset`, detail.offset, target.offset);
  addMismatch(issues, `${target.path} size`, detail.size, target.size);
  addMismatch(issues, `${target.path} integrity algorithm`,
    detail.integrity?.algorithm, "SHA256");
  addMismatch(issues, `${target.path} block size`, detail.integrity?.blockSize, target.blockSize);

  const patched = state === "patched";
  const predecessor = state === "predecessor";
  const expectedHash = patched
    ? target.patchedSha256
    : predecessor ? target.predecessorSha256 : target.sourceSha256;
  const expectedBlocks = patched
    ? target.patchedBlocks
    : predecessor ? target.predecessorBlocks : target.sourceBlocks;

  addMismatch(issues, `${target.path} SHA-256`, detail.sha256, expectedHash);
  addMismatch(issues, `${target.path} integrity hash`, detail.integrity?.hash, expectedHash);
  if (!sameArray(detail.blocks, expectedBlocks)) issues.push(`${target.path} computed block hashes do not match ${state} recipe`);
  if (!sameArray(detail.integrity?.blocks, expectedBlocks)) issues.push(`${target.path} header block hashes do not match ${state} recipe`);
  if (target.edit) {
    addMismatch(issues, `${target.path} edit offset`, detail.edit?.offset, target.edit.offset);
    addMismatch(issues, `${target.path} absolute edit offset`, detail.edit?.absoluteOffset, target.edit.absoluteOffset);
    addMismatch(issues, `${target.path} edit length`, detail.edit?.length, target.edit.length);
    addMismatch(issues, `${target.path} edit SHA-256`, detail.edit?.sha256,
      patched
        ? target.edit.patchedSha256
        : predecessor ? target.edit.predecessorSha256 : target.edit.sourceSha256);
    if (!sameArray(detail.edit?.anchorPositions, [target.edit.offset])) {
      issues.push(`${target.path} module anchor position/count does not match recipe`);
    }
    if (detail.edit?.anchorPositions?.length !== target.edit.anchorCount) {
      issues.push(`${target.path} module anchor count is ${detail.edit?.anchorPositions?.length || 0}, expected ${target.edit.anchorCount}`);
    }
  }
  return issues;
}

export function inspectAsarBuffer(value, recipe = PM_STUDIO_2_9_7_RECIPE) {
  const parsed = parseAsarBuffer(value);
  const asarSha256 = sha256Hex(parsed.buffer);
  const headerSha256 = sha256Hex(parsed.headerBytes);
  const targets = recipe.targets.map((target) => inspectTarget(parsed, target));
  const commonIssues = [];
  addMismatch(commonIssues, "ASAR data offset", parsed.dataOffset, recipe.dataOffset);

  const issuesFor = (state) => {
    const patched = state === "patched";
    const predecessor = state === "predecessor";
    const expected = predecessor ? recipe.predecessor : null;
    const issues = [...commonIssues];
    addMismatch(issues, "ASAR SHA-256", asarSha256,
      patched ? recipe.patchedAsarSha256 : predecessor ? expected?.asarSha256 : recipe.sourceAsarSha256);
    addMismatch(issues, "ASAR header SHA-256", headerSha256,
      patched ? recipe.patchedHeaderSha256 : predecessor ? expected?.headerSha256 : recipe.sourceHeaderSha256);
    for (let index = 0; index < recipe.targets.length; index += 1) {
      issues.push(...targetStateIssues(targets[index], recipe.targets[index], state));
    }
    return issues;
  };

  const cleanIssues = issuesFor("clean");
  const patchedIssues = issuesFor("patched");
  const predecessorIssues = recipe.predecessor
    ? issuesFor("predecessor")
    : ["recipe has no recognized predecessor patch"];
  const legacyIssues = [...commonIssues];
  if (!recipe.legacy) {
    legacyIssues.push("recipe has no recognized legacy patch");
  } else {
    addMismatch(legacyIssues, "ASAR SHA-256", asarSha256, recipe.legacy.asarSha256);
    addMismatch(legacyIssues, "ASAR header SHA-256", headerSha256, recipe.legacy.headerSha256);
  }
  const state = cleanIssues.length === 0
    ? "clean"
    : patchedIssues.length === 0
      ? "patched"
      : predecessorIssues.length === 0
        ? "predecessor"
        : legacyIssues.length === 0 ? "legacy" : "drift";
  return {
    recipeId: recipe.id,
    state,
    asarSha256,
    headerSha256,
    dataOffset: parsed.dataOffset,
    targets,
    cleanIssues,
    patchedIssues,
    predecessorIssues,
    legacyIssues,
  };
}

export function patchAsarBuffer(value, recipe = PM_STUDIO_2_9_7_RECIPE) {
  const before = inspectAsarBuffer(value, recipe);
  if (before.state === "patched") {
    return { changed: false, buffer: Buffer.from(value), before, after: before };
  }
  if (before.state === "predecessor") {
    const error = new Error("Predecessor PM Studio split-origin patch must be migrated from a verified clean backup");
    error.code = "PM_STUDIO_ASAR_PREDECESSOR";
    error.inspection = before;
    throw error;
  }
  if (before.state === "legacy") {
    const error = new Error("Legacy PM Studio global-origin patch must be migrated from a verified clean backup");
    error.code = "PM_STUDIO_ASAR_LEGACY";
    error.inspection = before;
    throw error;
  }
  if (before.state !== "clean") {
    const error = new Error("PM Studio ASAR does not match the clean, current split-origin, predecessor, or legacy recipe");
    error.code = "PM_STUDIO_ASAR_DRIFT";
    error.inspection = before;
    throw error;
  }

  const output = Buffer.from(value);
  const parsed = parseAsarBuffer(output);

  for (const target of recipe.targets) {
    const entry = findAsarEntry(parsed.header, target.path);
    const offset = entryOffset(entry.offset, `${target.path} offset`);
    const edit = target.edit;
    if (!edit) throw new Error(`${target.path} has no split-origin edit recipe`);
    const replacement = Buffer.from(edit.replacement);
    if (replacement.length !== edit.length || sha256Hex(replacement) !== edit.patchedSha256) {
      throw new Error(`${target.path} split-origin replacement does not match its recipe`);
    }
    const absoluteEditOffset = parsed.dataOffset + offset + edit.offset;
    if (absoluteEditOffset !== edit.absoluteOffset) {
      throw new Error(`${target.path} split-origin edit moved before patching`);
    }
    const existing = output.subarray(absoluteEditOffset, absoluteEditOffset + edit.length);
    if (sha256Hex(existing) !== edit.sourceSha256) {
      throw new Error(`${target.path} source edit window does not match its recipe`);
    }
    replacement.copy(output, absoluteEditOffset);
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
