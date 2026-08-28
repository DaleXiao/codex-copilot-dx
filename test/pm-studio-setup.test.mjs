import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import {
  CCDX_PM_STUDIO_ORIGIN,
  ELECTRON_ASAR_INTEGRITY_SENTINEL,
  PM_STUDIO_2_9_10_RECIPE,
  PM_STUDIO_2_9_7_RECIPE,
  PM_STUDIO_ORIGIN,
  PM_STUDIO_SPLIT_ORIGIN_CONFIG_MODULE,
  PM_STUDIO_SPLIT_ORIGIN_MARKER,
  blockSha256,
  inspectAsarFile,
  inspectAsarBuffer,
  inspectElectronAsarIntegrityFile,
  inspectElectronAsarIntegritySlots,
  patchAsarBuffer,
  sha256Hex,
} from "../src/pm-studio-asar.mjs";
import {
  PM_STUDIO_CLAUDE_AUTH_COMMAND,
  createPmStudioSetupOperations,
  inspectBundleContent,
  inspectPmStudioApp,
  resolvePmStudioCompatibleRecipe,
  runPmStudioRestore,
  runPmStudioSetup,
} from "../src/pm-studio-setup.mjs";

const temporaryRoots = new Set();
const COMPATIBLE_PM_STUDIO_CONFIG_MODULE = '47024(I,e,t){"use strict";t.d(e,{qn:()=>l});const l={CLIENT_ID:"Iv1.b507a08c87ecfe98",CLIENT_SECRET:void 0,API_ENDPOINT:"https://api.githubcopilot.com",DEVICE_CODE_URL:"https://github.com/login/device/code",ACCESS_TOKEN_URL:"https://github.com/login/oauth/access_token",COPILOT_TOKEN_URL:"https://api.github.com/copilot_internal/v2/token",USER_AGENT:"GitHubCopilotChat/0.26.7",EDITOR_VERSION:"vscode/1.99.3",EDITOR_PLUGIN_VERSION:"copilot-chat/0.26.7",INTEGRATION_ID:"vscode-chat",STANDARD_HEADERS:{Accept:"application/json","Content-Type":"application/json","User-Agent":"GitHubCopilotChat/0.26.7","Editor-Version":"vscode/1.99.3","Editor-Plugin-Version":"copilot-chat/0.26.7","Copilot-Integration-Id":"vscode-chat","X-Request-Id":()=>`req_${Date.now()}_${Math.random().toString(36).substr(2,9)}`}};class c{constructor(){this.config={...l}}static getInstance(){return c.instance||(c.instance=new c),c.instance}getConfig(){return{...this.config}}updateConfig(I){this.config={...this.config,...I}}resetConfig(){this.config={...l}}validateConfig(){return function(){const I=[];return l.CLIENT_ID||I.push("GitHub Copilot Client ID is required"),l.API_ENDPOINT||I.push("GitHub Copilot API endpoint is required"),{valid:0===I.length,errors:I}}()}getStandardHeaders(I){return function(I){const e={Accept:l.STANDARD_HEADERS.Accept,"Content-Type":l.STANDARD_HEADERS["Content-Type"],"User-Agent":l.STANDARD_HEADERS["User-Agent"],"Editor-Version":l.STANDARD_HEADERS["Editor-Version"],"Editor-Plugin-Version":l.STANDARD_HEADERS["Editor-Plugin-Version"],"Copilot-Integration-Id":l.STANDARD_HEADERS["Copilot-Integration-Id"],"X-Request-Id":"function"==typeof l.STANDARD_HEADERS["X-Request-Id"]?l.STANDARD_HEADERS["X-Request-Id"]():l.STANDARD_HEADERS["X-Request-Id"]};return I&&(e.Authorization=`Bearer ${I}`),e}(I)}getCopilotTokenHeaders(I){return function(I){return{Authorization:`Bearer ${I}`,Accept:"application/json","User-Agent":l.USER_AGENT,"Editor-Version":l.EDITOR_VERSION,"Editor-Plugin-Version":l.EDITOR_PLUGIN_VERSION}}(I)}getDeviceCodeHeaders(){return{Accept:"application/json","User-Agent":l.USER_AGENT}}}c.getInstance()}';

function temporaryRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.add(root);
  return root;
}

after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

function align4(value) {
  return (value + 3) & ~3;
}

function addHeaderEntry(header, filePath, entry) {
  const parts = filePath.split("/");
  let files = header.files;
  for (let index = 0; index < parts.length - 1; index += 1) {
    files[parts[index]] ||= { files: {} };
    files = files[parts[index]].files;
  }
  files[parts.at(-1)] = entry;
}

function buildArchive(header, contents) {
  const headerBytes = Buffer.from(JSON.stringify(header));
  const headerPayloadSize = align4(4 + headerBytes.length);
  const headerPickleSize = 4 + headerPayloadSize;
  const dataOffset = 8 + headerPickleSize;
  const archive = Buffer.alloc(dataOffset + contents.reduce((sum, value) => sum + value.length, 0));
  archive.writeUInt32LE(4, 0);
  archive.writeUInt32LE(headerPickleSize, 4);
  archive.writeUInt32LE(headerPayloadSize, 8);
  archive.writeUInt32LE(headerBytes.length, 12);
  headerBytes.copy(archive, 16);
  let offset = dataOffset;
  for (const content of contents) {
    content.copy(archive, offset);
    offset += content.length;
  }
  return { archive, dataOffset, headerSha256: sha256Hex(headerBytes) };
}

function replaceAt(buffer, offset, before, after) {
  const output = Buffer.from(buffer);
  assert.equal(Buffer.byteLength(before), Buffer.byteLength(after));
  assert.equal(output.subarray(offset, offset + Buffer.byteLength(before)).toString(), before);
  output.write(after, offset);
  return output;
}

function makeAsarFixture({
  version = "2.9.7",
  build = version,
  compatible = false,
  duplicateAnchor = false,
  blockSize = 16,
} = {}) {
  const anchor = "47024(I,e,t){";
  const sourceWindow = compatible
    ? COMPATIBLE_PM_STUDIO_CONFIG_MODULE
    : `${anchor}const l={API_ENDPOINT:"${PM_STUDIO_ORIGIN}"};${"s".repeat(24)}}`;
  const replacementWindow = compatible
    ? PM_STUDIO_SPLIT_ORIGIN_CONFIG_MODULE
    : `${anchor}const l={API_ENDPOINT:"${PM_STUDIO_ORIGIN}"};${"p".repeat(24)}}`;
  const predecessorWindow = compatible
    ? `${anchor}${"o".repeat(Buffer.byteLength(sourceWindow) - Buffer.byteLength(anchor))}`
    : `${anchor}const l={API_ENDPOINT:"${PM_STUDIO_ORIGIN}"};${"o".repeat(24)}}`;
  const editOffset = 19;
  const modulePrefix = compatible ? `${"a".repeat(editOffset - 1)},` : "a".repeat(editOffset);
  const sourceContents = [
    Buffer.from(`${modulePrefix}${sourceWindow}${compatible ? "," : ""}${"b".repeat(31)}${duplicateAnchor ? `${compatible ? "," : ""}${sourceWindow}` : ""}`),
    Buffer.from(`${"x".repeat(7)}${PM_STUDIO_ORIGIN}${"y".repeat(13)}`),
  ];
  const patchedContents = [
    replaceAt(sourceContents[0], editOffset, sourceWindow, replacementWindow),
    sourceContents[1],
  ];
  const predecessorContents = [
    replaceAt(sourceContents[0], editOffset, sourceWindow, predecessorWindow),
    sourceContents[1],
  ];
  const legacyContents = sourceContents.map((content) => {
    const sentinelOffset = content.indexOf(PM_STUDIO_ORIGIN);
    return replaceAt(content, sentinelOffset, PM_STUDIO_ORIGIN, CCDX_PM_STUDIO_ORIGIN);
  });
  const paths = ["dist/main/main.js", "dist/renderer/js/main.fixture.js"];
  const entries = [];
  let entryOffset = 0;
  for (let index = 0; index < paths.length; index += 1) {
    entries.push({
      path: paths[index],
      offset: entryOffset,
      size: sourceContents[index].length,
    });
    entryOffset += sourceContents[index].length;
  }

  const headerFor = (contents) => {
    const header = { files: {} };
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      addHeaderEntry(header, entry.path, {
        size: entry.size,
        offset: String(entry.offset),
        integrity: {
          algorithm: "SHA256",
          hash: sha256Hex(contents[index]),
          blockSize,
          blocks: blockSha256(contents[index], blockSize),
        },
      });
    }
    return header;
  };

  const source = buildArchive(headerFor(sourceContents), sourceContents);
  const patched = buildArchive(headerFor(patchedContents), patchedContents);
  const predecessor = buildArchive(headerFor(predecessorContents), predecessorContents);
  const legacy = buildArchive(headerFor(legacyContents), legacyContents);
  assert.equal(source.dataOffset, patched.dataOffset);
  assert.equal(source.dataOffset, predecessor.dataOffset);
  assert.equal(source.dataOffset, legacy.dataOffset);
  const target = {
    ...entries[0],
    blockSize,
    sourceSha256: sha256Hex(sourceContents[0]),
    patchedSha256: sha256Hex(patchedContents[0]),
    predecessorSha256: sha256Hex(predecessorContents[0]),
    sourceBlocks: blockSha256(sourceContents[0], blockSize),
    patchedBlocks: blockSha256(patchedContents[0], blockSize),
    predecessorBlocks: blockSha256(predecessorContents[0], blockSize),
    edit: {
      offset: editOffset,
      absoluteOffset: source.dataOffset + editOffset,
      length: Buffer.byteLength(sourceWindow),
      anchor,
      anchorCount: 1,
      sourceSha256: sha256Hex(sourceWindow),
      patchedSha256: sha256Hex(replacementWindow),
      predecessorSha256: sha256Hex(predecessorWindow),
      replacement: replacementWindow,
    },
  };
  const recipe = {
    id: `pm-studio-fixture-${version}-${build}`,
    version,
    build,
    bundleIdentifier: "com.pm-studio.app",
    sourceTeamIdentifier: "HL75GKK4W4",
    executable: "PM Studio",
    sourceExecutableSha256: "fixture-main-source",
    electronFrameworkPath: "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
    sourceElectronFrameworkSha256: "fixture-framework-source",
    embeddedAsarIntegrity: "absent",
    asarPath: "Contents/Resources/app.asar",
    infoPlistPath: "Contents/Info.plist",
    integrityKey: "ElectronAsarIntegrity.Resources/app.asar",
    dataOffset: source.dataOffset,
    sourceAsarSha256: sha256Hex(source.archive),
    sourceHeaderSha256: source.headerSha256,
    patchedAsarSha256: sha256Hex(patched.archive),
    patchedHeaderSha256: patched.headerSha256,
    predecessor: {
      id: "split-origin-v1-model-discovery-750ms",
      kind: "split-origin-predecessor",
      asarSha256: sha256Hex(predecessor.archive),
      headerSha256: predecessor.headerSha256,
      signingMetadata: {
        identifier: "com.pm-studio.app",
        flags: "0x10002(adhoc,runtime)",
        runtime_version: "15.0.0",
        entitlements_sha256: "fixture-entitlements",
      },
    },
    targets: [target],
    legacy: {
      kind: "global-origin-replacement",
      asarSha256: sha256Hex(legacy.archive),
      headerSha256: legacy.headerSha256,
    },
  };
  return {
    recipe,
    source: source.archive,
    patched: patched.archive,
    predecessor: predecessor.archive,
    legacy: legacy.archive,
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createAppFixture(root, fixture, { signature = "vendor", state = "clean" } = {}) {
  const appPath = path.join(root, "PM Studio.app");
  const contents = path.join(appPath, "Contents");
  const resources = path.join(contents, "Resources");
  fs.mkdirSync(resources, { recursive: true });
  const asar = state === "legacy"
    ? fixture.legacy
    : state === "predecessor" ? fixture.predecessor : state === "patched" ? fixture.patched : fixture.source;
  const integrityHash = state === "legacy"
    ? fixture.recipe.legacy.headerSha256
    : state === "predecessor"
      ? fixture.recipe.predecessor.headerSha256
      : state === "patched" ? fixture.recipe.patchedHeaderSha256 : fixture.recipe.sourceHeaderSha256;
  fs.writeFileSync(path.join(resources, "app.asar"), asar);
  writeJson(path.join(contents, "Info.plist"), {
    version: fixture.recipe.version,
    build: fixture.recipe.build,
    bundleIdentifier: fixture.recipe.bundleIdentifier,
    integrity: { algorithm: "SHA256", hash: integrityHash },
  });
  fs.writeFileSync(path.join(contents, ".fixture-signature"), signature);
  return appPath;
}

function fixtureOperations({
  signCounter = { value: 0 },
  blocking = [],
  freeBytes = Number.MAX_SAFE_INTEGER,
  signatureFailure = false,
  uuidPrefix = "fixture",
} = {}) {
  let nextId = 0;
  return {
    readBundleMetadata: ({ infoPlistPath }) => {
      const plist = JSON.parse(fs.readFileSync(infoPlistPath, "utf8"));
      return { version: plist.version, build: plist.build, bundleIdentifier: plist.bundleIdentifier };
    },
    readAsarIntegrity: ({ infoPlistPath }) => JSON.parse(fs.readFileSync(infoPlistPath, "utf8")).integrity,
    writeAsarIntegrity: ({ infoPlistPath, hash }) => {
      const plist = JSON.parse(fs.readFileSync(infoPlistPath, "utf8"));
      plist.integrity = { algorithm: "SHA256", hash };
      writeJson(infoPlistPath, plist);
    },
    inspectCodeSign: ({ appPath, infoPlistPath = path.join(appPath, "Contents/Info.plist") }) => {
      const state = fs.readFileSync(path.join(appPath, "Contents/.fixture-signature"), "utf8");
      const unsigned = state === "unsigned";
      const bundleIdentifier = JSON.parse(fs.readFileSync(infoPlistPath, "utf8")).bundleIdentifier;
      return {
        valid: !["invalid", "unsigned"].includes(state),
        verifyValid: !["invalid", "unsigned"].includes(state),
        displayValid: !unsigned,
        entitlementsState: unsigned ? "unavailable" : "xml",
        adHoc: state === "adhoc",
        identifier: unsigned ? "" : bundleIdentifier,
        teamIdentifier: state === "adhoc" ? "not set" : unsigned ? "" : "HL75GKK4W4",
        flags: state === "adhoc" ? "0x10002(adhoc,runtime)" : unsigned ? "" : "0x10000(runtime)",
        runtimeVersion: unsigned ? "" : "15.0.0",
        entitlementsSha256: unsigned ? "" : "fixture-entitlements",
      };
    },
    inspectExecutableIntegrity: () => ({
      executableName: "PM Studio",
      executableSha256: "fixture-main-source",
      frameworkSha256: "fixture-framework-source",
      embeddedIntegrity: { state: "absent", supported: true, executable: { slots: [] }, framework: { slots: [] } },
      matchesRecipeName: true,
    }),
    inspectBundleContent: ({ appPath }) => inspectBundleContent(appPath),
    signApp: ({ appPath }) => {
      signCounter.value += 1;
      if (signatureFailure) throw new Error("fixture sign failed");
      fs.writeFileSync(path.join(appPath, "Contents/.fixture-signature"), "adhoc");
    },
    copyBundle: ({ source, destination }) => fs.cpSync(source, destination, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      preserveTimestamps: true,
    }),
    replaceApp: ({ appPath, stagePath }) => {
      const previousPath = `${appPath}.fixture-previous`;
      fs.renameSync(appPath, previousPath);
      fs.renameSync(stagePath, appPath);
      fs.rmSync(previousPath, { recursive: true, force: true });
    },
    listBlockingProcesses: () => blocking,
    bundleSize: () => 1024,
    availableBytes: () => freeBytes,
    volumeId: () => "fixture-volume",
    readClaudeCredentials: () => ({
      configured: true,
      valid: true,
      reason: "",
      token: "SECRET_TOKEN_MUST_NOT_ENTER_MANIFEST",
      identity: { login: "personal" },
    }),
    now: () => new Date("2026-08-07T00:00:00.000Z"),
    uuid: () => `${uuidPrefix}-${nextId += 1}`,
  };
}

