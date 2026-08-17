import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  AUTH_PROFILE_CLAUDE,
  readAuthProfileCredentials,
} from "./auth-profile.mjs";
import {
  PM_STUDIO_2_9_7_RECIPE,
  PM_STUDIO_RECIPES,
  inspectElectronAsarIntegritySlots,
  inspectAsarBuffer,
  patchAsarBuffer,
  sha256Hex,
} from "./pm-studio-asar.mjs";

export const DEFAULT_PM_STUDIO_APP_PATH = "/Applications/PM Studio.app";
export const PM_STUDIO_CLAUDE_AUTH_COMMAND = "ccdx auth login claude --reauth --github-login <personal-login>";
const MIN_FREE_MARGIN_BYTES = 16 * 1024 * 1024;
const BUNDLE_CONTENT_SCHEME = "ccdx-bundle-content-v2";

function setupError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function defaultProcessRunner(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function normalizedProcessResult(result) {
  if (typeof result === "string") return { status: 0, stdout: result, stderr: "" };
  return {
    status: result?.status ?? (result?.error ? 1 : 0),
    stdout: String(result?.stdout || ""),
    stderr: String(result?.stderr || ""),
    error: result?.error,
  };
}

function runChecked(processRunner, command, args, label) {
  const result = normalizedProcessResult(processRunner(command, args));
  if (result.error || result.status !== 0) {
    throw setupError("PM_STUDIO_PROCESS_FAILED", `${label} failed`);
  }
  return result;
}

function hashRegularFile(filePath, expected) {
  const hash = createHash("sha256");
  const file = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const buffer = Buffer.allocUnsafe(1024 * 1024);
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
        records.push(["file", relative, mode, stat.size, hashRegularFile(fullPath, stat)]);
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

function defaultInspectBundleContent({ appPath, recipe, processRunner }) {
  const xattrs = runChecked(processRunner, "/usr/bin/xattr", ["-r", "-s", "-x", "-l", appPath],
    "Reading PM Studio extended attributes");
  return inspectBundleContent(appPath, {
    xattrOutput: xattrs.stdout,
    ignoredXattrs: recipe.sourceBundleContent?.ignoredXattrs || [],
  });
}

function plistRead(processRunner, plistPath, key) {
  return runChecked(processRunner, "/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plistPath],
    `Reading ${path.basename(plistPath)}`).stdout.trim();
}

function defaultReadBundleMetadata({ infoPlistPath, processRunner }) {
  return {
    version: plistRead(processRunner, infoPlistPath, "CFBundleShortVersionString"),
    build: plistRead(processRunner, infoPlistPath, "CFBundleVersion"),
    bundleIdentifier: plistRead(processRunner, infoPlistPath, "CFBundleIdentifier"),
  };
}

function defaultReadAsarIntegrity({ infoPlistPath, recipe, processRunner }) {
  const key = recipe.integrityKey.split(".")[0];
  const result = runChecked(processRunner, "/usr/bin/plutil", [
    "-extract", key, "json", "-o", "-", infoPlistPath,
  ], "Reading ElectronAsarIntegrity");
  const dictionary = JSON.parse(result.stdout);
  return dictionary["Resources/app.asar"] || null;
}

function defaultWriteAsarIntegrity({ infoPlistPath, recipe, hash, processRunner }) {
  const key = recipe.integrityKey.split(".")[0];
  const result = runChecked(processRunner, "/usr/bin/plutil", [
    "-extract", key, "json", "-o", "-", infoPlistPath,
  ], "Reading ElectronAsarIntegrity");
  const dictionary = JSON.parse(result.stdout);
  dictionary["Resources/app.asar"] = { algorithm: "SHA256", hash };
  runChecked(processRunner, "/usr/bin/plutil", [
    "-replace", key, "-json", JSON.stringify(dictionary), infoPlistPath,
  ], "Updating ElectronAsarIntegrity hash");
}

function defaultInspectCodeSign({ appPath, processRunner }) {
  const verify = normalizedProcessResult(processRunner("/usr/bin/codesign", [
    "--verify", "--deep", "--strict", "--verbose=2", appPath,
  ]));
  const display = normalizedProcessResult(processRunner("/usr/bin/codesign", [
    "--display", "--verbose=4", appPath,
  ]));
  const details = `${display.stdout}\n${display.stderr}`;
  const entitlementsResult = normalizedProcessResult(processRunner("/usr/bin/codesign", [
    "--display", "--entitlements", "-", "--xml", appPath,
  ]));
  const entitlementOutput = `${entitlementsResult.stdout}\n${entitlementsResult.stderr}`;
  const plistStart = entitlementOutput.indexOf("<?xml");
  const plistEnd = entitlementOutput.lastIndexOf("</plist>");
  const hasEntitlements = plistStart >= 0 && plistEnd >= plistStart;
  const entitlements = hasEntitlements
    ? entitlementOutput.slice(plistStart, plistEnd + "</plist>".length)
    : "";
  return {
    valid: !verify.error && verify.status === 0
      && !display.error && display.status === 0
      && !entitlementsResult.error && entitlementsResult.status === 0
      && hasEntitlements,
    verifyValid: !verify.error && verify.status === 0,
    displayValid: !display.error && display.status === 0,
    entitlementsState: hasEntitlements
      ? "xml"
      : /invalid entitlements blob/i.test(entitlementOutput) ? "invalid" : "unavailable",
    adHoc: /(?:^|\n)Signature=adhoc(?:\n|$)/i.test(details)
      || /(?:^|\n)TeamIdentifier=not set(?:\n|$)/i.test(details),
    identifier: details.match(/(?:^|\n)Identifier=([^\n]+)/)?.[1]?.trim() || "",
    teamIdentifier: details.match(/(?:^|\n)TeamIdentifier=([^\n]+)/)?.[1]?.trim() || "",
    flags: details.match(/\bflags=([^\s]+)/)?.[1] || "",
    runtimeVersion: details.match(/(?:^|\n)Runtime Version=([^\n]+)/)?.[1]?.trim() || "",
    cdHashFull: details.match(/(?:^|\n)CandidateCDHashFull sha256=([0-9a-f]+)/i)?.[1]?.toLowerCase() || "",
    notarizationTicket: details.match(/(?:^|\n)Notarization Ticket=([^\n]+)/)?.[1]?.trim() || "",
    entitlementsSha256: hasEntitlements ? sha256Hex(entitlements) : "",
  };
}

function defaultInspectExecutableIntegrity({ appPath, infoPlistPath, recipe, processRunner }) {
  const executableName = plistRead(processRunner, infoPlistPath, "CFBundleExecutable");
  if (!executableName || path.basename(executableName) !== executableName) {
    throw setupError("PM_STUDIO_EXECUTABLE_INVALID", "PM Studio CFBundleExecutable is invalid");
  }
  const executablePath = path.join(appPath, "Contents", "MacOS", executableName);
  const frameworkPath = path.join(appPath, recipe.electronFrameworkPath);
  const executableBytes = fs.readFileSync(executablePath);
  const frameworkBytes = fs.readFileSync(frameworkPath);
  const executableSlots = inspectElectronAsarIntegritySlots(executableBytes);
  const frameworkSlots = inspectElectronAsarIntegritySlots(frameworkBytes);
  return {
    executableName,
    executablePath,
    executableSha256: sha256Hex(executableBytes),
    frameworkPath,
    frameworkSha256: sha256Hex(frameworkBytes),
    embeddedIntegrity: {
      state: executableSlots.slots.length === 0 && frameworkSlots.slots.length === 0 ? "absent" : "present",
      supported: executableSlots.slots.length === 0 && frameworkSlots.slots.length === 0,
      executable: executableSlots,
      framework: frameworkSlots,
    },
    matchesRecipeName: executableName === recipe.executable,
  };
}

function defaultSignApp({ appPath, processRunner }) {
  runChecked(processRunner, "/usr/bin/codesign", [
    "--force", "--deep", "--sign", "-", "--timestamp=none",
    "--preserve-metadata=identifier,entitlements,flags,runtime", appPath,
  ], "Ad-hoc codesigning PM Studio");
}

function defaultListBlockingProcesses({ processRunner }) {
  const output = runChecked(processRunner, "/bin/ps", ["-axo", "pid=,command="],
    "Checking PM Studio processes").stdout;
  return output.split(/\r?\n/).filter((line) => {
    const value = line.toLowerCase();
    return value.includes("/pm studio.app/")
      || value.includes("pm studio shipit")
      || value.includes("pm studio updater")
      || value.includes("com.pm-studio.app")
      || value.includes("com.electron.pm-studio.shipit");
  });
}

function defaultCopyBundle({ source, destination, processRunner }) {
  if (fs.existsSync(destination)) throw setupError("PM_STUDIO_COPY_TARGET_EXISTS", `Copy target already exists: ${destination}`);
  runChecked(processRunner, "/usr/bin/ditto", ["--rsrc", "--extattr", "--acl", source, destination],
    "Copying PM Studio bundle");
}

const ATOMIC_REPLACE_JXA = `function run(argv) {
  ObjC.import("Foundation");
  const manager = $.NSFileManager.defaultManager;
  const oldUrl = $.NSURL.fileURLWithPath(argv[0]);
  const newUrl = $.NSURL.fileURLWithPath(argv[1]);
  const result = Ref();
  const error = Ref();
  const ok = manager.replaceItemAtURLWithItemAtURLBackupItemNameOptionsResultingItemURLError(
    oldUrl, newUrl, undefined, 1, result, error
  );
  if (!ok) throw new Error(ObjC.unwrap(error[0].localizedDescription));
}`;

function defaultReplaceApp({ appPath, stagePath, processRunner }) {
  runChecked(processRunner, "/usr/bin/osascript", [
    "-l", "JavaScript", "-e", ATOMIC_REPLACE_JXA, "--", appPath, stagePath,
  ], "Atomically replacing PM Studio");
}

function directorySize(directory) {
  let total = 0;
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    total += stat.size;
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    for (const name of fs.readdirSync(current)) visit(path.join(current, name));
  };
  visit(directory);
  return total;
}

function nearestExistingPath(targetPath) {
  let current = path.resolve(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw setupError("PM_STUDIO_PATH_UNAVAILABLE", `No existing parent for ${targetPath}`);
    current = parent;
  }
  return current;
}

function defaultAvailableBytes(targetPath) {
  const stat = fs.statfsSync(nearestExistingPath(targetPath), { bigint: true });
  return Number(stat.bavail * stat.bsize);
}

function defaultVolumeId(targetPath) {
  return String(fs.statSync(nearestExistingPath(targetPath)).dev);
}

function defaultAssertPermissions({ appPath, backupRoot }) {
  try {
    fs.accessSync(appPath, fs.constants.R_OK);
    fs.accessSync(path.dirname(appPath), fs.constants.W_OK);
    fs.accessSync(nearestExistingPath(backupRoot), fs.constants.W_OK);
  } catch {
    throw setupError("PM_STUDIO_PERMISSION_DENIED",
      "PM Studio or its backup/staging location is not accessible to the current user; setup will not use sudo");
  }
}

export function createPmStudioSetupOperations(overrides = {}) {
  const processRunner = overrides.processRunner || defaultProcessRunner;
  return {
    processRunner,
    readBundleMetadata: defaultReadBundleMetadata,
    readAsarIntegrity: defaultReadAsarIntegrity,
    writeAsarIntegrity: defaultWriteAsarIntegrity,
    inspectCodeSign: defaultInspectCodeSign,
    inspectBundleContent: defaultInspectBundleContent,
    inspectExecutableIntegrity: defaultInspectExecutableIntegrity,
    signApp: defaultSignApp,
    listBlockingProcesses: defaultListBlockingProcesses,
    copyBundle: defaultCopyBundle,
    renamePath: ({ source, destination }) => fs.renameSync(source, destination),
    replaceApp: defaultReplaceApp,
    removePath: ({ target }) => fs.rmSync(target, { recursive: true, force: true }),
    bundleSize: directorySize,
    availableBytes: defaultAvailableBytes,
    volumeId: defaultVolumeId,
    assertPermissions: defaultAssertPermissions,
    readClaudeCredentials: ({ home }) => readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home }),
    now: () => new Date(),
    uuid: () => randomUUID(),
    ...overrides,
    processRunner,
  };
}

