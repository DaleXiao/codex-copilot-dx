import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CCDX_PM_STUDIO_ORIGIN,
  ELECTRON_ASAR_INTEGRITY_SENTINEL,
  PM_STUDIO_2_9_10_RECIPE,
  PM_STUDIO_2_9_7_RECIPE,
  PM_STUDIO_ORIGIN,
  blockSha256,
  inspectAsarBuffer,
  inspectElectronAsarIntegritySlots,
  patchAsarBuffer,
  sha256Hex,
} from "../src/pm-studio-asar.mjs";
import {
  PM_STUDIO_CLAUDE_AUTH_COMMAND,
  createPmStudioSetupOperations,
  inspectBundleContent,
  inspectPmStudioApp,
  runPmStudioSetup,
} from "../src/pm-studio-setup.mjs";

const temporaryRoots = new Set();

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

function makeAsarFixture({ version = "2.9.7", build = version } = {}) {
  const sourceContents = [
    Buffer.from(`${"a".repeat(19)}${PM_STUDIO_ORIGIN}${"b".repeat(31)}`),
    Buffer.from(`${"x".repeat(7)}${PM_STUDIO_ORIGIN}${"y".repeat(13)}`),
  ];
  const sentinelOffsets = [19, 7];
  const patchedContents = sourceContents.map((content, index) =>
    replaceAt(content, sentinelOffsets[index], PM_STUDIO_ORIGIN, CCDX_PM_STUDIO_ORIGIN));
  const paths = ["dist/main/main.js", "dist/renderer/js/main.fixture.js"];
  const blockSize = 16;
  const targetBase = [];
  let entryOffset = 0;
  for (let index = 0; index < paths.length; index += 1) {
    targetBase.push({
      path: paths[index],
      offset: entryOffset,
      size: sourceContents[index].length,
      sentinelOffset: sentinelOffsets[index],
      sentinelCount: 1,
      blockSize,
      sourceSha256: sha256Hex(sourceContents[index]),
      patchedSha256: sha256Hex(patchedContents[index]),
      sourceBlocks: blockSha256(sourceContents[index], blockSize),
      patchedBlocks: blockSha256(patchedContents[index], blockSize),
    });
    entryOffset += sourceContents[index].length;
  }

  const headerFor = (patched) => {
    const header = { files: {} };
    for (const target of targetBase) {
      addHeaderEntry(header, target.path, {
        size: target.size,
        offset: String(target.offset),
        integrity: {
          algorithm: "SHA256",
          hash: patched ? target.patchedSha256 : target.sourceSha256,
          blockSize,
          blocks: [...(patched ? target.patchedBlocks : target.sourceBlocks)],
        },
      });
    }
    return header;
  };

  const source = buildArchive(headerFor(false), sourceContents);
  const patched = buildArchive(headerFor(true), patchedContents);
  assert.equal(source.dataOffset, patched.dataOffset);
  const targets = targetBase.map((target) => ({
    ...target,
    absoluteSentinelOffset: source.dataOffset + target.offset + target.sentinelOffset,
  }));
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
    sourceSentinel: PM_STUDIO_ORIGIN,
    patchedSentinel: CCDX_PM_STUDIO_ORIGIN,
    targets,
  };
  return { recipe, source: source.archive, patched: patched.archive };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createAppFixture(root, fixture, { signature = "vendor" } = {}) {
  const appPath = path.join(root, "PM Studio.app");
  const contents = path.join(appPath, "Contents");
  const resources = path.join(contents, "Resources");
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, "app.asar"), fixture.source);
  writeJson(path.join(contents, "Info.plist"), {
    version: fixture.recipe.version,
    build: fixture.recipe.build,
    bundleIdentifier: fixture.recipe.bundleIdentifier,
    integrity: { algorithm: "SHA256", hash: fixture.recipe.sourceHeaderSha256 },
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
    inspectCodeSign: ({ appPath }) => {
      const state = fs.readFileSync(path.join(appPath, "Contents/.fixture-signature"), "utf8");
      return {
        valid: state !== "invalid",
        adHoc: state === "adhoc",
        identifier: "com.pm-studio.app",
        teamIdentifier: state === "adhoc" ? "not set" : "HL75GKK4W4",
        flags: state === "adhoc" ? "0x10002(adhoc,runtime)" : "0x10000(runtime)",
        runtimeVersion: "15.0.0",
        entitlementsSha256: "fixture-entitlements",
      };
    },
    inspectExecutableIntegrity: () => ({
      executableName: "PM Studio",
      executableSha256: "fixture-main-source",
      frameworkSha256: "fixture-framework-source",
      embeddedIntegrity: { state: "absent", supported: true, executable: { slots: [] }, framework: { slots: [] } },
      matchesRecipeName: true,
    }),
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

test("PM Studio 2.9.7 recipe locks exact offsets, sizes, hashes, blocks, and equal-length sentinels", () => {
  assert.equal(PM_STUDIO_2_9_7_RECIPE.dataOffset, 3_832_764);
  assert.equal(PM_STUDIO_2_9_7_RECIPE.bundleIdentifier, "com.pm-studio.app");
  assert.equal(PM_STUDIO_2_9_7_RECIPE.sourceTeamIdentifier, "HL75GKK4W4");
  assert.equal(PM_STUDIO_2_9_7_RECIPE.targets[0].sentinelOffset, 1_120_480);
  assert.equal(PM_STUDIO_2_9_7_RECIPE.targets[0].absoluteSentinelOffset, 106_574_871);
  assert.equal(PM_STUDIO_2_9_7_RECIPE.targets[1].sentinelOffset, 489_935);
  assert.equal(PM_STUDIO_2_9_7_RECIPE.targets[1].absoluteSentinelOffset, 141_324_929);
  assert.equal(PM_STUDIO_2_9_7_RECIPE.executable, "PM Studio");
  assert.equal(PM_STUDIO_2_9_7_RECIPE.sourceExecutableSha256,
    "6364edd0561790610ee82399865f42f160523551d8d72220e26c4b18da324017");
  assert.equal(PM_STUDIO_2_9_7_RECIPE.sourceElectronFrameworkSha256,
    "e684d310334840f7a64f2d5171052eb514822af155779d3185e4f068daee4387");
  assert.equal(PM_STUDIO_2_9_7_RECIPE.targets.every((target) => target.sentinelCount === 1), true);
  assert.equal(Buffer.byteLength(PM_STUDIO_ORIGIN), 29);
  assert.equal(Buffer.byteLength(CCDX_PM_STUDIO_ORIGIN), 29);
});

test("PM Studio 2.9.10 recipe locks the official bundle, ASAR, targets, and signing policy", () => {
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
    "49f72d999a6085102341c2d551577e164db6f22e4707d2112efa3fd280e7315e");
  assert.equal(PM_STUDIO_2_9_10_RECIPE.targets[0].absoluteSentinelOffset, 106_696_751);
  assert.equal(PM_STUDIO_2_9_10_RECIPE.targets[1].absoluteSentinelOffset, 141_629_203);
  assert.equal(PM_STUDIO_2_9_10_RECIPE.sourceCodeSignature.teamIdentifier, "HL75GKK4W4");
  assert.equal(PM_STUDIO_2_9_10_RECIPE.patchedSigningMetadata.entitlements_sha256,
    "9d4ccbda4fe0c81a70df3db93b3e61fe0500f67f14cdcbee4dea230e6512d05c");
});

test("ASAR helpers classify clean/patched/drift and update file plus header integrity exactly", () => {
  const fixture = makeAsarFixture();
  const clean = inspectAsarBuffer(fixture.source, fixture.recipe);
  assert.equal(clean.state, "clean");
  assert.deepEqual(clean.targets.map((target) => target.sourceSentinelPositions), [[19], [7]]);
  assert.deepEqual(clean.targets.map((target) => target.patchedSentinelPositions), [[], []]);

  const result = patchAsarBuffer(fixture.source, fixture.recipe);
  assert.equal(result.changed, true);
  assert.deepEqual(result.buffer, fixture.patched);
  assert.equal(result.after.state, "patched");
  assert.deepEqual(result.after.targets.map((target) => target.patchedSentinelPositions), [[19], [7]]);

  const repeated = patchAsarBuffer(result.buffer, fixture.recipe);
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.buffer, fixture.patched);

  const drift = Buffer.from(fixture.source);
  drift[drift.length - 1] ^= 1;
  assert.equal(inspectAsarBuffer(drift, fixture.recipe).state, "drift");
  assert.throws(() => patchAsarBuffer(drift, fixture.recipe), { code: "PM_STUDIO_ASAR_DRIFT" });
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

test("default codesign command preserves identifiers, entitlements, flags, and runtime metadata", () => {
  const calls = [];
  const operations = createPmStudioSetupOperations({
    processRunner: (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  operations.signApp({ appPath: "/tmp/Fixture.app", processRunner: operations.processRunner });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/bin/codesign");
  assert.ok(calls[0].args.includes("--preserve-metadata=identifier,entitlements,flags,runtime"));
  assert.ok(calls[0].args.includes("--timestamp=none"));
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

test("codesign inspection exports XML entitlements and fails closed when they are unavailable", () => {
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
  assert.match(messages.join("\n"), /Start ccdx before opening PM Studio/);

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

test("2.9.10 setup accepts only the exact official-content fallback and records the complete patched tree", async () => {
  const root = temporaryRoot("ccdx-pms-2-9-10-");
  const fixture = makeAsarFixture({ version: "2.9.10" });
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
  assert.equal(clean.sourceVerification, "exact-bundle-content");
  assert.equal(inspectPmStudioApp({ appPath, recipe: fixture.recipe, operations }).state, "drift");

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
    assert.equal(inspectPmStudioApp({ appPath, recipe, operations }).state, "drift", field);
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
  assert.equal(installed.recipe, recipe.id);
  assert.equal(signCounter.value, 1);
  assert.match(messages.join("\n"), /accepted only the exact PM Studio 2\.9\.10 official bundle content fingerprint/);
  const manifest = JSON.parse(fs.readFileSync(installed.backup.manifestPath, "utf8"));
  assert.equal(manifest.schema_version, 2);
  assert.deepEqual(manifest.source.bundle_content, sourceBundleContent);
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
    && /2\.9\.11 build 2\.9\.11 is not supported; no files were changed/.test(error.message));
  assertSnapshot(appPath, snapshot);
  assert.equal(fs.existsSync(backupRoot), false);
  assert.equal(signCounter.value, 0);
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

test("running PM Studio, insufficient space, signature/ASAR drift, and embedded integrity all fail before source mutation", async (t) => {
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
      name: "signature",
      mutate: (appPath) => fs.writeFileSync(path.join(appPath, "Contents/.fixture-signature"), "invalid"),
      operations: fixtureOperations(),
      code: "PM_STUDIO_BUNDLE_DRIFT",
    },
    {
      name: "team-identifier",
      mutate: () => {},
      operations: (() => {
        const operations = fixtureOperations();
        const inspectCodeSign = operations.inspectCodeSign;
        operations.inspectCodeSign = (args) => ({
          ...inspectCodeSign(args),
          teamIdentifier: "UNKNOWNTEAM",
        });
        return operations;
      })(),
      code: "PM_STUDIO_BUNDLE_DRIFT",
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
  operations.signApp({ appPath, processRunner: operations.processRunner });
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