function sourceSnapshot(appPath) {
  return {
    asar: fs.readFileSync(path.join(appPath, "Contents/Resources/app.asar")),
    plist: fs.readFileSync(path.join(appPath, "Contents/Info.plist")),
    signature: fs.readFileSync(path.join(appPath, "Contents/.fixture-signature")),
  };
}

function assertSnapshot(appPath, snapshot) {
  assert.deepEqual(fs.readFileSync(path.join(appPath, "Contents/Resources/app.asar")), snapshot.asar);
  assert.deepEqual(fs.readFileSync(path.join(appPath, "Contents/Info.plist")), snapshot.plist);
  assert.deepEqual(fs.readFileSync(path.join(appPath, "Contents/.fixture-signature")), snapshot.signature);
}

function schema2FixtureRecipe(appPath, fixture, operations) {
  const sourceBundleContent = {
    ...inspectBundleContent(appPath),
    ignoredXattrs: [],
  };
  const inspectCodeSign = operations.inspectCodeSign;
  operations.inspectCodeSign = (args) => {
    const inspected = inspectCodeSign(args);
    if (inspected.adHoc) return inspected;
    return {
      ...inspected,
      valid: false,
      verifyValid: false,
      displayValid: true,
      entitlementsState: "invalid",
      cdHashFull: "fixture-vendor-cdhash",
      notarizationTicket: "stapled",
    };
  };
  operations.inspectBundleContent = ({ appPath: inspectedPath }) => inspectBundleContent(inspectedPath);
  return {
    ...fixture.recipe,
    sourceBundleContent,
    sourceCodeSignature: {
      identifier: "com.pm-studio.app",
      teamIdentifier: "HL75GKK4W4",
      flags: "0x10000(runtime)",
      runtimeVersion: "15.0.0",
      cdHashFull: "fixture-vendor-cdhash",
      notarizationTicket: "stapled",
    },
    patchedSigningMetadata: {
      identifier: "com.pm-studio.app",
      flags: "0x10002(adhoc,runtime)",
      runtime_version: "15.0.0",
      entitlements_sha256: "fixture-entitlements",
    },
  };
}

function installPredecessorFixture({ appPath, fixture, recipe, manifestPath }) {
  fs.writeFileSync(path.join(appPath, recipe.asarPath), fixture.predecessor);
  const plistPath = path.join(appPath, recipe.infoPlistPath);
  const plist = JSON.parse(fs.readFileSync(plistPath, "utf8"));
  plist.integrity = { algorithm: "SHA256", hash: recipe.predecessor.headerSha256 };
  writeJson(plistPath, plist);

  if (!manifestPath) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const predecessorRecord = {
    ...manifest.patched,
    asar_sha256: recipe.predecessor.asarSha256,
    asar_header_sha256: recipe.predecessor.headerSha256,
    electron_asar_integrity: { algorithm: "SHA256", hash: recipe.predecessor.headerSha256 },
    ...(recipe.sourceBundleContent ? { bundle_content: inspectBundleContent(appPath) } : {}),
  };
  manifest.patched = predecessorRecord;
  delete manifest.predecessor_patched;
  writeJson(manifestPath, manifest);
  return predecessorRecord;
}

test("PM Studio 2.9.7 recipe locks one exact split-origin module edit and the legacy global patch", () => {
  assert.equal(PM_STUDIO_2_9_7_RECIPE.dataOffset, 3_832_764);
  assert.equal(PM_STUDIO_2_9_7_RECIPE.bundleIdentifier, "com.pm-studio.app");
  assert.equal(PM_STUDIO_2_9_7_RECIPE.sourceTeamIdentifier, "HL75GKK4W4");
  assert.equal(PM_STUDIO_2_9_7_RECIPE.targets.length, 1);
  assert.equal(PM_STUDIO_2_9_7_RECIPE.targets[0].edit.offset, 1_120_359);
  assert.equal(PM_STUDIO_2_9_7_RECIPE.targets[0].edit.absoluteOffset, 106_574_750);
  assert.equal(PM_STUDIO_2_9_7_RECIPE.targets[0].edit.length, 2_121);
  assert.equal(PM_STUDIO_2_9_7_RECIPE.targets[0].edit.anchorCount, 1);
  assert.equal(PM_STUDIO_2_9_7_RECIPE.executable, "PM Studio");
  assert.equal(PM_STUDIO_2_9_7_RECIPE.sourceExecutableSha256,
    "6364edd0561790610ee82399865f42f160523551d8d72220e26c4b18da324017");
  assert.equal(PM_STUDIO_2_9_7_RECIPE.sourceElectronFrameworkSha256,
    "e684d310334840f7a64f2d5171052eb514822af155779d3185e4f068daee4387");
  assert.equal(PM_STUDIO_2_9_7_RECIPE.legacy.asarSha256,
    "3dd0f53cdaa35a644d2cf56e4fc2dd20f5c90dc2989b6d81a467ef00ebb620a7");
  assert.equal(PM_STUDIO_2_9_7_RECIPE.predecessor.id, "split-origin-v1-model-discovery-750ms");
  assert.equal(PM_STUDIO_2_9_7_RECIPE.predecessor.kind, "split-origin-predecessor");
  assert.equal(PM_STUDIO_2_9_7_RECIPE.predecessor.asarSha256,
    "d520d115604225c1a3feb749dbe29ad0d2cd175c5233c010de0e1fade527fa0b");
  assert.equal(PM_STUDIO_SPLIT_ORIGIN_CONFIG_MODULE.length, 2_121);
  assert.equal(PM_STUDIO_SPLIT_ORIGIN_CONFIG_MODULE.match(/https:\/\/api\.githubcopilot\.com/g).length, 1);
  assert.equal(PM_STUDIO_SPLIT_ORIGIN_CONFIG_MODULE.match(/http:\/\/127\.0\.0\.1:2026\/pm-ccdx/g).length, 1);
  assert.equal(PM_STUDIO_SPLIT_ORIGIN_CONFIG_MODULE.match(/AbortSignal\.timeout\(750\)/g).length, 1);
  assert.equal(Buffer.byteLength(PM_STUDIO_ORIGIN), 29);
  assert.equal(Buffer.byteLength(CCDX_PM_STUDIO_ORIGIN), 29);
});

test("PM Studio 2.9.10 recipe retains legacy provenance while locking ASAR targets and patched signing", () => {
  assert.equal(PM_STUDIO_2_9_10_RECIPE.id, "pm-studio-2.9.10-build-2.9.10");
  assert.equal(PM_STUDIO_2_9_10_RECIPE.bundleIdentifier, "com.pm-studio.app");
  assert.deepEqual(PM_STUDIO_2_9_10_RECIPE.sourceArtifact, {
    releaseUrl: "https://github.com/gim-home/max-studio/releases/tag/v2.9.10",
    asset: "PM-Studio-2.9.10-mac-arm64.zip",
    sha256: "85654e6ed173ce2565b5ef3694137de2c5f92eba1b749316c9e5b63181ccc3b0",
  });
  assert.deepEqual(PM_STUDIO_2_9_10_RECIPE.sourceBundleContent, {
    scheme: "ccdx-bundle-content-v2",
    sha256: "478ca7f1f0826b07b7706fd1f410dee01b6dbaae21c40c63ecbdc0942eab63d9",
    entryCount: 1_521,
    regularFileCount: 1_013,
    regularBytes: 494_995_602,
    symlinkCount: 14,
    xattrCount: 735,
    ignoredXattrs: ["com.apple.macl", "com.apple.provenance", "com.apple.quarantine"],
  });
  assert.equal(PM_STUDIO_2_9_10_RECIPE.sourceAsarSha256,
    "d243860770e8b1d8044213924f9704d1fc52f900d6c33461eff6358962330b78");
  assert.equal(PM_STUDIO_2_9_10_RECIPE.patchedAsarSha256,
    "f309fc7e86bb4edaf1fecd9061fb4ddc634357c0ba9299f1d13f8b2ff33efd90");
  assert.equal(PM_STUDIO_2_9_10_RECIPE.targets.length, 1);
  assert.equal(PM_STUDIO_2_9_10_RECIPE.targets[0].edit.absoluteOffset, 106_696_630);
  assert.equal(PM_STUDIO_2_9_10_RECIPE.legacy.asarSha256,
    "49f72d999a6085102341c2d551577e164db6f22e4707d2112efa3fd280e7315e");
  assert.equal(PM_STUDIO_2_9_10_RECIPE.predecessor.asarSha256,
    "ea28d998056b32ca4115d208a4d81ce629c83f3f5f89c6a66d50749849beb6fc");
  assert.equal(PM_STUDIO_2_9_10_RECIPE.sourceCodeSignature.teamIdentifier, "HL75GKK4W4");
  assert.equal(PM_STUDIO_2_9_10_RECIPE.patchedSigningMetadata.entitlements_sha256,
    "9d4ccbda4fe0c81a70df3db93b3e61fe0500f67f14cdcbee4dea230e6512d05c");
});

test("compatible recipe resolution keeps an inspected exact-patch fallback for old manifests", () => {
  const operations = new Proxy({}, {
    get() {
      throw new Error("exact recipes must not inspect compatible sources or backups");
    },
  });
  let inspections = 0;
  assert.equal(resolvePmStudioCompatibleRecipe({
    appPath: "/Applications/PM Studio.app",
    backupRoot: "/unused",
    metadata: {
      version: PM_STUDIO_2_9_10_RECIPE.version,
      build: PM_STUDIO_2_9_10_RECIPE.build,
      bundleIdentifier: PM_STUDIO_2_9_10_RECIPE.bundleIdentifier,
    },
    recipes: [PM_STUDIO_2_9_7_RECIPE, PM_STUDIO_2_9_10_RECIPE],
    operations,
    inspectApp: () => {
      inspections += 1;
      return { state: "patched" };
    },
  }), PM_STUDIO_2_9_10_RECIPE);
  assert.equal(inspections, 1);
});

test("ASAR helpers classify clean/split-origin/legacy/drift and patch only the exact module window", () => {
  const fixture = makeAsarFixture();
  const clean = inspectAsarBuffer(fixture.source, fixture.recipe);
  assert.equal(clean.state, "clean");
  assert.deepEqual(clean.targets[0].edit.anchorPositions, [19]);
  assert.equal(clean.targets[0].edit.sha256, fixture.recipe.targets[0].edit.sourceSha256);

  const result = patchAsarBuffer(fixture.source, fixture.recipe);
  assert.equal(result.changed, true);
  assert.deepEqual(result.buffer, fixture.patched);
  assert.equal(result.after.state, "patched");
  assert.equal(result.after.targets[0].edit.sha256, fixture.recipe.targets[0].edit.patchedSha256);
  assert.equal(result.buffer.toString().includes(CCDX_PM_STUDIO_ORIGIN), false);
  assert.equal(result.buffer.toString().split(PM_STUDIO_ORIGIN).length - 1, 2);

  const repeated = patchAsarBuffer(result.buffer, fixture.recipe);
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.buffer, fixture.patched);

  const predecessor = inspectAsarBuffer(fixture.predecessor, fixture.recipe);
  assert.equal(predecessor.state, "predecessor");
  assert.equal(predecessor.predecessorIssues.length, 0);
  assert.throws(() => patchAsarBuffer(fixture.predecessor, fixture.recipe), {
    code: "PM_STUDIO_ASAR_PREDECESSOR",
  });

  const legacy = inspectAsarBuffer(fixture.legacy, fixture.recipe);
  assert.equal(legacy.state, "legacy");
  assert.throws(() => patchAsarBuffer(fixture.legacy, fixture.recipe), { code: "PM_STUDIO_ASAR_LEGACY" });

  const drift = Buffer.from(fixture.source);
  drift[drift.length - 1] ^= 1;
  assert.equal(inspectAsarBuffer(drift, fixture.recipe).state, "drift");
  assert.throws(() => patchAsarBuffer(drift, fixture.recipe), { code: "PM_STUDIO_ASAR_DRIFT" });
});

test("file-backed ASAR inspection exactly matches Buffer classification and diagnostics", () => {
  const root = temporaryRoot("ccdx-asar-inspection-parity-");
  const fixture = makeAsarFixture();
  const filePath = path.join(root, "app.asar");
  const drift = Buffer.from(fixture.source);
  drift[drift.length - 1] ^= 1;
  for (const value of [fixture.source, fixture.patched, fixture.predecessor, fixture.legacy, drift]) {
    fs.writeFileSync(filePath, value);
    assert.deepEqual(inspectAsarFile(filePath, fixture.recipe), inspectAsarBuffer(value, fixture.recipe));
  }
});

test("ASAR parser rejects malformed pickle metadata and non-zero header padding", () => {
  const fixture = makeAsarFixture();
  for (const mutate of [
    (buffer) => buffer.writeUInt32LE(5, 0),
    (buffer) => buffer.writeUInt32LE(buffer.readUInt32LE(4) - 8, 8),
  ]) {
    const malformed = Buffer.from(fixture.source);
    mutate(malformed);
    assert.throws(() => inspectAsarBuffer(malformed, fixture.recipe), /malformed pickle sizes/);
  }
  const badPadding = Buffer.from(fixture.source);
  const headerEnd = 16 + badPadding.readUInt32LE(12);
  const dataOffset = 8 + badPadding.readUInt32LE(4);
  assert.ok(dataOffset > headerEnd);
  badPadding[headerEnd] = 1;
  assert.throws(() => inspectAsarBuffer(badPadding, fixture.recipe), /padding is not zeroed/);
  assert.deepEqual(blockSha256(Buffer.alloc(0), 4096), [sha256Hex(Buffer.alloc(0))]);
});

function splitOriginRuntime(fetchImpl) {
  const context = vm.createContext({
    AbortController,
    AbortSignal,
    Date,
    Headers,
    Math,
    Request,
    Response,
    clearTimeout,
    fetch: fetchImpl,
    setTimeout,
  });
  const factory = vm.runInContext(`({${PM_STUDIO_SPLIT_ORIGIN_CONFIG_MODULE}})[47024]`, context);
  const exports = {};
  factory({}, exports, {
    d(target, definitions) {
      for (const [name, getter] of Object.entries(definitions)) {
        Object.defineProperty(target, name, { enumerable: true, get: getter });
      }
    },
  });
  return { config: exports.qn, fetch: context.fetch };
}