function appPaths(appPath, recipe) {
  return {
    appPath,
    infoPlistPath: path.join(appPath, recipe.infoPlistPath),
    asarPath: path.join(appPath, recipe.asarPath),
  };
}

function integrityMatches(actual, algorithm, hash) {
  return actual?.algorithm === algorithm && actual?.hash === hash;
}

function bundleContentMatches(actual, expected) {
  return actual?.scheme === expected?.scheme
    && actual?.sha256 === expected?.sha256
    && actual?.entryCount === expected?.entryCount
    && actual?.regularFileCount === expected?.regularFileCount
    && actual?.regularBytes === expected?.regularBytes
    && actual?.symlinkCount === expected?.symlinkCount
    && actual?.xattrCount === expected?.xattrCount;
}

function sourceCodeSignatureMatches(actual, expected) {
  return actual?.adHoc === false
    && actual?.displayValid === true
    && actual?.identifier === expected?.identifier
    && actual?.teamIdentifier === expected?.teamIdentifier
    && actual?.flags === expected?.flags
    && actual?.runtimeVersion === expected?.runtimeVersion
    && actual?.cdHashFull === expected?.cdHashFull
    && actual?.notarizationTicket === expected?.notarizationTicket;
}

export function inspectPmStudioApp({
  appPath,
  recipe = PM_STUDIO_2_9_7_RECIPE,
  operations = createPmStudioSetupOperations(),
} = {}) {
  const paths = appPaths(appPath, recipe);
  const issues = [];
  const metadata = operations.readBundleMetadata({ ...paths, recipe, processRunner: operations.processRunner });
  const asar = inspectAsarBuffer(fs.readFileSync(paths.asarPath), recipe);
  const plistIntegrity = operations.readAsarIntegrity({ ...paths, recipe, processRunner: operations.processRunner });
  const executableIntegrity = operations.inspectExecutableIntegrity({
    ...paths, recipe, processRunner: operations.processRunner,
  });
  const codeSign = operations.inspectCodeSign({ ...paths, recipe, processRunner: operations.processRunner });
  let bundleContent = null;
  if (recipe.sourceBundleContent) {
    try {
      bundleContent = operations.inspectBundleContent({
        ...paths, recipe, processRunner: operations.processRunner,
      });
    } catch (error) {
      issues.push(`bundle content inspection failed: ${error.message}`);
    }
  }

  if (String(metadata.version) !== recipe.version) {
    issues.push(`version is ${metadata.version}, expected ${recipe.version}`);
  }
  if (String(metadata.build) !== recipe.build) {
    issues.push(`build is ${metadata.build}, expected ${recipe.build}`);
  }
  if (String(metadata.bundleIdentifier) !== recipe.bundleIdentifier) {
    issues.push(`bundle identifier is ${metadata.bundleIdentifier}, expected ${recipe.bundleIdentifier}`);
  }
  if (!executableIntegrity?.matchesRecipeName) issues.push("CFBundleExecutable does not match the recipe");
  if (!executableIntegrity?.embeddedIntegrity?.supported
    || executableIntegrity.embeddedIntegrity.state !== recipe.embeddedAsarIntegrity) {
    issues.push("Electron Framework has an unsupported embedded ASAR integrity slot");
  }

  const exactSourceBundle = !recipe.sourceBundleContent
    || bundleContentMatches(bundleContent, recipe.sourceBundleContent);
  const strictVendorSignature = codeSign?.valid === true
    && codeSign?.adHoc === false
    && codeSign?.teamIdentifier === recipe.sourceTeamIdentifier;
  const exactInvalidVendorSignature = recipe.sourceBundleContent
    && exactSourceBundle
    && codeSign?.valid === false
    && codeSign?.verifyValid === false
    && codeSign?.entitlementsState === "invalid"
    && sourceCodeSignatureMatches(codeSign, recipe.sourceCodeSignature);
  const sourceSignatureAccepted = strictVendorSignature || exactInvalidVendorSignature;
  const patchedSignatureAccepted = codeSign?.valid === true
    && codeSign?.adHoc === true
    && (!recipe.patchedSigningMetadata
      || JSON.stringify(signingMetadata(codeSign)) === JSON.stringify(recipe.patchedSigningMetadata));
  const clean = issues.length === 0
    && asar.state === "clean"
    && integrityMatches(plistIntegrity, "SHA256", recipe.sourceHeaderSha256)
    && executableIntegrity.executableSha256 === recipe.sourceExecutableSha256
    && executableIntegrity.frameworkSha256 === recipe.sourceElectronFrameworkSha256
    && exactSourceBundle
    && sourceSignatureAccepted;
  const patched = issues.length === 0
    && asar.state === "patched"
    && integrityMatches(plistIntegrity, "SHA256", recipe.patchedHeaderSha256)
    && patchedSignatureAccepted;

  if (!clean && !patched) {
    if (asar.state === "drift") issues.push("app.asar is unknown drift");
    else if (asar.state === "clean"
      && !integrityMatches(plistIntegrity, "SHA256", recipe.sourceHeaderSha256)) {
      issues.push("clean ASAR does not match ElectronAsarIntegrity");
    } else if (asar.state === "patched"
      && !integrityMatches(plistIntegrity, "SHA256", recipe.patchedHeaderSha256)) {
      issues.push("patched ASAR does not match ElectronAsarIntegrity");
    }
    if (asar.state === "clean" && recipe.sourceBundleContent && !exactSourceBundle) {
      issues.push("bundle content does not match the exact clean recipe");
    }
    if (!codeSign?.valid && !(asar.state === "clean" && exactInvalidVendorSignature)) {
      issues.push("codesign verification failed");
    }
    else if (asar.state === "clean" && codeSign.adHoc) issues.push("clean bundle has an unexpected ad-hoc signature");
    else if (asar.state === "patched" && !codeSign.adHoc) issues.push("patched bundle is not ad-hoc signed");
    else if (asar.state === "clean" && codeSign.teamIdentifier !== recipe.sourceTeamIdentifier) {
      issues.push(`clean bundle TeamIdentifier is ${codeSign.teamIdentifier || "missing"}, expected ${recipe.sourceTeamIdentifier}`);
    }
    if (asar.state === "clean"
      && executableIntegrity.executableSha256 !== recipe.sourceExecutableSha256) {
      issues.push("main executable hash does not match the clean recipe");
    }
    if (asar.state === "clean"
      && executableIntegrity.frameworkSha256 !== recipe.sourceElectronFrameworkSha256) {
      issues.push("Electron Framework hash does not match the clean recipe");
    }
    if (asar.state === "patched" && codeSign?.valid && codeSign?.adHoc
      && recipe.patchedSigningMetadata
      && !patchedSignatureAccepted) {
      issues.push("patched bundle signing metadata does not match the recipe");
    }
  }

  return {
    state: clean ? "clean" : patched ? "patched" : "drift",
    metadata: {
      version: String(metadata.version),
      build: String(metadata.build),
      bundleIdentifier: String(metadata.bundleIdentifier),
    },
    asar,
    plistIntegrity,
    executableIntegrity,
    codeSign,
    bundleContent,
    sourceVerification: clean
      ? exactInvalidVendorSignature ? "exact-bundle-content" : "codesign"
      : "",
    paths,
    issues,
  };
}

function assertInstalledAppPath(appPath) {
  const stat = fs.lstatSync(appPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw setupError("PM_STUDIO_APP_INVALID", `PM Studio path is not a regular app bundle: ${appPath}`);
  }
}

function assertNoBlockingProcesses(operations, appPath) {
  const processes = operations.listBlockingProcesses({ appPath, processRunner: operations.processRunner });
  if (!Array.isArray(processes)) throw setupError("PM_STUDIO_PROCESS_CHECK_FAILED", "PM Studio process check returned invalid data");
  if (processes.length > 0) {
    throw setupError("PM_STUDIO_RUNNING", `PM Studio or its updater is running (${processes.length} matching process(es)); quit it and retry`);
  }
}

function assertValidClaudeProfile(operations, home) {
  let credentials;
  try {
    credentials = operations.readClaudeCredentials({ home });
  } catch {
    throw setupError("PM_STUDIO_CLAUDE_AUTH_INVALID",
      `Claude isolated authentication could not be read. Run \`${PM_STUDIO_CLAUDE_AUTH_COMMAND}\` first.`);
  }
  if (!credentials?.configured || !credentials?.valid) {
    const reason = credentials?.reason ? ` (${credentials.reason})` : "";
    throw setupError("PM_STUDIO_CLAUDE_AUTH_INVALID",
      `Claude isolated authentication is not valid${reason}. Run \`${PM_STUDIO_CLAUDE_AUTH_COMMAND}\` first.`);
  }
}