function jsonResponse(value, { marker = false, status = 200 } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(marker ? { "X-CCDX-PM-Relay": PM_STUDIO_SPLIT_ORIGIN_MARKER } : {}),
    },
  });
}

test("split-origin runtime keeps GPT and utility calls native while routing exact Claude chat IDs locally", async () => {
  const calls = [];
  const pmAuthorization = "Bearer pm-placeholder";
  const runtime = splitOriginRuntime(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const authorization = new Headers(init.headers).get("Authorization");
    calls.push({ url, method: init.method, body: init.body, authorization });
    if (url === `${CCDX_PM_STUDIO_ORIGIN}/models`) {
      if (!authorization) return jsonResponse({ error: {} }, { marker: true, status: 401 });
      return jsonResponse({ data: [
        { id: "gpt-native", vendor: "OpenAI" },
        { id: "anthropic-special", vendor: "Anthropic" },
      ] }, { marker: true });
    }
    if (url === `${CCDX_PM_STUDIO_ORIGIN}/chat/completions`) {
      return jsonResponse({ url }, { marker: true });
    }
    return jsonResponse({ url });
  });

  assert.equal(runtime.config.API_ENDPOINT, PM_STUDIO_ORIGIN);
  const models = await runtime.fetch(`${PM_STUDIO_ORIGIN}/models`, {
    method: "GET",
    headers: { Authorization: pmAuthorization },
  });
  assert.equal(models.headers.get("X-CCDX-PM-Relay"), PM_STUDIO_SPLIT_ORIGIN_MARKER);

  for (const [pathName, model] of [
    ["/chat/completions", "gpt-native"],
    ["/responses", "gpt-native"],
    ["/embeddings", "gpt-native"],
  ]) {
    await runtime.fetch(`${PM_STUDIO_ORIGIN}${pathName}`, {
      method: "POST",
      body: JSON.stringify({ model }),
    });
  }
  await runtime.fetch(runtime.config.COPILOT_TOKEN_URL, { method: "GET" });
  await runtime.fetch(`${PM_STUDIO_ORIGIN}/chat/completions`, {
    method: "POST",
    headers: { Authorization: pmAuthorization },
    body: JSON.stringify({ model: "claude-prefix" }),
  });
  await runtime.fetch(`${PM_STUDIO_ORIGIN}/chat/completions`, {
    method: "POST",
    headers: { Authorization: pmAuthorization },
    body: JSON.stringify({ model: "anthropic-special" }),
  });
  const request = new Request(`${PM_STUDIO_ORIGIN}/chat/completions`, {
    method: "POST",
    headers: { Authorization: pmAuthorization },
    body: JSON.stringify({ model: "claude-request-shape" }),
  });
  await runtime.fetch(request, {
    method: request.method,
    body: await request.clone().text(),
    headers: request.headers,
    signal: request.signal,
  });
  const callCount = calls.length;
  const rejectedEndpoint = await runtime.fetch(`${PM_STUDIO_ORIGIN}/responses`, {
    method: "POST",
    body: JSON.stringify({ model: "claude-prefix" }),
  });
  assert.equal(rejectedEndpoint.status, 400);
  assert.equal((await rejectedEndpoint.json()).error.code, "model_not_supported");
  assert.equal(calls.length, callCount, "Claude /responses must not reach either inference origin");

  assert.deepEqual(calls.map(({ url }) => url), [
    `${CCDX_PM_STUDIO_ORIGIN}/models`,
    `${PM_STUDIO_ORIGIN}/chat/completions`,
    `${PM_STUDIO_ORIGIN}/responses`,
    `${PM_STUDIO_ORIGIN}/embeddings`,
    runtime.config.COPILOT_TOKEN_URL,
    `${CCDX_PM_STUDIO_ORIGIN}/models`,
    `${CCDX_PM_STUDIO_ORIGIN}/chat/completions`,
    `${CCDX_PM_STUDIO_ORIGIN}/models`,
    `${CCDX_PM_STUDIO_ORIGIN}/chat/completions`,
    `${CCDX_PM_STUDIO_ORIGIN}/models`,
    `${CCDX_PM_STUDIO_ORIGIN}/chat/completions`,
  ]);
  const localModelCalls = calls.filter(({ url }) => url === `${CCDX_PM_STUDIO_ORIGIN}/models`);
  assert.equal(localModelCalls[0].authorization, pmAuthorization);
  assert.equal(localModelCalls.slice(1).every(({ authorization, body }) => !authorization && body === undefined), true);
});

test("split-origin models accepts marked object/array catalogs only and otherwise falls back native", async (t) => {
  for (const item of [
    { name: "missing marker", local: () => jsonResponse({ data: [] }) },
    { name: "non-ok marker", local: () => jsonResponse({ error: {} }, { marker: true, status: 503 }) },
    {
      name: "malformed marker body",
      local: () => new Response("{", { headers: { "X-CCDX-PM-Relay": PM_STUDIO_SPLIT_ORIGIN_MARKER } }),
    },
    { name: "invalid marker shape", local: () => jsonResponse({ data: {} }, { marker: true }) },
    { name: "network failure", local: () => { throw new Error("local unavailable"); } },
  ]) {
    await t.test(item.name, async () => {
      const calls = [];
      const runtime = splitOriginRuntime(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        calls.push(url);
        if (url === `${CCDX_PM_STUDIO_ORIGIN}/models`) return item.local();
        return jsonResponse({ data: [{ id: "gpt-native" }] });
      });
      const response = await runtime.fetch(`${PM_STUDIO_ORIGIN}/models`, { method: "GET" });
      assert.deepEqual(await response.json(), { data: [{ id: "gpt-native" }] });
      assert.deepEqual(calls, [`${CCDX_PM_STUDIO_ORIGIN}/models`, `${PM_STUDIO_ORIGIN}/models`]);
    });
  }

  await t.test("array catalog learns exact Anthropic IDs", async () => {
    const calls = [];
    const runtime = splitOriginRuntime(async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url;
      const authorization = new Headers(init.headers).get("Authorization");
      calls.push({ url, authorization });
      if (url === `${CCDX_PM_STUDIO_ORIGIN}/models` && !authorization) {
        return jsonResponse({ error: {} }, { marker: true, status: 401 });
      }
      if (url.endsWith("/models")) {
        return jsonResponse([{ id: "anthropic-array-id", owned_by: "Anthropic" }], { marker: true });
      }
      return jsonResponse({ ok: true }, { marker: true });
    });
    await runtime.fetch(`${PM_STUDIO_ORIGIN}/models`, {
      method: "GET",
      headers: { Authorization: "Bearer pm-placeholder" },
    });
    await runtime.fetch(`${PM_STUDIO_ORIGIN}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "anthropic-array-id" }),
    });
    assert.deepEqual(calls, [
      { url: `${CCDX_PM_STUDIO_ORIGIN}/models`, authorization: "Bearer pm-placeholder" },
      { url: `${CCDX_PM_STUDIO_ORIGIN}/models`, authorization: null },
      { url: `${CCDX_PM_STUDIO_ORIGIN}/chat/completions`, authorization: null },
    ]);
  });
});

test("split-origin Claude chat requires a credential-free compatible probe and a marked response", async (t) => {
  await t.test("incompatible probe fails before sending the prompt or bearer", async () => {
    const calls = [];
    const runtime = splitOriginRuntime(async (input, init = {}) => {
      calls.push({
        url: typeof input === "string" ? input : input.url,
        authorization: new Headers(init.headers).get("Authorization"),
        body: init.body,
      });
      return jsonResponse({ data: [] });
    });
    const response = await runtime.fetch(`${PM_STUDIO_ORIGIN}/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer pm-placeholder" },
      body: JSON.stringify({ model: " claude-prefix ", messages: [{ role: "user", content: "private" }] }),
    });

    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "relay_incompatible");
    assert.deepEqual(calls, [{
      url: `${CCDX_PM_STUDIO_ORIGIN}/models`,
      authorization: null,
      body: undefined,
    }]);
  });

  await t.test("unmarked chat response is rejected without enterprise fallback", async () => {
    const calls = [];
    const runtime = splitOriginRuntime(async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({ url, authorization: new Headers(init.headers).get("Authorization") });
      if (url === `${CCDX_PM_STUDIO_ORIGIN}/models`) {
        return jsonResponse({ error: {} }, { marker: true, status: 401 });
      }
      return jsonResponse({ source: "incompatible-local" });
    });
    const response = await runtime.fetch(`${PM_STUDIO_ORIGIN}/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer pm-placeholder" },
      body: JSON.stringify({ model: "claude-prefix", messages: [] }),
    });

    assert.equal(response.status, 503);
    assert.deepEqual(calls, [
      { url: `${CCDX_PM_STUDIO_ORIGIN}/models`, authorization: null },
      { url: `${CCDX_PM_STUDIO_ORIGIN}/chat/completions`, authorization: "Bearer pm-placeholder" },
    ]);
  });

  await t.test("compatibility probe has a bounded timeout", async () => {
    let probeAborted = false;
    const runtime = splitOriginRuntime(async (_input, init = {}) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        probeAborted = true;
        reject(init.signal.reason);
      }, { once: true });
    }));
    const keepAlive = setTimeout(() => {}, 1_000);
    try {
      const response = await runtime.fetch(`${PM_STUDIO_ORIGIN}/chat/completions`, {
        method: "POST",
        headers: { Authorization: "Bearer pm-placeholder" },
        body: JSON.stringify({ model: "claude-prefix", messages: [] }),
      });

      assert.equal(response.status, 503);
      assert.equal(probeAborted, true);
    } finally {
      clearTimeout(keepAlive);
    }
  });

  await t.test("caller abort during the compatibility probe propagates its exact reason", async () => {
    const calls = [];
    const runtime = splitOriginRuntime(async (input, init = {}) => {
      calls.push({
        url: typeof input === "string" ? input : input.url,
        authorization: new Headers(init.headers).get("Authorization"),
        body: init.body,
      });
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    });
    const controller = new AbortController();
    const reason = new Error("user cancelled Claude compatibility probe");
    const request = runtime.fetch(`${PM_STUDIO_ORIGIN}/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer pm-placeholder" },
      body: JSON.stringify({ model: "claude-prefix", messages: [{ role: "user", content: "private" }] }),
      signal: controller.signal,
    });
    controller.abort(reason);

    await assert.rejects(request, (error) => error === reason);
    assert.deepEqual(calls, [{
      url: `${CCDX_PM_STUDIO_ORIGIN}/models`,
      authorization: null,
      body: undefined,
    }]);
  });
});