function selectRecipe(metadata, recipes) {
  return recipes.find((recipe) => recipe.version === String(metadata.version)
    && recipe.build === String(metadata.build)
    && recipe.bundleIdentifier === String(metadata.bundleIdentifier));
}

function backupName(recipe) {
  const sourceHash = recipe.sourceBundleContent?.sha256 || recipe.sourceAsarSha256;
  return `${recipe.id}-${sourceHash.slice(0, 12)}`;
}

export function pmStudioBackupRoot(home = os.homedir()) {
  return path.join(home, ".local", "share", "codex-copilot-dx", "pm-studio-backups");
}

export function pmStudioPatchManifestPath({
  home = os.homedir(),
  backupRoot = pmStudioBackupRoot(home),
  recipe,
} = {}) {
  if (!recipe) throw new TypeError("PM Studio patch recipe is required");
  return path.join(backupRoot, backupName(recipe), "manifest.json");
}

function backupManifest(recipe, createdAt) {
  return {
    schema_version: recipe.sourceBundleContent ? 2 : 1,
    kind: "ccdx-pm-studio-backup",
    recipe_id: recipe.id,
    created_at: createdAt.toISOString(),
    app: {
      name: "PM Studio",
      bundle_identifier: recipe.bundleIdentifier,
      version: recipe.version,
      build: recipe.build,
    },
    source: {
      asar_sha256: recipe.sourceAsarSha256,
      asar_header_sha256: recipe.sourceHeaderSha256,
      electron_asar_integrity: { algorithm: "SHA256", hash: recipe.sourceHeaderSha256 },
      binaries: {
        main_executable_sha256: recipe.sourceExecutableSha256,
        electron_framework_sha256: recipe.sourceElectronFrameworkSha256,
        embedded_asar_integrity: recipe.embeddedAsarIntegrity,
      },
      ...(recipe.sourceBundleContent ? { bundle_content: recipe.sourceBundleContent } : {}),
      ...(recipe.sourceArtifact ? { artifact: recipe.sourceArtifact } : {}),
    },
    patched: {
      asar_sha256: recipe.patchedAsarSha256,
      asar_header_sha256: recipe.patchedHeaderSha256,
      electron_asar_integrity: { algorithm: "SHA256", hash: recipe.patchedHeaderSha256 },
      binaries: null,
      ...(recipe.sourceBundleContent ? { bundle_content: null } : {}),
    },
    backup_bundle: "PM Studio.app",
    restore_rule: `Restore only while the installed app is PM Studio ${recipe.version} build ${recipe.build}.`,
  };
}