test("split-origin accepts a marked delayed model catalog without native fallback", async () => {
  const calls = [];
  const caller = new AbortController();
  const runtime = splitOriginRuntime(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, signal: init.signal });
    if (url === `${CCDX_PM_STUDIO_ORIGIN}/models`) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(jsonResponse({
          data: [{ id: "claude-delayed", vendor: "Anthropic" }],
        }, { marker: true })), 825);
        init.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal.reason);
        }, { once: true });
      });
    }
    return jsonResponse({ data: [{ id: "gpt-native" }] });
  });

  const response = await runtime.fetch(`${PM_STUDIO_ORIGIN}/models`, {
    method: "GET",
    headers: { Authorization: "Bearer pm-placeholder" },
    signal: caller.signal,
  });

  assert.equal(response.headers.get("X-CCDX-PM-Relay"), PM_STUDIO_SPLIT_ORIGIN_MARKER);
  assert.deepEqual(await response.json(), {
    data: [{ id: "claude-delayed", vendor: "Anthropic" }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${CCDX_PM_STUDIO_ORIGIN}/models`);
  assert.strictEqual(calls[0].signal, caller.signal);
});

test("split-origin models preserves a user abort without native fallback", async () => {
  const abortCalls = [];
  const abortRuntime = splitOriginRuntime(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    abortCalls.push({ url, signal: init.signal });
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const reason = new Error("user cancelled");
  const request = abortRuntime.fetch(`${PM_STUDIO_ORIGIN}/models`, {
    method: "GET",
    signal: controller.signal,
  });
  controller.abort(reason);
  await assert.rejects(request, (error) => error === reason);
  assert.deepEqual(abortCalls, [{
    url: `${CCDX_PM_STUDIO_ORIGIN}/models`,
    signal: controller.signal,
  }]);
});

test("bundle content fingerprints files, modes, symlinks, empty directories, and stable xattrs", () => {
  const first = temporaryRoot("ccdx-pms-tree-a-");
  const second = temporaryRoot("ccdx-pms-tree-b-");
  for (const root of [first, second]) {
    fs.chmodSync(root, 0o755);
    fs.mkdirSync(path.join(root, "empty"));
  }
  fs.writeFileSync(path.join(first, "a.txt"), "alpha");
  fs.writeFileSync(path.join(first, "b.txt"), "beta");
  fs.symlinkSync("a.txt", path.join(first, "current"));
  fs.writeFileSync(path.join(second, "b.txt"), "beta");
  fs.symlinkSync("a.txt", path.join(second, "current"));
  fs.writeFileSync(path.join(second, "a.txt"), "alpha");

  const baseline = inspectBundleContent(first);
  assert.deepEqual(inspectBundleContent(second), baseline);

  fs.chmodSync(second, 0o700);
  assert.notEqual(inspectBundleContent(second).sha256, baseline.sha256);
  fs.chmodSync(second, 0o755);
  fs.writeFileSync(path.join(second, "a.txt"), "changed");
  assert.notEqual(inspectBundleContent(second).sha256, baseline.sha256);
  fs.writeFileSync(path.join(second, "a.txt"), "alpha");
  fs.unlinkSync(path.join(second, "current"));
  fs.symlinkSync("b.txt", path.join(second, "current"));
  assert.notEqual(inspectBundleContent(second).sha256, baseline.sha256);
  fs.unlinkSync(path.join(second, "current"));
  fs.symlinkSync("a.txt", path.join(second, "current"));
  fs.mkdirSync(path.join(second, "another-empty"));
  assert.notEqual(inspectBundleContent(second).sha256, baseline.sha256);

  const stableXattr = inspectBundleContent(first, {
    xattrOutput: `${path.join(first, "a.txt")}: com.apple.cs.CodeDirectory:\n00000000  01 02  |..|\n00000002\n`,
  });
  assert.equal(stableXattr.xattrCount, 1);
  assert.notEqual(stableXattr.sha256, baseline.sha256);
  const volatileXattr = inspectBundleContent(first, {
    xattrOutput: `${path.join(first, "a.txt")}: com.apple.quarantine:\n00000000  01 02  |..|\n00000002\n`,
    ignoredXattrs: ["com.apple.quarantine"],
  });
  assert.deepEqual(volatileXattr, baseline);
});

test("embedded Electron ASAR integrity slot inspection fails closed for active, malformed, or multiple slots", () => {
  const sentinel = Buffer.from(ELECTRON_ASAR_INTEGRITY_SENTINEL);
  assert.equal(inspectElectronAsarIntegritySlots(Buffer.from("ordinary Mach-O bytes")).state, "absent");

  const inactive = Buffer.alloc(80);
  sentinel.copy(inactive, 4);
  assert.deepEqual(inspectElectronAsarIntegritySlots(inactive).state, "inactive");
  assert.equal(inspectElectronAsarIntegritySlots(inactive).supported, true);

  const active = Buffer.from(inactive);
  active[36] = 1;
  active[37] = 1;
  assert.equal(inspectElectronAsarIntegritySlots(active).state, "active");
  assert.equal(inspectElectronAsarIntegritySlots(active).supported, false);

  const multiple = Buffer.alloc(150);
  sentinel.copy(multiple, 0);
  sentinel.copy(multiple, 70);
  assert.equal(inspectElectronAsarIntegritySlots(multiple).state, "drift");
  assert.equal(inspectElectronAsarIntegritySlots(multiple).supported, false);

  const truncated = Buffer.alloc(40);
  sentinel.copy(truncated, 8);
  assert.equal(inspectElectronAsarIntegritySlots(truncated).state, "drift");
});

test("file-backed Electron integrity inspection matches Buffer parsing across chunk boundaries", (t) => {
  const root = temporaryRoot("ccdx-electron-file-");
  const filePath = path.join(root, "Electron Framework");
  const sentinel = Buffer.from(ELECTRON_ASAR_INTEGRITY_SENTINEL);
  const slot = Buffer.concat([sentinel, Buffer.from([1, 1]), Buffer.alloc(32, 7)]);
  const values = [
    Buffer.from("ordinary Mach-O bytes"),
    Buffer.concat([Buffer.alloc(63, 1), slot, Buffer.alloc(9, 2), slot]),
    Buffer.concat([Buffer.alloc(65, 3), sentinel, Buffer.from([1])]),
  ];
  for (const value of values) {
    fs.writeFileSync(filePath, value);
    const actual = inspectElectronAsarIntegrityFile(filePath, { chunkSize: 66 });
    assert.equal(actual.sha256, sha256Hex(value));
    assert.deepEqual(actual.integrity, inspectElectronAsarIntegritySlots(value));
  }
});

test("file-backed inspectors reject a file identity change during reading", () => {
  const root = temporaryRoot("ccdx-file-change-");
  const fixture = makeAsarFixture();
  const filePath = path.join(root, "app.asar");
  fs.writeFileSync(filePath, fixture.source);
  let fstatCalls = 0;
  const io = {
    ...fs,
    constants: fs.constants,
    fstatSync(file, options) {
      const stat = fs.fstatSync(file, options);
      fstatCalls += 1;
      return fstatCalls > 1 ? { ...stat, ctimeNs: stat.ctimeNs + 1n } : stat;
    },
  };
  assert.throws(() => inspectAsarFile(filePath, fixture.recipe, { io }), /changed while reading/);
});

test("file-backed ASAR inspection rejects oversized declared header and target before allocation", () => {
  const root = temporaryRoot("ccdx-file-bounds-");
  const filePath = path.join(root, "app.asar");
  const fixture = makeAsarFixture();
  const oversizedHeader = Buffer.alloc(16);
  oversizedHeader.writeUInt32LE(4, 0);
  oversizedHeader.writeUInt32LE((64 * 1024 * 1024) + 4, 4);
  fs.writeFileSync(filePath, oversizedHeader);
  assert.throws(() => inspectAsarFile(filePath, fixture.recipe), /header exceeds the safe inspection limit/);

  const header = { files: {} };
  addHeaderEntry(header, "dist/main/main.js", {
    size: (128 * 1024 * 1024) + 1,
    offset: "0",
    integrity: { algorithm: "SHA256", hash: "", blockSize: 16, blocks: [] },
  });
  const oversizedTarget = buildArchive(header, []);
  fs.writeFileSync(filePath, oversizedTarget.archive);
  fs.truncateSync(filePath, oversizedTarget.dataOffset + (128 * 1024 * 1024) + 1);
  assert.throws(() => inspectAsarFile(filePath, fixture.recipe), /main\.js exceeds the safe inspection limit/);
});

test("file-backed evidence cache revalidates path and descriptor identity on every hit", () => {
  const root = temporaryRoot("ccdx-file-cache-race-");
  const fixture = makeAsarFixture();
  const filePath = path.join(root, "app.asar");
  const replacementPath = path.join(root, "replacement.asar");
  const cache = new Map();
  fs.writeFileSync(filePath, fixture.source);
  fs.writeFileSync(replacementPath, fixture.patched);
  inspectAsarFile(filePath, fixture.recipe, { cache });
  let firstStat = true;
  const io = {
    ...fs,
    constants: fs.constants,
    statSync(target, options) {
      if (firstStat) {
        firstStat = false;
        const stale = fs.statSync(target, options);
        fs.renameSync(replacementPath, filePath);
        return stale;
      }
      return fs.statSync(target, options);
    },
  };
  assert.throws(() => inspectAsarFile(filePath, fixture.recipe, { cache, io }), /changed before it could be read/);

  const electronPath = path.join(root, "Electron Framework");
  const electronCache = new Map();
  fs.writeFileSync(electronPath, "first executable bytes");
  inspectElectronAsarIntegrityFile(electronPath, { cache: electronCache });
  const stale = fs.statSync(electronPath, { bigint: true });
  let electronStat = true;
  const electronIo = {
    ...fs,
    constants: fs.constants,
    statSync(target, options) {
      if (electronStat) {
        electronStat = false;
        fs.writeFileSync(electronPath, "other executable bytes");
        return stale;
      }
      return fs.statSync(target, options);
    },
  };
  assert.throws(() => inspectElectronAsarIntegrityFile(electronPath, {
    cache: electronCache,
    io: electronIo,
  }), /changed before it could be read/);
});

test("file-backed cache misses same-path rewrites and inode replacements", () => {
  const root = temporaryRoot("ccdx-file-cache-miss-");
  const fixture = makeAsarFixture();
  const filePath = path.join(root, "app.asar");
  const nextPath = path.join(root, "next.asar");
  const cache = new Map();
  fs.writeFileSync(filePath, fixture.source);
  const clean = inspectAsarFile(filePath, fixture.recipe, { cache });
  const drift = Buffer.from(fixture.source);
  drift[drift.length - 1] ^= 1;
  fs.writeFileSync(filePath, drift);
  const rewritten = inspectAsarFile(filePath, fixture.recipe, { cache });
  assert.notEqual(rewritten.asarSha256, clean.asarSha256);
  fs.writeFileSync(nextPath, fixture.source);
  fs.renameSync(nextPath, filePath);
  assert.deepEqual(inspectAsarFile(filePath, fixture.recipe, { cache }), clean);
});

test("file-backed cache rejects changes while repopulating released target bytes", () => {
  const root = temporaryRoot("ccdx-file-populate-race-");
  const fixture = makeAsarFixture();
  const filePath = path.join(root, "app.asar");
  const cache = new Map();
  fs.writeFileSync(filePath, fixture.source);
  inspectAsarFile(filePath, fixture.recipe, { cache, releaseTargets: true });
  let changed = false;
  const io = {
    ...fs,
    constants: fs.constants,
    readSync(file, buffer, offset, length, position) {
      const read = fs.readSync(file, buffer, offset, length, position);
      if (!changed && position >= fixture.recipe.dataOffset) {
        changed = true;
        const bytes = fs.readFileSync(filePath);
        bytes[bytes.length - 1] ^= 1;
        fs.writeFileSync(filePath, bytes);
      }
      return read;
    },
  };
  assert.throws(() => inspectAsarFile(filePath, fixture.recipe, {
    cache,
    io,
    releaseTargets: true,
  }), /changed while reading/);
});

test("streaming executable inspection stays below a bounded child-process RSS guard", () => {
  const root = temporaryRoot("ccdx-file-rss-");
  const filePath = path.join(root, "Electron Framework");
  fs.writeFileSync(filePath, "");
  fs.truncateSync(filePath, 128 * 1024 * 1024);
  const moduleUrl = new URL("../src/pm-studio-asar.mjs", import.meta.url).href;
  const script = `const { inspectElectronAsarIntegrityFile } = await import(${JSON.stringify(moduleUrl)}); inspectElectronAsarIntegrityFile(process.argv[1]); console.log(process.resourceUsage().maxRSS);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, filePath], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const rawMaxRss = Number(child.stdout.trim());
  const maxRssBytes = rawMaxRss > 1024 * 1024 ? rawMaxRss : rawMaxRss * 1024;
  assert.ok(maxRssBytes < 96 * 1024 * 1024, `maxRSS was ${maxRssBytes} bytes`);
});

test("default codesign preserves available runtime metadata without assuming a source signature", () => {
  const calls = [];
  const operations = createPmStudioSetupOperations({
    processRunner: (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  operations.signApp({
    appPath: "/tmp/Fixture.app",
    source: {
      codeSign: {
        displayValid: true,
        entitlementsState: "xml",
        flags: "0x10000(runtime)",
        runtimeVersion: "26.0.0",
      },
    },
    processRunner: operations.processRunner,
  });
  operations.signApp({
    appPath: "/tmp/Unsigned.app",
    source: { codeSign: { displayValid: false, entitlementsState: "unavailable" } },
    processRunner: operations.processRunner,
  });
  operations.signApp({
    appPath: "/tmp/Invalid.app",
    source: {
      codeSign: {
        displayValid: true,
        entitlementsState: "invalid",
        flags: "0x10000(runtime)",
        runtimeVersion: "26.0.0",
      },
    },
    processRunner: operations.processRunner,
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].command, "/usr/bin/codesign");
  assert.ok(calls[0].args.includes("--preserve-metadata=entitlements,flags,runtime"));
  assert.equal(calls[0].args.some((arg) => arg.includes("identifier")), false);
  assert.ok(calls[0].args.includes("--timestamp=none"));
  assert.equal(calls[1].args.some((arg) => arg.startsWith("--preserve-metadata=")), false);
  assert.ok(calls[2].args.includes("--preserve-metadata=flags,runtime"));
});

test("default bundle inspection reads symlink xattrs without following their targets", () => {
  const root = temporaryRoot("ccdx-pms-xattr-");
  const calls = [];
  const operations = createPmStudioSetupOperations({
    processRunner: (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  operations.inspectBundleContent({
    appPath: root,
    recipe: { sourceBundleContent: { ignoredXattrs: [] } },
    processRunner: operations.processRunner,
  });
  assert.deepEqual(calls, [{
    command: "/usr/bin/xattr",
    args: ["-r", "-s", "-x", "-l", root],
  }]);
});

test("codesign inspection exports XML entitlements without making them a validity prerequisite", () => {
  const calls = [];
  const operations = createPmStudioSetupOperations({
    processRunner: (command, args) => {
      calls.push({ command, args });
      if (args.includes("--verify")) return { status: 1, stdout: "", stderr: "invalid signature" };
      if (args.includes("--verbose=4")) {
        return {
          status: 0,
          stdout: "",
          stderr: [
            "Identifier=com.pm-studio.app",
            "TeamIdentifier=HL75GKK4W4",
            "flags=0x10000(runtime)",
            "Runtime Version=26.0.0",
            `CandidateCDHashFull sha256=${"a".repeat(64)}`,
            "Notarization Ticket=stapled",
          ].join("\n"),
        };
      }
      return { status: 0, stdout: "", stderr: "warning: binary contains an invalid entitlements blob\n" };
    },
  });
  const inspected = operations.inspectCodeSign({
    appPath: "/tmp/Fixture.app",
    processRunner: operations.processRunner,
  });
  assert.equal(inspected.valid, false);
  assert.equal(inspected.verifyValid, false);
  assert.equal(inspected.displayValid, true);
  assert.equal(inspected.entitlementsState, "invalid");
  assert.equal(inspected.identifier, "com.pm-studio.app");
  assert.equal(inspected.teamIdentifier, "HL75GKK4W4");
  assert.equal(inspected.flags, "0x10000(runtime)");
  assert.equal(inspected.runtimeVersion, "26.0.0");
  assert.equal(inspected.cdHashFull, "a".repeat(64));
  assert.equal(inspected.notarizationTicket, "stapled");
  const entitlementCall = calls.find(({ args }) => args.includes("--entitlements"));
  assert.deepEqual(entitlementCall.args.slice(0, 5), ["--display", "--entitlements", "-", "--xml", "/tmp/Fixture.app"]);

  const unsignedEntitlements = createPmStudioSetupOperations({
    processRunner: (_command, args) => {
      if (args.includes("--entitlements")) return { status: 1, stdout: "", stderr: "code has no entitlements" };
      return args.includes("--verbose=4")
        ? { status: 0, stdout: "", stderr: "Identifier=com.example.fixture\nSignature=adhoc\nTeamIdentifier=not set\n" }
        : { status: 0, stdout: "", stderr: "" };
    },
  });
  const unsignedInspection = unsignedEntitlements.inspectCodeSign({
    appPath: "/tmp/Fixture.app",
    processRunner: unsignedEntitlements.processRunner,
  });
  assert.equal(unsignedInspection.valid, true);
  assert.equal(unsignedInspection.adHoc, true);
  assert.equal(unsignedInspection.entitlementsState, "unavailable");
});

test("process preflight matches PM Studio paths and identifiers without blocking unrelated ShipIt updaters", () => {
  const operations = createPmStudioSetupOperations({
    processRunner: () => ({
      status: 0,
      stdout: [
        "101 /Applications/Other.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt",
        "202 /Applications/PM Studio.app/Contents/MacOS/PM Studio",
        "303 /Users/test/Library/Caches/com.pm-studio.app.ShipIt/ShipIt",
      ].join("\n"),
      stderr: "",
    }),
  });
  assert.equal(operations.listBlockingProcesses({ processRunner: operations.processRunner }).length, 2);
});

test("setup installs from a verified fixture, keeps a complete secret-free backup, and is idempotent", async () => {
  const root = temporaryRoot("ccdx-pms-setup-");
  const fixture = makeAsarFixture();
  const appPath = createAppFixture(root, fixture);
  const backupRoot = path.join(root, "backups");
  const signCounter = { value: 0 };
  const operations = fixtureOperations({ signCounter });
  const messages = [];

  const installed = await runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [fixture.recipe],
    operations,
    logger: (line) => messages.push(line),
  });
  assert.equal(installed.status, "patched");
  assert.equal(installed.replacementMode, "foundation-atomic-replace");
  assert.equal(signCounter.value, 1);
  assert.deepEqual(fs.readFileSync(path.join(appPath, fixture.recipe.asarPath)), fixture.patched);
  assert.equal(JSON.parse(fs.readFileSync(path.join(appPath, fixture.recipe.infoPlistPath))).integrity.hash,
    fixture.recipe.patchedHeaderSha256);
  assert.equal(fs.readFileSync(path.join(appPath, "Contents/.fixture-signature"), "utf8"), "adhoc");
  assert.deepEqual(fs.readFileSync(path.join(installed.backup.backupAppPath, fixture.recipe.asarPath)), fixture.source);

  const manifest = fs.readFileSync(installed.backup.manifestPath, "utf8");
  assert.doesNotMatch(manifest, /SECRET_TOKEN|personal|github_token|Authorization/i);
  assert.match(manifest, new RegExp(fixture.recipe.sourceAsarSha256));
  assert.deepEqual(JSON.parse(manifest).patched.binaries, {
    main_executable_sha256: "fixture-main-source",
    electron_framework_sha256: "fixture-framework-source",
  });
  assert.match(messages.join("\n"), /Foundation's atomic item replacement/);
  assert.match(messages.join("\n"), /quit PM Studio and its updater, then run ccdx pms restore/);
  assert.match(messages.join("\n"), /exact source-content verification; the original source signature is inspected and reported but is not an admission gate/);
  assert.doesNotMatch(messages.join("\n"), /Restore step|move .* aside|verify its signature before launch/);
  assert.match(messages.join("\n"), /Start ccdx before using Claude in PM Studio; GPT remains/);

  const backupEntries = fs.readdirSync(backupRoot);
  const repeated = await runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [fixture.recipe],
    operations,
    logger: () => {},
  });
  assert.equal(repeated.status, "already_patched");
  assert.equal(repeated.changed, false);
  assert.equal(signCounter.value, 1);
  assert.deepEqual(fs.readdirSync(backupRoot), backupEntries);

  operations.inspectExecutableIntegrity = ({ appPath: inspectedPath }) => ({
    executableName: "PM Studio",
    executableSha256: inspectedPath === appPath ? "unknown-main-drift" : "fixture-main-source",
    frameworkSha256: "fixture-framework-source",
    embeddedIntegrity: { state: "absent", supported: true, executable: { slots: [] }, framework: { slots: [] } },
    matchesRecipeName: true,
  });
  await assert.rejects(runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [fixture.recipe],
    operations,
    logger: () => {},
  }), { code: "PM_STUDIO_BUNDLE_DRIFT" });
  assert.equal(signCounter.value, 1);
});

test("restore installs the exact verified clean backup, retains recovery data, and is idempotent", async () => {
  const root = temporaryRoot("ccdx-pms-restore-");
  const fixture = makeAsarFixture();
  const appPath = createAppFixture(root, fixture);
  const cleanSnapshot = sourceSnapshot(appPath);
  const backupRoot = path.join(root, "backups");
  const signCounter = { value: 0 };
  const operations = fixtureOperations({ signCounter });
  const installed = await runPmStudioSetup({
    appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
  });
  const backupSnapshot = sourceSnapshot(installed.backup.backupAppPath);
  const manifestSnapshot = fs.readFileSync(installed.backup.manifestPath);
  operations.readClaudeCredentials = () => assert.fail("restore must not read the Claude profile");

  const messages = [];
  const restored = await runPmStudioRestore({
    appPath,
    home: root,
    backupRoot,
    recipes: [fixture.recipe],
    operations,
    logger: (line) => messages.push(line),
  });
  assert.equal(restored.status, "restored");
  assert.equal(restored.changed, true);
  assert.equal(restored.replacementMode, "foundation-atomic-replace");
  assertSnapshot(appPath, cleanSnapshot);
  assertSnapshot(installed.backup.backupAppPath, backupSnapshot);
  assert.deepEqual(fs.readFileSync(installed.backup.manifestPath), manifestSnapshot);
  assert.equal(signCounter.value, 1, "restore must not re-sign the clean source bundle");
  assert.match(messages.join("\n"), /exact verified clean backup/);
  assert.equal(fs.readdirSync(root).some((name) => name.includes("ccdx-restore-stage")), false);

  fs.rmSync(backupRoot, { recursive: true, force: true });
  const repeated = await runPmStudioRestore({
    appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
  });
  assert.equal(repeated.status, "already_clean");
  assert.equal(repeated.changed, false);
  assertSnapshot(appPath, cleanSnapshot);
});

test("restore preserves an invalid original signature while enforcing exact compatible source content", async () => {
  const root = temporaryRoot("ccdx-pms-restore-compatible-");
  const fixture = makeAsarFixture({ version: "2.9.12", compatible: true });
  const supportedFixture = makeAsarFixture({ version: "2.9.10" });
  const appPath = createAppFixture(root, fixture, { signature: "invalid" });
  const cleanSnapshot = sourceSnapshot(appPath);
  const backupRoot = path.join(root, "backups");
  const operations = fixtureOperations();
  const installed = await runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [supportedFixture.recipe],
    operations,
    logger: () => {},
  });
  assert.equal(JSON.parse(fs.readFileSync(installed.backup.manifestPath, "utf8")).schema_version, 2);
  const messages = [];

  const restored = await runPmStudioRestore({
    appPath,
    home: root,
    backupRoot,
    recipes: [supportedFixture.recipe],
    operations,
    logger: (line) => messages.push(line),
  });
  assert.equal(restored.status, "restored");
  assert.equal(restored.inspection.codeSign.valid, false);
  assertSnapshot(appPath, cleanSnapshot);
  assert.match(messages.join("\n"), /original signature does not currently verify/);
});

test("restore rejects patch-record or backup changes before atomic replacement", async (t) => {
  await t.test("installed patch record drift", async () => {
    const root = temporaryRoot("ccdx-pms-restore-record-");
    const fixture = makeAsarFixture();
    const appPath = createAppFixture(root, fixture);
    const backupRoot = path.join(root, "backups");
    const operations = fixtureOperations();
    const installed = await runPmStudioSetup({
      appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
    });
    const patchedSnapshot = sourceSnapshot(appPath);
    const manifest = JSON.parse(fs.readFileSync(installed.backup.manifestPath, "utf8"));
    manifest.patched.signing_metadata.flags = "drift";
    writeJson(installed.backup.manifestPath, manifest);
    let copied = false;
    operations.copyBundle = () => { copied = true; };

    await assert.rejects(runPmStudioRestore({
      appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
    }), { code: "PM_STUDIO_BUNDLE_DRIFT" });
    assert.equal(copied, false);
    assertSnapshot(appPath, patchedSnapshot);
  });

  await t.test("manifest changes during staging", async () => {
    const root = temporaryRoot("ccdx-pms-restore-manifest-race-");
    const fixture = makeAsarFixture();
    const appPath = createAppFixture(root, fixture);
    const backupRoot = path.join(root, "backups");
    const operations = fixtureOperations();
    const installed = await runPmStudioSetup({
      appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
    });
    const patchedSnapshot = sourceSnapshot(appPath);
    const copyBundle = operations.copyBundle;
    operations.copyBundle = (args) => {
      copyBundle(args);
      if (args.destination.includes("ccdx-restore-stage")) {
        const manifest = JSON.parse(fs.readFileSync(installed.backup.manifestPath, "utf8"));
        manifest.created_at = "2026-08-28T00:00:00.000Z";
        writeJson(installed.backup.manifestPath, manifest);
      }
    };

    await assert.rejects(runPmStudioRestore({
      appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
    }), { code: "PM_STUDIO_BACKUP_CHANGED" });
    assertSnapshot(appPath, patchedSnapshot);
    assert.equal(fs.readdirSync(root).some((name) => name.includes("ccdx-restore-stage")), false);
  });

  await t.test("staging copy differs from the exact backup", async () => {
    const root = temporaryRoot("ccdx-pms-restore-stage-drift-");
    const fixture = makeAsarFixture();
    const appPath = createAppFixture(root, fixture);
    const backupRoot = path.join(root, "backups");
    const operations = fixtureOperations();
    await runPmStudioSetup({
      appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
    });
    const patchedSnapshot = sourceSnapshot(appPath);
    const copyBundle = operations.copyBundle;
    operations.copyBundle = (args) => {
      copyBundle(args);
      if (args.destination.includes("ccdx-restore-stage")) {
        fs.writeFileSync(path.join(args.destination, "Contents/unrecorded-helper"), "drift");
      }
    };

    await assert.rejects(runPmStudioRestore({
      appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
    }), { code: "PM_STUDIO_RESTORE_STAGE_INVALID" });
    assertSnapshot(appPath, patchedSnapshot);
    assert.equal(fs.readdirSync(root).some((name) => name.includes("ccdx-restore-stage")), false);
  });

  await t.test("staging copy changed during final source verification is never installed", async () => {
    const root = temporaryRoot("ccdx-pms-restore-stage-race-");
    const fixture = makeAsarFixture();
    const appPath = createAppFixture(root, fixture);
    const backupRoot = path.join(root, "backups");
    const operations = fixtureOperations();
    await runPmStudioSetup({
      appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
    });
    const patchedSnapshot = sourceSnapshot(appPath);
    const copyBundle = operations.copyBundle;
    const inspectBundle = operations.inspectBundleContent;
    let stagePath = "";
    let replaced = false;
    operations.copyBundle = (args) => {
      copyBundle(args);
      if (args.destination.includes("ccdx-restore-stage")) stagePath = args.destination;
    };
    operations.inspectBundleContent = (args) => {
      const result = inspectBundle(args);
      if (stagePath && args.appPath === appPath) {
        fs.writeFileSync(path.join(stagePath, "Contents/late-drift"), "drift");
        stagePath = "";
      }
      return result;
    };
    operations.replaceApp = () => { replaced = true; };

    await assert.rejects(runPmStudioRestore({
      appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
    }), { code: "PM_STUDIO_RESTORE_STAGE_INVALID" });
    assert.equal(replaced, false);
    assertSnapshot(appPath, patchedSnapshot);
    assert.equal(fs.readdirSync(root).some((name) => name.includes("ccdx-restore-stage")), false);
  });

  await t.test("a process appearing after final source verification blocks replacement", async () => {
    const root = temporaryRoot("ccdx-pms-restore-process-race-");
    const fixture = makeAsarFixture();
    const appPath = createAppFixture(root, fixture);
    const backupRoot = path.join(root, "backups");
    const operations = fixtureOperations();
    await runPmStudioSetup({
      appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
    });
    const patchedSnapshot = sourceSnapshot(appPath);
    const copyBundle = operations.copyBundle;
    const inspectBundle = operations.inspectBundleContent;
    let staged = false;
    let sourceVerified = false;
    let replaced = false;
    operations.copyBundle = (args) => {
      copyBundle(args);
      if (args.destination.includes("ccdx-restore-stage")) staged = true;
    };
    operations.inspectBundleContent = (args) => {
      const result = inspectBundle(args);
      if (staged && args.appPath === appPath) sourceVerified = true;
      return result;
    };
    operations.listBlockingProcesses = () => sourceVerified
      ? ["123 PM Studio.app/Contents/MacOS/PM Studio"]
      : [];
    operations.replaceApp = () => { replaced = true; };

    await assert.rejects(runPmStudioRestore({
      appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
    }), { code: "PM_STUDIO_RUNNING" });
    assert.equal(replaced, false);
    assertSnapshot(appPath, patchedSnapshot);
    assert.equal(fs.readdirSync(root).some((name) => name.includes("ccdx-restore-stage")), false);
  });
});

test("restore accepts only independently verified atomic replacement outcomes", async (t) => {
  await t.test("replacement failure retains the exact recorded patch", async () => {
    const root = temporaryRoot("ccdx-pms-restore-replace-fail-");
    const fixture = makeAsarFixture();
    const appPath = createAppFixture(root, fixture);
    const backupRoot = path.join(root, "backups");
    const operations = fixtureOperations();
    await runPmStudioSetup({
      appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
    });
    const patchedSnapshot = sourceSnapshot(appPath);
    operations.replaceApp = () => { throw new Error("fixture restore replacement failed"); };

    await assert.rejects(runPmStudioRestore({
      appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
    }), { code: "PM_STUDIO_RESTORE_REPLACE_FAILED" });
    assertSnapshot(appPath, patchedSnapshot);
    assert.equal(fs.readdirSync(root).some((name) => name.includes("ccdx-restore-stage")), false);
  });

  await t.test("late replacement error is accepted only after exact clean verification", async () => {
    const root = temporaryRoot("ccdx-pms-restore-replace-late-");
    const fixture = makeAsarFixture();
    const appPath = createAppFixture(root, fixture);
    const cleanSnapshot = sourceSnapshot(appPath);
    const backupRoot = path.join(root, "backups");
    const operations = fixtureOperations();
    await runPmStudioSetup({
      appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
    });
    const replaceApp = operations.replaceApp;
    operations.replaceApp = (args) => {
      replaceApp(args);
      throw new Error("fixture restore replacement reported a late error");
    };
    const messages = [];

    const restored = await runPmStudioRestore({
      appPath,
      home: root,
      backupRoot,
      recipes: [fixture.recipe],
      operations,
      logger: (line) => messages.push(line),
    });
    assert.equal(restored.status, "restored");
    assertSnapshot(appPath, cleanSnapshot);
    assert.match(messages.join("\n"), /reported an error after the exact clean bundle became installed/);
  });

  await t.test("unknown replacement state retains the verified clean stage for diagnosis", async () => {
    const root = temporaryRoot("ccdx-pms-restore-replace-unknown-");
    const fixture = makeAsarFixture();
    const appPath = createAppFixture(root, fixture);
    const backupRoot = path.join(root, "backups");
    const operations = fixtureOperations();
    const installed = await runPmStudioSetup({
      appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
    });
    operations.replaceApp = ({ appPath: installedPath }) => {
      const asarPath = path.join(installedPath, fixture.recipe.asarPath);
      const bytes = fs.readFileSync(asarPath);
      bytes[bytes.length - 1] ^= 1;
      fs.writeFileSync(asarPath, bytes);
      throw new Error("fixture restore replacement state unknown");
    };
    let retainedStage = "";

    await assert.rejects(runPmStudioRestore({
      appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
    }), (error) => {
      assert.equal(error.code, "PM_STUDIO_RESTORE_INSTALL_VERIFY_FAILED");
      retainedStage = error.message.match(/Verified staging retained: (.+)\.$/)?.[1] || "";
      assert.ok(retainedStage);
      return true;
    });
    assert.equal(fs.existsSync(retainedStage), true);
    assert.equal(inspectAsarBuffer(
      fs.readFileSync(path.join(retainedStage, fixture.recipe.asarPath)),
      fixture.recipe,
    ).state, "clean");
    assert.equal(fs.existsSync(installed.backup.backupAppPath), true);
  });
});

test("setup migrates the legacy global-origin patch only from its verified clean backup", async () => {
  const root = temporaryRoot("ccdx-pms-legacy-migrate-");
  const fixture = makeAsarFixture();
  const appPath = createAppFixture(root, fixture);
  const backupRoot = path.join(root, "backups");
  const signCounter = { value: 0 };
  const operations = fixtureOperations({ signCounter });
  const first = await runPmStudioSetup({
    appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
  });

  const manifest = JSON.parse(fs.readFileSync(first.backup.manifestPath, "utf8"));
  manifest.patched = {
    ...manifest.patched,
    asar_sha256: fixture.recipe.legacy.asarSha256,
    asar_header_sha256: fixture.recipe.legacy.headerSha256,
    electron_asar_integrity: { algorithm: "SHA256", hash: fixture.recipe.legacy.headerSha256 },
  };
  writeJson(first.backup.manifestPath, manifest);
  fs.writeFileSync(path.join(appPath, fixture.recipe.asarPath), fixture.legacy);
  const plistPath = path.join(appPath, fixture.recipe.infoPlistPath);
  const plist = JSON.parse(fs.readFileSync(plistPath, "utf8"));
  plist.integrity = { algorithm: "SHA256", hash: fixture.recipe.legacy.headerSha256 };
  writeJson(plistPath, plist);
  assert.equal(inspectPmStudioApp({ appPath, recipe: fixture.recipe, operations }).state, "legacy");

  const copySources = [];
  const copyBundle = operations.copyBundle;
  operations.copyBundle = (args) => {
    copySources.push(args.source);
    return copyBundle(args);
  };
  const messages = [];
  const migrated = await runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [fixture.recipe],
    operations,
    logger: (line) => messages.push(line),
  });
  assert.equal(migrated.status, "migrated");
  assert.equal(signCounter.value, 2);
  assert.deepEqual(copySources, [first.backup.backupAppPath], "legacy app itself must never seed staging");
  assert.deepEqual(fs.readFileSync(path.join(appPath, fixture.recipe.asarPath)), fixture.patched);
  assert.deepEqual(fs.readFileSync(path.join(first.backup.backupAppPath, fixture.recipe.asarPath)), fixture.source);
  assert.match(messages.join("\n"), /GPT and enterprise authentication return to PM Studio's native origin/);

  const migratedManifest = JSON.parse(fs.readFileSync(first.backup.manifestPath, "utf8"));
  assert.equal(migratedManifest.patched.asar_sha256, fixture.recipe.patchedAsarSha256);
  assert.equal(migratedManifest.legacy_patched.asar_sha256, fixture.recipe.legacy.asarSha256);
});