function validateBackup({ backupDir, recipe, operations }) {
  const manifestPath = path.join(backupDir, "manifest.json");
  const backupAppPath = path.join(backupDir, "PM Studio.app");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw setupError("PM_STUDIO_BACKUP_INVALID", `Existing PM Studio backup manifest is invalid: ${manifestPath}`);
  }
  const expectedSchema = recipe.sourceBundleContent ? 2 : 1;
  if (manifest?.schema_version !== expectedSchema
    || manifest?.kind !== "ccdx-pm-studio-backup"
    || manifest?.recipe_id !== recipe.id
    || manifest?.app?.bundle_identifier !== recipe.bundleIdentifier
    || manifest?.app?.version !== recipe.version
    || manifest?.app?.build !== recipe.build
    || manifest?.source?.asar_sha256 !== recipe.sourceAsarSha256
    || manifest?.source?.asar_header_sha256 !== recipe.sourceHeaderSha256
    || !integrityMatches(manifest?.source?.electron_asar_integrity, "SHA256", recipe.sourceHeaderSha256)
    || manifest?.source?.binaries?.main_executable_sha256 !== recipe.sourceExecutableSha256
    || manifest?.source?.binaries?.electron_framework_sha256 !== recipe.sourceElectronFrameworkSha256
    || manifest?.source?.binaries?.embedded_asar_integrity !== recipe.embeddedAsarIntegrity
    || (recipe.sourceBundleContent
      && JSON.stringify(manifest?.source?.bundle_content) !== JSON.stringify(recipe.sourceBundleContent))
    || (recipe.sourceArtifact
      && JSON.stringify(manifest?.source?.artifact) !== JSON.stringify(recipe.sourceArtifact))
    || manifest?.patched?.asar_sha256 !== recipe.patchedAsarSha256
    || manifest?.patched?.asar_header_sha256 !== recipe.patchedHeaderSha256
    || !integrityMatches(manifest?.patched?.electron_asar_integrity, "SHA256", recipe.patchedHeaderSha256)) {
    throw setupError("PM_STUDIO_BACKUP_INVALID", `Existing PM Studio backup does not match recipe ${recipe.id}`);
  }
  const inspection = inspectPmStudioApp({ appPath: backupAppPath, recipe, operations });
  if (inspection.state !== "clean") {
    throw setupError("PM_STUDIO_BACKUP_INVALID", "Existing PM Studio backup is not an exact clean bundle", inspection.issues);
  }
  return { backupDir, backupAppPath, manifestPath, manifest, reused: true };
}

function ensureBackup({ appPath, backupRoot, recipe, operations }) {
  const finalDir = path.join(backupRoot, backupName(recipe));
  if (fs.existsSync(finalDir)) return validateBackup({ backupDir: finalDir, recipe, operations });

  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const tempDir = path.join(backupRoot, `.${backupName(recipe)}.${operations.uuid()}.tmp`);
  const backupAppPath = path.join(tempDir, "PM Studio.app");
  const manifestPath = path.join(tempDir, "manifest.json");
  fs.mkdirSync(tempDir, { mode: 0o700 });
  try {
    operations.copyBundle({ source: appPath, destination: backupAppPath, processRunner: operations.processRunner });
    fs.writeFileSync(manifestPath, `${JSON.stringify(backupManifest(recipe, operations.now()), null, 2)}\n`, { mode: 0o600 });
    const inspection = inspectPmStudioApp({ appPath: backupAppPath, recipe, operations });
    if (inspection.state !== "clean") {
      throw setupError("PM_STUDIO_BACKUP_VERIFY_FAILED", "New PM Studio backup failed verification", inspection.issues);
    }
    try {
      operations.renamePath({ source: tempDir, destination: finalDir });
    } catch (error) {
      if (!fs.existsSync(finalDir)) throw error;
      return validateBackup({ backupDir: finalDir, recipe, operations });
    }
    return {
      backupDir: finalDir,
      backupAppPath: path.join(finalDir, "PM Studio.app"),
      manifestPath: path.join(finalDir, "manifest.json"),
      manifest: JSON.parse(fs.readFileSync(path.join(finalDir, "manifest.json"), "utf8")),
      reused: false,
    };
  } finally {
    if (fs.existsSync(tempDir)) operations.removePath({ target: tempDir });
  }
}

function writePatchedBinaryRecord({ backup, inspection, operations, recipe }) {
  const manifest = JSON.parse(fs.readFileSync(backup.manifestPath, "utf8"));
  manifest.patched.binaries = {
    main_executable_sha256: inspection.executableIntegrity.executableSha256,
    electron_framework_sha256: inspection.executableIntegrity.frameworkSha256,
  };
  manifest.patched.signing_metadata = signingMetadata(inspection.codeSign);
  if (recipe.sourceBundleContent) manifest.patched.bundle_content = inspection.bundleContent;
  const temporaryPath = `${backup.manifestPath}.${operations.uuid()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    operations.renamePath({ source: temporaryPath, destination: backup.manifestPath });
  } finally {
    if (fs.existsSync(temporaryPath)) operations.removePath({ target: temporaryPath });
  }
  backup.manifest = manifest;
}

export function assertPatchedBinaryRecord({ inspection, manifestPath, recipe }) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw setupError("PM_STUDIO_PATCH_RECORD_INVALID", "PM Studio patched-binary record is missing or invalid");
  }
  const expectedSchema = recipe?.sourceBundleContent ? 2 : 1;
  if (recipe && (manifest?.schema_version !== expectedSchema
    || manifest?.kind !== "ccdx-pm-studio-backup"
    || manifest?.recipe_id !== recipe.id
    || manifest?.app?.bundle_identifier !== recipe.bundleIdentifier
    || manifest?.app?.version !== recipe.version
    || manifest?.app?.build !== recipe.build
    || (recipe.sourceBundleContent && (
      manifest?.source?.asar_sha256 !== recipe.sourceAsarSha256
      || manifest?.source?.asar_header_sha256 !== recipe.sourceHeaderSha256
      || !integrityMatches(manifest?.source?.electron_asar_integrity, "SHA256", recipe.sourceHeaderSha256)
      || manifest?.source?.binaries?.main_executable_sha256 !== recipe.sourceExecutableSha256
      || manifest?.source?.binaries?.electron_framework_sha256 !== recipe.sourceElectronFrameworkSha256
      || manifest?.source?.binaries?.embedded_asar_integrity !== recipe.embeddedAsarIntegrity
      || JSON.stringify(manifest?.source?.bundle_content) !== JSON.stringify(recipe.sourceBundleContent)
    ))
    || (recipe.sourceArtifact
      && JSON.stringify(manifest?.source?.artifact) !== JSON.stringify(recipe.sourceArtifact))
    || manifest?.patched?.asar_sha256 !== recipe.patchedAsarSha256
    || manifest?.patched?.asar_header_sha256 !== recipe.patchedHeaderSha256
    || !integrityMatches(manifest?.patched?.electron_asar_integrity, "SHA256", recipe.patchedHeaderSha256))) {
    throw setupError("PM_STUDIO_PATCH_RECORD_INVALID", "PM Studio patched-binary record does not match the installed patch recipe");
  }
  const binaries = manifest?.patched?.binaries;
  if (!binaries
    || binaries.main_executable_sha256 !== inspection.executableIntegrity.executableSha256
    || binaries.electron_framework_sha256 !== inspection.executableIntegrity.frameworkSha256) {
    throw setupError("PM_STUDIO_BUNDLE_DRIFT", "PM Studio executable or Electron Framework differs from the installed patch record");
  }
  if (JSON.stringify(manifest?.patched?.signing_metadata) !== JSON.stringify(signingMetadata(inspection.codeSign))) {
    throw setupError("PM_STUDIO_BUNDLE_DRIFT", "PM Studio signing metadata differs from the installed patch record");
  }
  if (recipe?.sourceBundleContent
    && JSON.stringify(manifest?.patched?.bundle_content) !== JSON.stringify(inspection.bundleContent)) {
    throw setupError("PM_STUDIO_BUNDLE_DRIFT", "PM Studio bundle content differs from the installed patch record");
  }
}

function signingMetadata(codeSign) {
  return {
    identifier: codeSign?.identifier || "",
    flags: codeSign?.flags || "",
    runtime_version: codeSign?.runtimeVersion || "",
    entitlements_sha256: codeSign?.entitlementsSha256 || "",
  };
}

function flagsWithoutAdHoc(value) {
  const flags = String(value || "");
  const match = flags.match(/^0x([0-9a-f]+)/i);
  if (!match) return flags.replace(/\badhoc\b,?/gi, "").replace(/\(,/, "(");
  return `0x${(BigInt(`0x${match[1]}`) & ~2n).toString(16)}`;
}

function assertSigningMetadataPreserved(source, staged, recipe) {
  if (recipe.patchedSigningMetadata) {
    if (JSON.stringify(signingMetadata(staged.codeSign))
      !== JSON.stringify(recipe.patchedSigningMetadata)) {
      throw setupError("PM_STUDIO_SIGNING_METADATA_CHANGED",
        "Ad-hoc signing did not produce the exact PM Studio signing metadata required by the recipe");
    }
    return;
  }
  const before = signingMetadata(source.codeSign);
  const after = signingMetadata(staged.codeSign);
  before.flags = flagsWithoutAdHoc(before.flags);
  after.flags = flagsWithoutAdHoc(after.flags);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw setupError("PM_STUDIO_SIGNING_METADATA_CHANGED",
      "Ad-hoc signing did not preserve PM Studio identifier, entitlements, flags, and runtime metadata");
  }
}

function assertSpace({ appPath, backupRoot, backupExists, operations }) {
  const bundleBytes = operations.bundleSize(appPath);
  if (!Number.isFinite(bundleBytes) || bundleBytes <= 0) throw setupError("PM_STUDIO_SIZE_INVALID", "Could not determine PM Studio bundle size");
  const appParent = path.dirname(appPath);
  const stageRequired = bundleBytes + MIN_FREE_MARGIN_BYTES;
  const backupRequired = backupExists ? 0 : bundleBytes + MIN_FREE_MARGIN_BYTES;
  const sameVolume = operations.volumeId(appParent) === operations.volumeId(backupRoot);
  if (sameVolume) {
    if (operations.availableBytes(appParent) < stageRequired + backupRequired) {
      throw setupError("PM_STUDIO_SPACE_INSUFFICIENT", "Not enough free space for PM Studio staging and backup");
    }
  } else {
    if (operations.availableBytes(appParent) < stageRequired
      || (!backupExists && operations.availableBytes(backupRoot) < backupRequired)) {
      throw setupError("PM_STUDIO_SPACE_INSUFFICIENT", "Not enough free space for PM Studio staging or backup");
    }
  }
}

function replaceVerifiedStage({ appPath, stagePath, operations }) {
  try {
    operations.replaceApp({ appPath, stagePath, processRunner: operations.processRunner });
    return null;
  } catch (error) {
    return error;
  }
}

function recoveryMessage(backup) {
  return `Verified backup: ${backup.backupAppPath}; manifest: ${backup.manifestPath}. Quit PM Studio, confirm the installed version/build still match, then restore only this version-matched backup or reinstall the official App.`;
}

export async function runPmStudioSetup({
  commandName = "ccdx",
  appPath = DEFAULT_PM_STUDIO_APP_PATH,
  home = os.homedir(),
  backupRoot = pmStudioBackupRoot(home),
  recipes = PM_STUDIO_RECIPES,
  operations: operationOverrides = {},
  logger = (line) => console.log(line),
} = {}) {
  const operations = createPmStudioSetupOperations(operationOverrides);
  const messages = [];
  const emit = (message) => {
    messages.push(message);
    logger(message);
  };

  assertValidClaudeProfile(operations, home);
  assertInstalledAppPath(appPath);
  operations.assertPermissions({ appPath, backupRoot });
  assertNoBlockingProcesses(operations, appPath);

  const genericPaths = {
    appPath,
    infoPlistPath: path.join(appPath, "Contents/Info.plist"),
    processRunner: operations.processRunner,
  };
  const metadata = operations.readBundleMetadata(genericPaths);
  const recipe = selectRecipe(metadata, recipes);
  if (!recipe) {
    throw setupError("PM_STUDIO_UNSUPPORTED_VERSION",
      `PM Studio ${metadata.version} build ${metadata.build} is not supported; no files were changed`);
  }

  const source = inspectPmStudioApp({ appPath, recipe, operations });
  const finalBackupDir = path.join(backupRoot, backupName(recipe));
  if (source.state === "patched") {
    if (!fs.existsSync(finalBackupDir)) {
      throw setupError("PM_STUDIO_BACKUP_INVALID", "Patched PM Studio has no matching verified backup; no files were changed");
    }
    const backup = validateBackup({ backupDir: finalBackupDir, recipe, operations });
    assertPatchedBinaryRecord({ inspection: source, manifestPath: backup.manifestPath, recipe });
    emit(`[OK] PM Studio ${recipe.version} build ${recipe.build} is already patched; no backup or signing was repeated.`);
    emit(`[OK] Verified backup: ${backup.backupAppPath}`);
    emit(`[OK] Backup manifest: ${backup.manifestPath}`);
    emit(`[INFO] Start ${commandName} before opening PM Studio.`);
    return { status: "already_patched", changed: false, recipe: recipe.id, backup, inspection: source, messages };
  }
  if (source.state !== "clean") {
    throw setupError("PM_STUDIO_BUNDLE_DRIFT",
      `PM Studio ${recipe.version} build ${recipe.build} does not match the clean or patched recipe; no files were changed`, source.issues);
  }

  if (source.sourceVerification === "exact-bundle-content") {
    emit(`[WARN] macOS rejected the vendor signature; setup accepted only the exact PM Studio ${recipe.version} official bundle content fingerprint.`);
  }

  const backupExists = fs.existsSync(finalBackupDir);
  assertSpace({ appPath, backupRoot, backupExists, operations });

  emit("[WARN] PM Studio's vendor signature will be replaced with an ad-hoc signature; an official update or reinstall may overwrite this patch.");
  const backup = ensureBackup({ appPath, backupRoot, recipe, operations });
  const stagePath = path.join(path.dirname(appPath), `.${path.basename(appPath)}.ccdx-stage-${operations.uuid()}`);
  let preserveStage = false;
  try {
    operations.copyBundle({ source: appPath, destination: stagePath, processRunner: operations.processRunner });
    const stagedSource = inspectPmStudioApp({ appPath: stagePath, recipe, operations });
    if (stagedSource.state !== "clean"
      || (recipe.sourceBundleContent
        && stagedSource.bundleContent?.sha256 !== source.bundleContent?.sha256)) {
      throw setupError("PM_STUDIO_STAGE_INVALID", "PM Studio staging copy does not match the exact clean source bundle", stagedSource.issues);
    }
    const stageAsarPath = path.join(stagePath, recipe.asarPath);
    const patched = patchAsarBuffer(fs.readFileSync(stageAsarPath), recipe);
    if (!patched.changed) throw setupError("PM_STUDIO_STAGE_INVALID", "Staging copy was unexpectedly already patched");
    fs.writeFileSync(stageAsarPath, patched.buffer);
    patched.buffer = null;
    operations.writeAsarIntegrity({
      ...appPaths(stagePath, recipe),
      recipe,
      hash: recipe.patchedHeaderSha256,
      processRunner: operations.processRunner,
    });
    operations.signApp({ appPath: stagePath, recipe, processRunner: operations.processRunner });

    const staged = inspectPmStudioApp({ appPath: stagePath, recipe, operations });
    if (staged.state !== "patched") {
      throw setupError("PM_STUDIO_STAGE_VERIFY_FAILED", "Patched PM Studio staging bundle failed verification", staged.issues);
    }
    assertSigningMetadataPreserved(source, staged, recipe);
    writePatchedBinaryRecord({ backup, inspection: staged, operations, recipe });

    assertNoBlockingProcesses(operations, appPath);
    const unchangedSource = inspectPmStudioApp({ appPath, recipe, operations });
    if (unchangedSource.state !== "clean"
      || unchangedSource.asar.asarSha256 !== source.asar.asarSha256
      || unchangedSource.asar.headerSha256 !== source.asar.headerSha256
      || (recipe.sourceBundleContent
        && unchangedSource.bundleContent?.sha256 !== source.bundleContent?.sha256)) {
      throw setupError("PM_STUDIO_SOURCE_CHANGED", "PM Studio changed during setup; the verified staging bundle was not installed");
    }

    const replacementError = replaceVerifiedStage({ appPath, stagePath, operations });
    let installed;
    try {
      installed = inspectPmStudioApp({ appPath, recipe, operations });
    } catch {
      preserveStage = fs.existsSync(stagePath);
      throw setupError("PM_STUDIO_REPLACE_STATE_UNKNOWN",
        `PM Studio replacement final state could not be verified. Do not launch it. ${recoveryMessage(backup)}${preserveStage ? ` Verified staging retained: ${stagePath}.` : ""}`);
    }
    if (installed.state !== "patched") {
      preserveStage = installed.state !== "clean" && fs.existsSync(stagePath);
      const code = installed.state === "clean"
        ? "PM_STUDIO_REPLACE_FAILED"
        : "PM_STUDIO_INSTALL_VERIFY_FAILED";
      const stateMessage = installed.state === "clean"
        ? "The installed PM Studio remains the verified clean bundle"
        : "The installed PM Studio did not retain the verified patched state; do not launch it";
      throw setupError(code,
        `${stateMessage}. ${recoveryMessage(backup)}${preserveStage ? ` Verified staging retained: ${stagePath}.` : ""}`,
        installed.issues);
    }
    try {
      assertPatchedBinaryRecord({ inspection: installed, manifestPath: backup.manifestPath, recipe });
    } catch (error) {
      throw setupError("PM_STUDIO_INSTALL_VERIFY_FAILED",
        `Installed PM Studio differs from the verified staging record; do not launch it. ${recoveryMessage(backup)}`,
        [error.message]);
    }
    if (replacementError) {
      emit("[WARN] Atomic replacement reported an error after the exact patched bundle became installed; the final bundle was independently verified.");
    }

    emit(`[OK] Patched PM Studio ${recipe.version} build ${recipe.build}.`);
    emit(`[OK] app.asar SHA-256: ${installed.asar.asarSha256}`);
    emit(`[OK] Verified backup: ${backup.backupAppPath}${backup.reused ? " (reused)" : ""}`);
    emit(`[OK] Backup manifest: ${backup.manifestPath}`);
    emit("[INFO] The verified staging bundle was installed with Foundation's atomic item replacement.");
    emit(`[INFO] Restore step 1/3: quit PM Studio and its updater.`);
    emit(`[INFO] Restore step 2/3: confirm the installed Info.plist still reports version/build ${recipe.version}/${recipe.build}; never restore this backup over another version.`);
    emit(`[INFO] Restore step 3/3: move ${appPath} aside, copy ${backup.backupAppPath} to that exact path, and verify its signature before launch.`);
    emit(`[INFO] Start ${commandName} before opening PM Studio.`);
    return {
      status: "patched",
      changed: true,
      recipe: recipe.id,
      backup,
      inspection: installed,
      replacementMode: "foundation-atomic-replace",
      messages,
    };
  } finally {
    if (!preserveStage && fs.existsSync(stagePath)) operations.removePath({ target: stagePath });
  }
}