test("legacy global-origin patch without a verified clean backup is rejected unchanged", async () => {
  const root = temporaryRoot("ccdx-pms-legacy-no-backup-");
  const fixture = makeAsarFixture();
  const appPath = createAppFixture(root, fixture, { signature: "adhoc", state: "legacy" });
  const snapshot = sourceSnapshot(appPath);
  const backupRoot = path.join(root, "backups");
  const operations = fixtureOperations();
  await assert.rejects(runPmStudioSetup({
    appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
  }), { code: "PM_STUDIO_BACKUP_INVALID" });
  assertSnapshot(appPath, snapshot);
  assert.equal(fs.existsSync(backupRoot), false);
});

test("setup migrates the exact predecessor from a verified clean backup for schema 1 and schema 2", async (t) => {
  for (const { name, version, schema2 } of [
    { name: "2.9.7 schema 1", version: "2.9.7", schema2: false },
    { name: "2.9.10 schema 2", version: "2.9.10", schema2: true },
  ]) {
    await t.test(name, async () => {
      const root = temporaryRoot(`ccdx-pms-predecessor-${version}-`);
      const fixture = makeAsarFixture({ version });
      const appPath = createAppFixture(root, fixture);
      const backupRoot = path.join(root, "backups");
      const signCounter = { value: 0 };
      const operations = fixtureOperations({ signCounter });
      const recipe = schema2 ? schema2FixtureRecipe(appPath, fixture, operations) : fixture.recipe;
      if (schema2) {
        // Seed the migration with the readable signing metadata required by the
        // legacy static recipe. Unreadable clean signatures are covered by the
        // independent dynamic-compatibility tests.
        const inspectSchema2CodeSign = operations.inspectCodeSign;
        operations.inspectCodeSign = (args) => {
          const inspected = inspectSchema2CodeSign(args);
          return inspected.adHoc ? inspected : { ...inspected, entitlementsState: "xml" };
        };
      }
      const first = await runPmStudioSetup({
        appPath, home: root, backupRoot, recipes: [recipe], operations, logger: () => {},
      });
      if (schema2) {
        const legacyManifest = JSON.parse(fs.readFileSync(first.backup.manifestPath, "utf8"));
        legacyManifest.source.artifact = { legacy: true };
        legacyManifest.source.code_signature = { legacy: true };
        writeJson(first.backup.manifestPath, legacyManifest);
      }
      const backupSnapshot = sourceSnapshot(first.backup.backupAppPath);
      const predecessorRecord = installPredecessorFixture({
        appPath,
        fixture,
        recipe,
        manifestPath: first.backup.manifestPath,
      });
      assert.equal(inspectPmStudioApp({ appPath, recipe, operations }).state, "predecessor");

      const copySources = [];
      const copyBundle = operations.copyBundle;
      operations.copyBundle = (args) => {
        copySources.push(args.source);
        return copyBundle(args);
      };
      const migrated = await runPmStudioSetup({
        appPath, home: root, backupRoot, recipes: [recipe], operations, logger: () => {},
      });

      assert.equal(migrated.status, "migrated");
      assert.equal(signCounter.value, 2);
      assert.deepEqual(copySources, [first.backup.backupAppPath]);
      assert.deepEqual(fs.readFileSync(path.join(appPath, recipe.asarPath)), fixture.patched);
      assertSnapshot(first.backup.backupAppPath, backupSnapshot);
      const manifest = JSON.parse(fs.readFileSync(first.backup.manifestPath, "utf8"));
      assert.deepEqual(manifest.predecessor_patched, predecessorRecord);
      assert.equal(manifest.patched.asar_sha256, recipe.patchedAsarSha256);
      assert.equal(manifest.patched.asar_header_sha256, recipe.patchedHeaderSha256);
    });
  }
});

test("predecessor without a verified backup and unknown predecessor bit drift are rejected unchanged", async (t) => {
  await t.test("missing backup", async () => {
    const root = temporaryRoot("ccdx-pms-predecessor-no-backup-");
    const fixture = makeAsarFixture();
    const appPath = createAppFixture(root, fixture, { signature: "adhoc", state: "predecessor" });
    const snapshot = sourceSnapshot(appPath);
    const backupRoot = path.join(root, "backups");
    const operations = fixtureOperations();
    assert.equal(inspectPmStudioApp({ appPath, recipe: fixture.recipe, operations }).state, "predecessor");
    await assert.rejects(runPmStudioSetup({
      appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
    }), { code: "PM_STUDIO_BACKUP_INVALID" });
    assertSnapshot(appPath, snapshot);
    assert.equal(fs.existsSync(backupRoot), false);
  });

  await t.test("unknown bit drift", async () => {
    const root = temporaryRoot("ccdx-pms-predecessor-drift-");
    const fixture = makeAsarFixture();
    const appPath = createAppFixture(root, fixture, { signature: "adhoc", state: "predecessor" });
    const asarPath = path.join(appPath, fixture.recipe.asarPath);
    const drift = fs.readFileSync(asarPath);
    drift[drift.length - 1] ^= 1;
    fs.writeFileSync(asarPath, drift);
    const snapshot = sourceSnapshot(appPath);
    const backupRoot = path.join(root, "backups");
    const operations = fixtureOperations();
    assert.equal(inspectPmStudioApp({ appPath, recipe: fixture.recipe, operations }).state, "drift");
    await assert.rejects(runPmStudioSetup({
      appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
    }), { code: "PM_STUDIO_BUNDLE_DRIFT" });
    assertSnapshot(appPath, snapshot);
    assert.equal(fs.existsSync(backupRoot), false);
  });
});

test("predecessor manifest record drift fails before staging or installation", async (t) => {
  for (const { name, mutate, code } of [
    {
      name: "installed predecessor binary record drift",
      mutate(manifest) {
        manifest.patched.binaries.main_executable_sha256 = "unknown-main-drift";
      },
      code: "PM_STUDIO_BUNDLE_DRIFT",
    },
    {
      name: "mismatched existing predecessor_patched record",
      mutate(manifest) {
        manifest.predecessor_patched = {
          ...manifest.patched,
          asar_sha256: "0".repeat(64),
        };
      },
      code: "PM_STUDIO_BACKUP_INVALID",
    },
  ]) {
    await t.test(name, async () => {
      const root = temporaryRoot("ccdx-pms-predecessor-record-drift-");
      const fixture = makeAsarFixture();
      const appPath = createAppFixture(root, fixture);
      const backupRoot = path.join(root, "backups");
      const signCounter = { value: 0 };
      const operations = fixtureOperations({ signCounter });
      const first = await runPmStudioSetup({
        appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
      });
      installPredecessorFixture({
        appPath,
        fixture,
        recipe: fixture.recipe,
        manifestPath: first.backup.manifestPath,
      });
      const snapshot = sourceSnapshot(appPath);
      const manifest = JSON.parse(fs.readFileSync(first.backup.manifestPath, "utf8"));
      mutate(manifest);
      writeJson(first.backup.manifestPath, manifest);
      const copyBundle = operations.copyBundle;
      let copyCount = 0;
      operations.copyBundle = (args) => {
        copyCount += 1;
        return copyBundle(args);
      };

      await assert.rejects(runPmStudioSetup({
        appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
      }), { code });
      assertSnapshot(appPath, snapshot);
      assert.equal(copyCount, 0);
      assert.equal(signCounter.value, 1);
    });
  }
});

test("a failed predecessor replacement preserves its record and can be retried", async () => {
  const root = temporaryRoot("ccdx-pms-predecessor-retry-");
  const fixture = makeAsarFixture();
  const appPath = createAppFixture(root, fixture);
  const backupRoot = path.join(root, "backups");
  const signCounter = { value: 0 };
  const operations = fixtureOperations({ signCounter });
  const first = await runPmStudioSetup({
    appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
  });
  const predecessorRecord = installPredecessorFixture({
    appPath,
    fixture,
    recipe: fixture.recipe,
    manifestPath: first.backup.manifestPath,
  });
  const predecessorSnapshot = sourceSnapshot(appPath);
  const replaceApp = operations.replaceApp;
  operations.replaceApp = () => {
    throw new Error("fixture replacement failed");
  };

  await assert.rejects(runPmStudioSetup({
    appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
  }), { code: "PM_STUDIO_REPLACE_FAILED" });
  assertSnapshot(appPath, predecessorSnapshot);
  const failedManifest = JSON.parse(fs.readFileSync(first.backup.manifestPath, "utf8"));
  assert.deepEqual(failedManifest.predecessor_patched, predecessorRecord);
  assert.equal(failedManifest.patched.asar_sha256, fixture.recipe.patchedAsarSha256);

  operations.replaceApp = replaceApp;
  const retried = await runPmStudioSetup({
    appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
  });
  assert.equal(retried.status, "migrated");
  assert.equal(signCounter.value, 3);
  assert.deepEqual(fs.readFileSync(path.join(appPath, fixture.recipe.asarPath)), fixture.patched);
  const retriedManifest = JSON.parse(fs.readFileSync(first.backup.manifestPath, "utf8"));
  assert.deepEqual(retriedManifest.predecessor_patched, predecessorRecord);
});

test("a late running-process preflight preserves the predecessor and can be retried", async () => {
  const root = temporaryRoot("ccdx-pms-predecessor-late-running-");
  const fixture = makeAsarFixture();
  const appPath = createAppFixture(root, fixture);
  const backupRoot = path.join(root, "backups");
  const operations = fixtureOperations();
  const first = await runPmStudioSetup({
    appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
  });
  const predecessorRecord = installPredecessorFixture({
    appPath,
    fixture,
    recipe: fixture.recipe,
    manifestPath: first.backup.manifestPath,
  });
  const predecessorSnapshot = sourceSnapshot(appPath);
  let processChecks = 0;
  operations.listBlockingProcesses = () => {
    processChecks += 1;
    return processChecks === 2 ? ["123 PM Studio"] : [];
  };

  await assert.rejects(runPmStudioSetup({
    appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
  }), { code: "PM_STUDIO_RUNNING" });
  assert.equal(processChecks, 2);
  assertSnapshot(appPath, predecessorSnapshot);
  const blockedManifest = JSON.parse(fs.readFileSync(first.backup.manifestPath, "utf8"));
  assert.deepEqual(blockedManifest.predecessor_patched, predecessorRecord);
  assert.equal(blockedManifest.patched.asar_sha256, fixture.recipe.patchedAsarSha256);

  operations.listBlockingProcesses = () => [];
  const retried = await runPmStudioSetup({
    appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
  });
  assert.equal(retried.status, "migrated");
  assert.deepEqual(fs.readFileSync(path.join(appPath, fixture.recipe.asarPath)), fixture.patched);
  const retriedManifest = JSON.parse(fs.readFileSync(first.backup.manifestPath, "utf8"));
  assert.deepEqual(retriedManifest.predecessor_patched, predecessorRecord);
});

test("2.9.10 setup treats source signing as informational and records the complete local tree", async () => {
  const root = temporaryRoot("ccdx-pms-2-9-10-");
  const fixture = makeAsarFixture({ version: "2.9.10", compatible: true });
  const appPath = createAppFixture(root, fixture);
  const sourceBundleContent = {
    ...inspectBundleContent(appPath),
    ignoredXattrs: [],
  };
  const recipe = {
    ...fixture.recipe,
    sourceBundleContent,
    sourceCodeSignature: {
      identifier: "com.pm-studio.app",
      teamIdentifier: "HL75GKK4W4",
      flags: "0x10000(runtime)",
      runtimeVersion: "15.0.0",
      cdHashFull: "fixture-vendor-cdhash",
      notarizationTicket: "stapled",
    },
    patchedSigningMetadata: {
      identifier: "com.pm-studio.app",
      flags: "0x10002(adhoc,runtime)",
      runtime_version: "15.0.0",
      entitlements_sha256: "fixture-entitlements",
    },
  };
  const signCounter = { value: 0 };
  const operations = fixtureOperations({ signCounter });
  const inspectCodeSign = operations.inspectCodeSign;
  operations.inspectCodeSign = (args) => {
    const inspected = inspectCodeSign(args);
    if (inspected.adHoc) return inspected;
    return {
      ...inspected,
      valid: false,
      verifyValid: false,
      displayValid: true,
      entitlementsState: "invalid",
      cdHashFull: "fixture-vendor-cdhash",
      notarizationTicket: "stapled",
    };
  };
  operations.inspectBundleContent = ({ appPath: inspectedPath }) => inspectBundleContent(inspectedPath);

  const clean = inspectPmStudioApp({ appPath, recipe, operations });
  assert.equal(clean.state, "clean");
  assert.equal(clean.sourceVerification, "local-content");
  assert.equal(inspectPmStudioApp({ appPath, recipe: fixture.recipe, operations }).state, "clean");

  const exactInspectCodeSign = operations.inspectCodeSign;
  for (const [field, value] of [
    ["verifyValid", true],
    ["displayValid", false],
    ["entitlementsState", "unavailable"],
    ["identifier", "com.example.drift"],
    ["teamIdentifier", "DRIFT"],
    ["flags", "0x0(none)"],
    ["runtimeVersion", "0.0.0"],
    ["cdHashFull", "drift"],
    ["notarizationTicket", "missing"],
  ]) {
    operations.inspectCodeSign = (args) => ({ ...exactInspectCodeSign(args), [field]: value });
    assert.equal(inspectPmStudioApp({ appPath, recipe, operations }).state, "clean", field);
  }
  operations.inspectCodeSign = exactInspectCodeSign;

  const exactInspectBundleContent = operations.inspectBundleContent;
  for (const field of [
    "sha256",
    "entryCount",
    "regularFileCount",
    "regularBytes",
    "symlinkCount",
    "xattrCount",
  ]) {
    operations.inspectBundleContent = () => ({
      ...sourceBundleContent,
      [field]: field === "sha256" ? "drift" : sourceBundleContent[field] + 1,
    });
    assert.equal(inspectPmStudioApp({ appPath, recipe, operations }).state, "drift", field);
  }
  operations.inspectBundleContent = exactInspectBundleContent;

  const backupRoot = path.join(root, "backups");
  const messages = [];
  const installed = await runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [makeAsarFixture().recipe, recipe],
    operations,
    logger: (line) => messages.push(line),
  });
  assert.equal(installed.status, "patched");
  assert.match(installed.recipe, /^pm-studio-compatible-/);
  assert.equal(signCounter.value, 1);
  assert.doesNotMatch(messages.join("\n"), /official bundle|vendor signature|GitHub release/i);
  const manifest = JSON.parse(fs.readFileSync(installed.backup.manifestPath, "utf8"));
  assert.equal(manifest.schema_version, 2);
  assert.deepEqual(manifest.source.bundle_content, {
    ...sourceBundleContent,
    ignoredXattrs: PM_STUDIO_2_9_10_RECIPE.sourceBundleContent.ignoredXattrs,
  });
  assert.deepEqual(manifest.patched.bundle_content, installed.inspection.bundleContent);

  const repeated = await runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [makeAsarFixture().recipe, recipe],
    operations,
    logger: () => {},
  });
  assert.equal(repeated.status, "already_patched");
  assert.equal(signCounter.value, 1);

  fs.writeFileSync(path.join(appPath, "Contents/unrecorded-helper"), "drift");
  await assert.rejects(runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [recipe],
    operations,
    logger: () => {},
  }), { code: "PM_STUDIO_BUNDLE_DRIFT" });
});

test("unknown PM Studio 2.9.11 is rejected before backup, staging, or signing", async () => {
  const root = temporaryRoot("ccdx-pms-2-9-11-");
  const installedFixture = makeAsarFixture({ version: "2.9.11" });
  const supportedFixture = makeAsarFixture({ version: "2.9.10" });
  const appPath = createAppFixture(root, installedFixture);
  const snapshot = sourceSnapshot(appPath);
  const backupRoot = path.join(root, "backups");
  const signCounter = { value: 0 };
  const operations = fixtureOperations({ signCounter });

  await assert.rejects(runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [supportedFixture.recipe],
    operations,
    logger: () => {},
  }), (error) => error.code === "PM_STUDIO_UNSUPPORTED_VERSION"
    && /2\.9\.11 build 2\.9\.11 is not structurally compatible.*no files were changed/.test(error.message));
  assertSnapshot(appPath, snapshot);
  assert.equal(fs.existsSync(backupRoot), false);
  assert.equal(signCounter.value, 0);
});

test("a future PM Studio with the unique compatible module is patched offline regardless of source signature", async () => {
  const root = temporaryRoot("ccdx-pms-compatible-2-9-12-");
  const installedFixture = makeAsarFixture({ version: "2.9.12", compatible: true });
  const supportedFixture = makeAsarFixture({ version: "2.9.10" });
  const appPath = createAppFixture(root, installedFixture, { signature: "unsigned" });
  const backupRoot = path.join(root, "backups");
  const signCounter = { value: 0 };
  const operations = fixtureOperations({ signCounter });
  operations.verifyOfficialProvenance = async () => assert.fail("local PM Studio setup must not access GitHub provenance");

  const installed = await runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [supportedFixture.recipe],
    operations,
    logger: () => {},
  });
  assert.equal(installed.status, "patched");
  assert.match(installed.recipe, /^pm-studio-compatible-/);
  assert.deepEqual(fs.readFileSync(path.join(appPath, installedFixture.recipe.asarPath)), installedFixture.patched);
  assert.equal(signCounter.value, 1);
  const manifest = JSON.parse(fs.readFileSync(installed.backup.manifestPath, "utf8"));
  assert.equal(manifest.schema_version, 2);
  assert.equal(manifest.compatibility, "exact-copilot-config-module-v1");
  assert.equal(manifest.app.version, "2.9.12");
  assert.equal(manifest.source.asar_sha256, installedFixture.recipe.sourceAsarSha256);
  assert.equal(Object.hasOwn(manifest.source, "artifact"), false);
  assert.equal(Object.hasOwn(manifest.source, "code_signature"), false);

  const repeated = await runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [supportedFixture.recipe],
    operations,
    logger: () => {},
  });
  assert.equal(repeated.status, "already_patched");
  assert.equal(repeated.recipe, installed.recipe);
  assert.equal(signCounter.value, 1);

  const patchedSnapshot = sourceSnapshot(appPath);
  delete manifest.compatibility;
  writeJson(installed.backup.manifestPath, manifest);
  await assert.rejects(runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [supportedFixture.recipe],
    operations,
    logger: () => {},
  }), { code: "PM_STUDIO_BACKUP_INVALID" });
  assertSnapshot(appPath, patchedSnapshot);
  assert.equal(signCounter.value, 1);

  manifest.compatibility = "exact-copilot-config-module-v1";
  manifest.source.asar_sha256 = "drift";
  writeJson(installed.backup.manifestPath, manifest);
  await assert.rejects(runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [supportedFixture.recipe],
    operations,
    logger: () => {},
  }), { code: "PM_STUDIO_BACKUP_INVALID" });
  assertSnapshot(appPath, patchedSnapshot);
  assert.equal(signCounter.value, 1);
});

test("an invalid-signed compatible PM Studio is patched without release verification", async () => {
  const root = temporaryRoot("ccdx-pms-compatible-invalid-signature-");
  const installedFixture = makeAsarFixture({ version: "2.9.12", compatible: true });
  const supportedFixture = makeAsarFixture({ version: "2.9.10" });
  const appPath = createAppFixture(root, installedFixture, { signature: "invalid" });
  const infoPlistPath = path.join(appPath, "Contents/Info.plist");
  const info = JSON.parse(fs.readFileSync(infoPlistPath, "utf8"));
  info.bundleIdentifier = "com.internal.pm-studio";
  writeJson(infoPlistPath, info);
  const backupRoot = path.join(root, "backups");
  const signCounter = { value: 0 };
  const operations = fixtureOperations({ signCounter });
  const inspectCodeSign = operations.inspectCodeSign;
  operations.inspectCodeSign = (args) => {
    const inspected = inspectCodeSign(args);
    if (inspected.adHoc) {
      return { ...inspected, entitlementsState: "xml", entitlementsSha256: "c".repeat(64) };
    }
    return {
      ...inspected,
      valid: false,
      verifyValid: false,
      displayValid: true,
      entitlementsState: "invalid",
      entitlementsSha256: "",
      cdHashFull: "a".repeat(64),
      notarizationTicket: "stapled",
    };
  };
  operations.verifyOfficialProvenance = async () => assert.fail("invalid source signatures must not trigger network provenance");
  const messages = [];

  const installed = await runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [supportedFixture.recipe],
    operations,
    logger: (line) => messages.push(line),
  });

  assert.equal(installed.status, "patched");
  assert.equal(signCounter.value, 1);
  assert.equal(installed.inspection.codeSign.identifier, "com.internal.pm-studio");
  assert.doesNotMatch(messages.join("\n"), /official release|vendor signature/i);
  const manifest = JSON.parse(fs.readFileSync(installed.backup.manifestPath, "utf8"));
  assert.equal(Object.hasOwn(manifest.source, "artifact"), false);
  assert.equal(Object.hasOwn(manifest.source, "code_signature"), false);
  manifest.source.artifact = { legacy_provenance: true };
  manifest.source.code_signature = { legacy_provenance: true };
  writeJson(installed.backup.manifestPath, manifest);

  const repeated = await runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [supportedFixture.recipe],
    operations,
    logger: () => {},
  });
  assert.equal(repeated.status, "already_patched");
  assert.equal(signCounter.value, 1);
});

test("compatible backup resolution selects the exact patched bundle among same-version source variants", async () => {
  const root = temporaryRoot("ccdx-pms-compatible-variants-");
  const installedFixture = makeAsarFixture({ version: "2.9.12", compatible: true });
  const supportedFixture = makeAsarFixture({ version: "2.9.10" });
  const appPath = createAppFixture(root, installedFixture);
  const backupRoot = path.join(root, "backups");
  const signCounter = { value: 0 };
  const operations = fixtureOperations({ signCounter });

  const first = await runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [supportedFixture.recipe],
    operations,
    logger: () => {},
  });
  fs.rmSync(appPath, { recursive: true, force: true });
  fs.cpSync(first.backup.backupAppPath, appPath, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
  fs.writeFileSync(path.join(appPath, "Contents/Resources/variant-locale.txt"), "variant");

  const second = await runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [supportedFixture.recipe],
    operations,
    logger: () => {},
  });
  assert.notEqual(second.backup.backupDir, first.backup.backupDir);
  assert.equal(fs.readdirSync(backupRoot).length, 2);

  const repeated = await runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [supportedFixture.recipe],
    operations,
    logger: () => {},
  });
  assert.equal(repeated.status, "already_patched");
  assert.equal(repeated.backup.backupDir, second.backup.backupDir);
  assert.equal(signCounter.value, 2);
});

test("same-version stale built-in metadata falls back to the local structural recipe", async () => {
  const root = temporaryRoot("ccdx-pms-compatible-stale-recipe-");
  const installedFixture = makeAsarFixture({ version: "2.9.12", compatible: true });
  const staleFixture = makeAsarFixture({ version: "2.9.12" });
  const appPath = createAppFixture(root, installedFixture, { signature: "unsigned" });
  const backupRoot = path.join(root, "backups");
  const signCounter = { value: 0 };
  const operations = fixtureOperations({ signCounter });
  operations.verifyOfficialProvenance = async () => assert.fail("stale metadata must not trigger source verification");

  const installed = await runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [staleFixture.recipe],
    operations,
    logger: () => {},
  });
  assert.equal(installed.status, "patched");
  assert.match(installed.recipe, /^pm-studio-compatible-/);
  assert.notEqual(installed.recipe, staleFixture.recipe.id);
  assert.equal(signCounter.value, 1);
});

test("local fingerprint cannot absorb a post-snapshot app change into the compatible recipe", async () => {
  const root = temporaryRoot("ccdx-pms-compatible-local-race-");
  const installedFixture = makeAsarFixture({ version: "2.9.12", compatible: true });
  const appPath = createAppFixture(root, installedFixture, { signature: "invalid" });
  const backupRoot = path.join(root, "backups");
  const signCounter = { value: 0 };
  const operations = fixtureOperations({ signCounter });
  let fingerprintCalls = 0;
  operations.inspectBundleContent = ({ appPath: inspectedPath }) => {
    const fingerprint = inspectBundleContent(inspectedPath);
    fingerprintCalls += 1;
    if (fingerprintCalls === 1) {
      fs.writeFileSync(path.join(appPath, "Contents/Resources/post-snapshot.js"), "changed");
    }
    return fingerprint;
  };

  await assert.rejects(runPmStudioSetup({
    appPath,
    home: root,
    backupRoot,
    recipes: [makeAsarFixture({ version: "2.9.10" }).recipe],
    operations,
    logger: () => {},
  }), { code: "PM_STUDIO_BUNDLE_DRIFT" });
  assert.equal(fingerprintCalls, 2);
  assert.equal(signCounter.value, 0);
  assert.equal(fs.existsSync(backupRoot), false);
});

test("setup enters the app-scoped exclusive lock before any preflight", async () => {
  const root = temporaryRoot("ccdx-pms-lock-wiring-");
  const fixture = makeAsarFixture();
  const appPath = createAppFixture(root, fixture);
  const operations = fixtureOperations();
  const calls = [];
  operations.withSetupLock = async (options, fn) => {
    calls.push({ appPath: options.appPath, beforeCallback: true });
    const result = await fn();
    calls.push({ appPath: options.appPath, afterCallback: true });
    return result;
  };

  const result = await runPmStudioSetup({
    appPath,
    home: root,
    backupRoot: path.join(root, "backups"),
    recipes: [fixture.recipe],
    operations,
    logger: () => {},
  });
  assert.equal(result.status, "patched");
  assert.deepEqual(calls, [
    { appPath, beforeCallback: true },
    { appPath, afterCallback: true },
  ]);
});

test("compatible-version discovery rejects ambiguous or structurally invalid sources without writes", async (t) => {
  for (const [name, fixtureOptions, signature, mutate] of [
    ["duplicate module anchor", { version: "2.9.12", compatible: true, duplicateAnchor: true }, "vendor", null],
    ["unsafe integrity block geometry", { version: "2.9.12", compatible: true, blockSize: 1 }, "vendor", null],
    ["plist integrity mismatch", { version: "2.9.12", compatible: true }, "vendor", ({ appPath: target }) => {
      const plistPath = path.join(target, "Contents/Info.plist");
      const plist = JSON.parse(fs.readFileSync(plistPath, "utf8"));
      plist.integrity.hash = "drift";
      writeJson(plistPath, plist);
    }],
    ["target integrity mismatch", { version: "2.9.12", compatible: true }, "vendor", ({ appPath: target, fixture }) => {
      const asarPath = path.join(target, fixture.recipe.asarPath);
      const bytes = fs.readFileSync(asarPath);
      bytes[fixture.recipe.targets[0].edit.absoluteOffset + fixture.recipe.targets[0].edit.length + 1] ^= 1;
      fs.writeFileSync(asarPath, bytes);
    }],
  ]) {
    await t.test(name, async () => {
      const root = temporaryRoot("ccdx-pms-compatible-reject-");
      const installedFixture = makeAsarFixture(fixtureOptions);
      const supportedFixture = makeAsarFixture({ version: "2.9.10" });
      const appPath = createAppFixture(root, installedFixture, { signature });
      mutate?.({ appPath, fixture: installedFixture });
      const snapshot = sourceSnapshot(appPath);
      const backupRoot = path.join(root, "backups");
      const signCounter = { value: 0 };
      const operations = fixtureOperations({ signCounter });

      await assert.rejects(runPmStudioSetup({
        appPath,
        home: root,
        backupRoot,
        recipes: [supportedFixture.recipe],
        operations,
        logger: () => {},
      }), { code: "PM_STUDIO_UNSUPPORTED_VERSION" });
      assertSnapshot(appPath, snapshot);
      assert.equal(fs.existsSync(backupRoot), false);
      assert.equal(signCounter.value, 0);
    });
  }
});

test("setup requires an isolated Claude profile before creating backup or staging data", async () => {
  const root = temporaryRoot("ccdx-pms-auth-");
  const fixture = makeAsarFixture();
  const appPath = createAppFixture(root, fixture);
  const backupRoot = path.join(root, "backups");
  const snapshot = sourceSnapshot(appPath);
  const operations = fixtureOperations();
  operations.readClaudeCredentials = () => ({ configured: false, valid: false, reason: "unconfigured" });

  await assert.rejects(runPmStudioSetup({
    appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
  }), (error) => error.code === "PM_STUDIO_CLAUDE_AUTH_INVALID"
    && error.message.includes(PM_STUDIO_CLAUDE_AUTH_COMMAND));
  assertSnapshot(appPath, snapshot);
  assert.equal(fs.existsSync(backupRoot), false);
});

test("an existing backup with incomplete source evidence is rejected without changing the patched app", async () => {
  const root = temporaryRoot("ccdx-pms-backup-manifest-");
  const fixture = makeAsarFixture();
  const appPath = createAppFixture(root, fixture);
  const backupRoot = path.join(root, "backups");
  const operations = fixtureOperations();
  const installed = await runPmStudioSetup({
    appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
  });
  const snapshot = sourceSnapshot(appPath);
  const manifest = JSON.parse(fs.readFileSync(installed.backup.manifestPath, "utf8"));
  delete manifest.source.binaries.main_executable_sha256;
  writeJson(installed.backup.manifestPath, manifest);

  await assert.rejects(runPmStudioSetup({
    appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
  }), { code: "PM_STUDIO_BACKUP_INVALID" });
  assertSnapshot(appPath, snapshot);
});

test("running PM Studio, insufficient space, ASAR drift, and embedded integrity all fail before source mutation", async (t) => {
  const cases = [
    {
      name: "running",
      mutate: () => {},
      operations: fixtureOperations({ blocking: ["123 PM Studio"] }),
      code: "PM_STUDIO_RUNNING",
    },
    {
      name: "space",
      mutate: () => {},
      operations: fixtureOperations({ freeBytes: 1 }),
      code: "PM_STUDIO_SPACE_INSUFFICIENT",
    },
    {
      name: "permission",
      mutate: () => {},
      operations: (() => {
        const operations = fixtureOperations();
        operations.assertPermissions = () => {
          const error = new Error("fixture permission denied");
          error.code = "PM_STUDIO_PERMISSION_DENIED";
          throw error;
        };
        return operations;
      })(),
      code: "PM_STUDIO_PERMISSION_DENIED",
    },
    {
      name: "asar",
      mutate: (appPath) => {
        const asarPath = path.join(appPath, "Contents/Resources/app.asar");
        const value = fs.readFileSync(asarPath);
        value[value.length - 1] ^= 1;
        fs.writeFileSync(asarPath, value);
      },
      operations: fixtureOperations(),
      code: "PM_STUDIO_BUNDLE_DRIFT",
    },
    {
      name: "plist-algorithm",
      mutate: (appPath) => {
        const plistPath = path.join(appPath, "Contents/Info.plist");
        const plist = JSON.parse(fs.readFileSync(plistPath, "utf8"));
        plist.integrity.algorithm = "sha256";
        writeJson(plistPath, plist);
      },
      operations: fixtureOperations(),
      code: "PM_STUDIO_BUNDLE_DRIFT",
    },
    {
      name: "embedded-integrity-slot",
      mutate: () => {},
      operations: (() => {
        const operations = fixtureOperations();
        operations.inspectExecutableIntegrity = () => ({
          executableName: "PM Studio",
          executableSha256: "fixture-main-source",
          frameworkSha256: "fixture-framework-source",
          embeddedIntegrity: { state: "present", supported: false, framework: { slots: [{ used: 1 }] } },
          matchesRecipeName: true,
        });
        return operations;
      })(),
      code: "PM_STUDIO_BUNDLE_DRIFT",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const root = temporaryRoot(`ccdx-pms-${item.name}-`);
      const fixture = makeAsarFixture();
      const appPath = createAppFixture(root, fixture);
      item.mutate(appPath);
      const snapshot = sourceSnapshot(appPath);
      const backupRoot = path.join(root, "backups");
      await assert.rejects(runPmStudioSetup({
        appPath,
        home: root,
        backupRoot,
        recipes: [fixture.recipe],
        operations: item.operations,
        logger: () => {},
      }), { code: item.code });
      assertSnapshot(appPath, snapshot);
      if (item.code !== "PM_STUDIO_SPACE_INSUFFICIENT") assert.equal(fs.existsSync(backupRoot), false);
    });
  }
});

test("staging sign failure leaves the source app untouched and preserves only the verified backup", async () => {
  const root = temporaryRoot("ccdx-pms-sign-fail-");
  const fixture = makeAsarFixture();
  const appPath = createAppFixture(root, fixture);
  const snapshot = sourceSnapshot(appPath);
  const backupRoot = path.join(root, "backups");
  const operations = fixtureOperations({ signatureFailure: true });

  await assert.rejects(runPmStudioSetup({
    appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
  }), /fixture sign failed/);
  assertSnapshot(appPath, snapshot);
  assert.equal(fs.readdirSync(root).some((name) => name.includes("ccdx-stage")), false);
  const backupDir = path.join(backupRoot, fs.readdirSync(backupRoot)[0]);
  assert.deepEqual(fs.readFileSync(path.join(backupDir, "PM Studio.app/Contents/Resources/app.asar")), fixture.source);
});

test("an atomic replacement failure leaves the original app unchanged", async () => {
  const root = temporaryRoot("ccdx-pms-rename-fail-");
  const fixture = makeAsarFixture();
  const appPath = createAppFixture(root, fixture);
  const snapshot = sourceSnapshot(appPath);
  const backupRoot = path.join(root, "backups");
  const operations = fixtureOperations({ uuidPrefix: "rename" });
  operations.replaceApp = () => { throw new Error("fixture atomic replace failed"); };

  await assert.rejects(runPmStudioSetup({
    appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
  }), { code: "PM_STUDIO_REPLACE_FAILED" });
  assertSnapshot(appPath, snapshot);
  assert.equal(fs.readdirSync(root).some((name) => name.includes("ccdx-stage") || name.includes("ccdx-original")), false);
});

test("an error reported after atomic exchange is accepted only after exact installed-state verification", async () => {
  const root = temporaryRoot("ccdx-pms-replace-late-error-");
  const fixture = makeAsarFixture();
  const appPath = createAppFixture(root, fixture);
  const backupRoot = path.join(root, "backups");
  const operations = fixtureOperations();
  const replaceApp = operations.replaceApp;
  operations.replaceApp = (args) => {
    replaceApp(args);
    throw new Error("fixture reported a late replacement error");
  };
  const messages = [];

  const result = await runPmStudioSetup({
    appPath, home: root, backupRoot, recipes: [fixture.recipe], operations,
    logger: (line) => messages.push(line),
  });
  assert.equal(result.status, "patched");
  assert.deepEqual(fs.readFileSync(path.join(appPath, fixture.recipe.asarPath)), fixture.patched);
  assert.match(messages.join("\n"), /reported an error after the exact patched bundle became installed/);
});

test("post-replacement drift fails with the verified recovery paths instead of claiming the original survived", async () => {
  const root = temporaryRoot("ccdx-pms-post-replace-drift-");
  const fixture = makeAsarFixture();
  const appPath = createAppFixture(root, fixture);
  const backupRoot = path.join(root, "backups");
  const operations = fixtureOperations();
  const replaceApp = operations.replaceApp;
  operations.replaceApp = (args) => {
    replaceApp(args);
    const asarPath = path.join(args.appPath, fixture.recipe.asarPath);
    const bytes = fs.readFileSync(asarPath);
    bytes[bytes.length - 1] ^= 1;
    fs.writeFileSync(asarPath, bytes);
  };

  await assert.rejects(runPmStudioSetup({
    appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
  }), (error) => {
    assert.equal(error.code, "PM_STUDIO_INSTALL_VERIFY_FAILED");
    assert.match(error.message, /do not launch it/i);
    assert.match(error.message, /Verified backup:/);
    assert.match(error.message, /manifest:/);
    return true;
  });
  const backupDir = path.join(backupRoot, fs.readdirSync(backupRoot)[0]);
  assert.deepEqual(fs.readFileSync(path.join(backupDir, "PM Studio.app", fixture.recipe.asarPath)), fixture.source);
  assert.equal(inspectAsarBuffer(fs.readFileSync(path.join(appPath, fixture.recipe.asarPath)), fixture.recipe).state, "drift");
});

test("an unknown replacement state retains the verified stage for diagnosis", async () => {
  const root = temporaryRoot("ccdx-pms-replace-unknown-");
  const fixture = makeAsarFixture();
  const appPath = createAppFixture(root, fixture);
  const backupRoot = path.join(root, "backups");
  const operations = fixtureOperations();
  operations.replaceApp = ({ appPath: installedPath }) => {
    const asarPath = path.join(installedPath, fixture.recipe.asarPath);
    const bytes = fs.readFileSync(asarPath);
    bytes[bytes.length - 1] ^= 1;
    fs.writeFileSync(asarPath, bytes);
    throw new Error("fixture replacement state unknown");
  };
  let retainedStage;

  await assert.rejects(runPmStudioSetup({
    appPath, home: root, backupRoot, recipes: [fixture.recipe], operations, logger: () => {},
  }), (error) => {
    assert.equal(error.code, "PM_STUDIO_INSTALL_VERIFY_FAILED");
    const match = error.message.match(/Verified staging retained: (.+)\.$/);
    assert.ok(match);
    retainedStage = match[1];
    return true;
  });
  assert.equal(fs.existsSync(retainedStage), true);
  assert.equal(inspectAsarBuffer(fs.readFileSync(path.join(retainedStage, fixture.recipe.asarPath)), fixture.recipe).state,
    "patched");
});

test("default ad-hoc codesign adapter signs and verifies only a temporary app fixture", {
  skip: process.platform !== "darwin",
}, () => {
  const root = temporaryRoot("ccdx-pms-codesign-");
  const appPath = path.join(root, "Fixture.app");
  fs.mkdirSync(path.join(appPath, "Contents/MacOS"), { recursive: true });
  fs.writeFileSync(path.join(appPath, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Fixture</string>
<key>CFBundleIdentifier</key><string>test.ccdx.pm-studio.fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>ElectronAsarIntegrity</key><dict>
<key>Resources/app.asar</key><dict>
<key>algorithm</key><string>SHA256</string>
<key>hash</key><string>${"0".repeat(64)}</string>
</dict>
<key>Resources/other.asar</key><dict>
<key>algorithm</key><string>SHA256</string>
<key>hash</key><string>${"f".repeat(64)}</string>
</dict></dict>
  </dict></plist>\n`);
  const executable = path.join(appPath, "Contents/MacOS/Fixture");
  fs.copyFileSync("/bin/echo", executable);
  fs.chmodSync(executable, 0o755);
  const helperAppPath = path.join(appPath, "Contents/Frameworks/Fixture Helper.app");
  const helperExecutable = path.join(helperAppPath, "Contents/MacOS/Fixture Helper");
  fs.mkdirSync(path.dirname(helperExecutable), { recursive: true });
  fs.writeFileSync(path.join(helperAppPath, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Fixture Helper</string>
<key>CFBundleIdentifier</key><string>test.ccdx.pm-studio.fixture.helper</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>\n`);
  fs.copyFileSync("/bin/echo", helperExecutable);
  fs.chmodSync(helperExecutable, 0o755);

  const operations = createPmStudioSetupOperations();
  const infoPlistPath = path.join(appPath, "Contents/Info.plist");
  const unsigned = operations.inspectCodeSign({ appPath, processRunner: operations.processRunner });
  assert.equal(unsigned.valid, false);
  operations.signApp({ appPath, source: { codeSign: unsigned }, processRunner: operations.processRunner });
  const signedFromUnsigned = operations.inspectCodeSign({ appPath, processRunner: operations.processRunner });
  assert.equal(signedFromUnsigned.valid, true);
  assert.equal(signedFromUnsigned.adHoc, true);
  assert.equal(signedFromUnsigned.identifier, "test.ccdx.pm-studio.fixture");
  assert.deepEqual(operations.readAsarIntegrity({
    infoPlistPath,
    recipe: PM_STUDIO_2_9_7_RECIPE,
    processRunner: operations.processRunner,
  }), { algorithm: "SHA256", hash: "0".repeat(64) });
  operations.writeAsarIntegrity({
    infoPlistPath,
    recipe: PM_STUDIO_2_9_7_RECIPE,
    hash: "a".repeat(64),
    processRunner: operations.processRunner,
  });
  assert.deepEqual(operations.readAsarIntegrity({
    infoPlistPath,
    recipe: PM_STUDIO_2_9_7_RECIPE,
    processRunner: operations.processRunner,
  }), { algorithm: "SHA256", hash: "a".repeat(64) });
  const dictionaryResult = operations.processRunner("/usr/bin/plutil", [
    "-extract", "ElectronAsarIntegrity", "json", "-o", "-", infoPlistPath,
  ]);
  assert.equal(JSON.parse(dictionaryResult.stdout)["Resources/other.asar"].hash, "f".repeat(64));
  const entitlementsPath = path.join(root, "entitlements.plist");
  fs.writeFileSync(entitlementsPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>\n`);
  const helperEntitlementsPath = path.join(root, "helper-entitlements.plist");
  fs.writeFileSync(helperEntitlementsPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>\n`);
  const helperSign = operations.processRunner("/usr/bin/codesign", [
    "--force", "--sign", "-", "--timestamp=none", "--options", "runtime",
    "--entitlements", helperEntitlementsPath, helperAppPath,
  ]);
  assert.equal(helperSign.status, 0, helperSign.stderr);
  const initialSign = operations.processRunner("/usr/bin/codesign", [
    "--force", "--sign", "-", "--timestamp=none", "--options", "runtime",
    "--entitlements", entitlementsPath, appPath,
  ]);
  assert.equal(initialSign.status, 0, initialSign.stderr);
  const before = operations.inspectCodeSign({ appPath, processRunner: operations.processRunner });
  const helperBefore = operations.inspectCodeSign({ appPath: helperAppPath, processRunner: operations.processRunner });
  assert.equal(before.valid, true);
  assert.equal(helperBefore.valid, true);
  assert.notEqual(before.entitlementsSha256, sha256Hex(""));
  assert.notEqual(helperBefore.entitlementsSha256, before.entitlementsSha256);
  fs.writeFileSync(path.join(appPath, "Contents/invalidates-signature"), "local fixture drift");
  const invalid = operations.inspectCodeSign({ appPath, processRunner: operations.processRunner });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.displayValid, true);
  operations.signApp({ appPath, source: { codeSign: invalid }, processRunner: operations.processRunner });
  const signed = operations.inspectCodeSign({ appPath, processRunner: operations.processRunner });
  const helperSigned = operations.inspectCodeSign({ appPath: helperAppPath, processRunner: operations.processRunner });
  assert.equal(signed.valid, true);
  assert.equal(signed.adHoc, true);
  assert.equal(signed.identifier, "test.ccdx.pm-studio.fixture");
  assert.equal(signed.teamIdentifier, "not set");
  assert.equal(signed.entitlementsSha256, before.entitlementsSha256);
  assert.equal(helperSigned.entitlementsSha256, helperBefore.entitlementsSha256);
  const copiedAppPath = path.join(root, "Fixture Copy.app");
  operations.copyBundle({ source: appPath, destination: copiedAppPath, processRunner: operations.processRunner });
  const copied = operations.inspectCodeSign({ appPath: copiedAppPath, processRunner: operations.processRunner });
  assert.equal(copied.valid, true);
  assert.equal(copied.adHoc, true);
  assert.equal(copied.identifier, signed.identifier);
  assert.equal(copied.entitlementsSha256, signed.entitlementsSha256);
});

test("default Foundation adapter atomically replaces temporary non-empty directories", {
  skip: process.platform !== "darwin",
}, () => {
  const root = temporaryRoot("ccdx-pms-atomic-");
  const appPath = path.join(root, "PM Studio.app");
  const stagePath = path.join(root, ".PM Studio.app.stage");
  fs.mkdirSync(appPath);
  fs.mkdirSync(stagePath);
  fs.writeFileSync(path.join(appPath, "marker"), "original");
  fs.writeFileSync(path.join(stagePath, "marker"), "patched");

  const operations = createPmStudioSetupOperations();
  operations.replaceApp({ appPath, stagePath, processRunner: operations.processRunner });
  assert.equal(fs.readFileSync(path.join(appPath, "marker"), "utf8"), "patched");
  assert.equal(fs.existsSync(stagePath), false);
});
