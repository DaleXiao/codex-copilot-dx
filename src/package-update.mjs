import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { downloadRelease, protectInstallation, verifyPackageRuntime, writePrivateLaunchers, createNpmReleaseFetch, remoteDownloadDenied } from "./release-install.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { lookupLatestRelease, githubReleaseVersion } from "./version.mjs";
import { terminalCell } from "./terminal-text.mjs";
import { readBoundedFileSync } from "./bounded-file.mjs";

const PACKAGE_NAME = "codex-copilot-dx";
const UPDATE_SPECS = {
  npm: `${PACKAGE_NAME}@latest`,
  github: "https://github.com/DaleXiao/codex-copilot-dx/releases/download",
};

function npmLaunch(args, { platform, env }) {
  if (platform !== "win32") return { command: "npm", args, options: {} };
  return { command: path.win32.join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", "cmd.exe"),
    args: ["/d", "/s", "/v:off", "/c", `"npm.cmd ${args.join(" ")}"`],
    options: { windowsVerbatimArguments: true, windowsHide: true } };
}

export function inspectPackageUpdateEnvironment({ env = process.env, platform = process.platform,
  packageRoot = fileURLToPath(new URL("../", import.meta.url)), nodePath = process.execPath, exec = execFileSync } = {}) {
  const paths = platform === "win32" ? path.win32 : path;
  const commandName = platform === "win32" ? "npm.cmd" : "npm";
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] || "";
  const npmPath = searchPath.split(platform === "win32" ? ";" : ":")
    .filter(Boolean).map(directory => paths.join(directory.replace(/^"|"$/g, ""), commandName))
    .find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
  const result = { node: nodePath, package_root: paths.resolve(packageRoot), npm: npmPath || null,
    prefix: null, target: null, state: "unavailable" };
  if (!npmPath) return result;
  try {
    const launch = npmLaunch(["prefix", "--global"], { platform, env });
    const value = exec(launch.command, launch.args, { env, shell: false, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 3000,
      maxBuffer: 64 * 1024, ...launch.options }).trim();
    if (!paths.isAbsolute(value) || /[\r\n\0]/.test(value)) return result;
    result.prefix = paths.normalize(value);
    result.target = paths.join(value, ...(platform === "win32" ? [] : ["lib"]), "node_modules", PACKAGE_NAME);
    const normalize = file => platform === "win32" ? paths.resolve(file).toLowerCase() : paths.resolve(file);
    const ownedGlobal = result.package_root.endsWith(paths.join("node_modules", PACKAGE_NAME));
    result.state = !ownedGlobal ? "checkout" : normalize(result.package_root) === normalize(result.target) ? "matched" : "different";
    return result;
  } catch { return result; } // Preflight cannot replace the installer's normal error handling.
}

export function normalizeUpdateSource(value) {
  const source = String(value || "").trim().toLowerCase();
  if (source === "gh") return "github";
  return Object.hasOwn(UPDATE_SPECS, source) ? source : "";
}

// Read only named, non-secret fields. Never inspect the complete npm config,
// rewrite .npmrc, or probe this policy on the adapter's startup/request path.
export function inspectNpmDownloadPolicy({ env = process.env, platform = process.platform, exec = execFileSync } = {}) {
  const result = { version: null, allowRemote: null, registryOrigin: null, supported: null };
  const query = args => {
    const launch = npmLaunch(args, { platform, env });
    return exec(launch.command, launch.args, { env, shell: false, stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024, ...launch.options }).trim();
  };
  try {
    const version = query(["--version"]);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return result;
    result.version = version;
    if (Number(version.split(".")[0]) < 11) { result.supported = false;return result; }
    const values = Object.fromEntries(query(["config", "get", "--global", "allow-remote", "registry"]).split(/\r?\n/)
      .map(line => /^(allow-remote|registry)=(.*)$/.exec(line)).filter(Boolean).map(match => [match[1], match[2]]));
    if (["all", "none", "root"].includes(values["allow-remote"])) {
      result.allowRemote = values["allow-remote"];result.supported = true;
    } else if (values["allow-remote"] === "undefined") result.supported = false;
    try { const url = new URL(values.registry);if (["https:", "http:"].includes(url.protocol)) result.registryOrigin = url.origin; } catch {}
  } catch { /* A failed readonly probe must not replace npm's own error handling. */ }
  return result;
}

export function globalUpdateCommand(source, { platform = process.platform, releaseTag, releaseFile, allowRemote = false, complete = false } = {}) {
  if (typeof allowRemote !== "boolean") throw new Error("Remote download permission must be a boolean");
  if (typeof complete !== "boolean") throw new Error("Complete-package selection must be a boolean");
  const normalized = normalizeUpdateSource(source);
  if (!normalized) throw new Error(`Choose npm or github. Received: ${source}`);
  const args = ["install", "--global"];
  if (allowRemote) args.push("--allow-remote=all");
  if (complete) args.push("--offline", "--ignore-scripts", "--no-audit", "--no-fund");
  if (normalized === "github") {
    if (!githubReleaseVersion(releaseTag)) throw new Error("A valid stable GitHub release tag is required");
    const version = githubReleaseVersion(releaseTag), name = `codex-copilot-dx-${version}.tgz`;
    const runtimeNames = ["darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64", "linux-x64-glibc", "linux-arm64-glibc", "linux-x64-musl", "linux-arm64-musl"]
      .map(target => `./codex-copilot-dx-${version}-${target}.tgz`);
    if (releaseFile !== undefined && releaseFile !== `./${name}` && !(complete && runtimeNames.includes(releaseFile))) throw new Error("Invalid verified release filename");
    args.push(releaseFile || `${UPDATE_SPECS.github}/v${version}/${name}`);
  } else {
    args.push(UPDATE_SPECS[normalized]);
  }
  return {
    command: platform === "win32" ? "npm.cmd" : "npm",
    args,
    source: normalized,
  };
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let settled = false, exited = false, ended = !child.stderr, failure, tail = "", denied = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    const complete = () => { if (exited && ended) {
      if (failure) { if (denied) failure.npmCode = "EALLOWREMOTE";finish(reject, failure); }
      else finish(resolve);
    } };
    child.stderr?.on("data", bytes => {
      process.stderr.write(bytes);const text = tail + bytes.toString();
      if (/npm (?:error|ERR!) code EALLOWREMOTE\b/.test(text)) denied = true;
      tail = text.slice(-64);
    });
    const end = () => { ended = true;complete(); };
    child.stderr?.once("end", end);child.stderr?.once("close", end);child.stderr?.once("error", end);
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      exited = true;
      if (signal) failure = new Error(`npm update was interrupted by ${signal}`);
      else if (code !== 0) failure = Object.assign(new Error(`npm update exited with status ${code}`), { npmExitCode: code });
      complete();
    });
  });
}

export function verifyInstalledPackage(target, { expectedVersion } = {}) {
  if (!target) return null;
  let pkg;
  try { pkg = JSON.parse(readBoundedFileSync(path.join(target, "package.json"), { encoding: "utf8" })); } catch {}
  if (pkg?.name !== PACKAGE_NAME || !githubReleaseVersion(pkg.version)
    || (expectedVersion && pkg.version !== expectedVersion)) {
    throw new Error("npm finished, but the target package version could not be verified. Check ccdx doctor; installation was not retried.");
  }
  return pkg.version;
}

export async function runPackageUpdateCommand({
  commandName = "ccdx",
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  platform = process.platform,
  prompt,
  source,
  allowRemote = false,
  spawnImpl = spawn,
  fetchImpl = fetch,
  inspectEnvironmentFn = inspectPackageUpdateEnvironment,
  inspectPolicyFn = inspectNpmDownloadPolicy,
  verifyInstalledFn = verifyInstalledPackage,
  repairCommandFn,
  downloadReleaseFn = downloadRelease,
  protectInstallationFn = protectInstallation,
  verifyRuntimeFn = verifyPackageRuntime,
} = {}) {
  if (typeof allowRemote !== "boolean") throw new Error("Remote download permission must be a boolean");
  let selectedSource = normalizeUpdateSource(source);
  if (source && !selectedSource) throw new Error(`Choose npm or github. Received: ${source}`);

  if (!selectedSource) {
    if (!prompt && (!input.isTTY || !output.isTTY)) {
      throw new Error(`Choose a source with ${commandName} update npm or ${commandName} update github`);
    }

    output.write(`${commandName} update\n`);
    output.write("  1. npm registry [default]\n");
    output.write("  2. GitHub release\n");

    let readline;
    const ask = prompt || (async (question) => {
      readline ||= createInterface({ input, output });
      return readline.question(question);
    });
    try {
      while (!selectedSource) {
        const answer = String(await ask("Choose update source [1], or q to cancel: ") || "").trim().toLowerCase();
        if (answer === "q" || answer === "quit") {
          output.write("No changes made.\n");
          return { cancelled: true, source: "" };
        }
        if (answer === "" || answer === "1" || answer === "npm") selectedSource = "npm";
        else if (answer === "2" || answer === "github" || answer === "gh") selectedSource = "github";
        else output.write("Enter 1 for npm, 2 for GitHub, or q to cancel.\n");
      }
    } finally {
      readline?.close();
    }
  }

  const environment = inspectEnvironmentFn({ env, platform });
  if (selectedSource === "github" && fetchImpl === globalThis.fetch) {
    let npmCli;
    try {
      npmCli = platform === "win32" ? path.win32.join(path.win32.dirname(environment.npm), "node_modules", "npm", "bin", "npm-cli.js") : fs.realpathSync(environment.npm);
    } catch { throw new Error("Cannot locate npm for verified Release downloads. Use an approved local package or the platform installer."); }
    fetchImpl = createNpmReleaseFetch(npmCli, { env });
  }
  let release;
  if (selectedSource === "github") {
    output.write("Checking the latest stable GitHub release...\n");
    release = await lookupLatestRelease({ fetchImpl, timeoutMs: 10000 });
  }
  const policy = inspectPolicyFn({ env, platform });
  if (allowRemote && policy.supported === null) throw new Error("Could not verify npm's remote-download option; no installation was started. Check npm --version and npm config get allow-remote.");
  const permitRemote = allowRemote && policy.supported === true;
  let directory, artifact;
  if (release) {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-update-"));
    try { artifact = await downloadReleaseFn(release.tagName, { fetchImpl, directory }); }
    catch (error) { fs.rmSync(directory, { recursive: true, force: true });throw error; }
    output.write("Release package verified; Git is not required. Dependencies use the configured npm registry.\n");
  }
  try {
  const sourceLabel = selectedSource === "npm" ? "npm registry" : `GitHub release ${release.tagName}`;
  output.write(`Updating ${PACKAGE_NAME} from ${sourceLabel}...\n`);
  if (policy.allowRemote) output.write(`npm ${terminalCell(policy.version)}: saved allow-remote=${policy.allowRemote}${policy.registryOrigin ? `; registry ${terminalCell(policy.registryOrigin)}` : ""}.\n`);
  if (permitRemote) output.write("Explicit permission for this update only: npm may download URL dependencies throughout the selected package's dependency tree. Registry and persistent npm settings are unchanged.\n");
  else if (allowRemote) output.write("This npm does not expose the remote-download restriction; no unsupported permission flag was added.\n");
  if (environment?.state === "different") {
    output.write(`Warning: npm targets ${terminalCell(environment.target)}, not the running package at ${terminalCell(environment.package_root)}. Existing PATH and prefix choices were preserved.\n`);
  }
  // The verified tarball basename is fixed and safe for cmd.exe. Its directory
  // is passed as cwd, never interpolated into the Windows command string.
  const brokerRequired = Boolean(environment?.target && fs.existsSync(path.join(environment.target, "node_modules", "@azure", "msal-node-runtime")));
  const install = async item => {
  const update = globalUpdateCommand(selectedSource, { platform, releaseTag: release?.tagName,
    releaseFile: item ? `./${item.name}` : undefined, allowRemote: permitRemote && !item?.complete, complete: item?.complete === true });
  const launch = npmLaunch(update.args, { platform, env });
  const transaction = protectInstallationFn({ ...environment, platform });
  let version;
  try {
  const child = spawnImpl(launch.command, launch.args, {
    env,
    ...(directory ? { cwd: directory } : {}),
    shell: false,
    stdio: ["inherit", "inherit", "pipe"],
    ...launch.options,
  });
  try { await waitForExit(child); }
  catch (error) {
    if (Number.isInteger(error.npmExitCode) && !allowRemote && ["none", "root"].includes(policy.allowRemote)) {
      error.message += `. npm allow-remote=${policy.allowRemote} was preserved. If npm reported EALLOWREMOTE, its registry/mirror tarball URL was refused; only if you trust this update and policy permits it, retry explicitly with ${terminalCell(commandName)} update ${selectedSource} --allow-remote. This grants URL downloads to this installation's dependency tree, not just one hostname. No permission or config change was made.`;
    }
    throw error;
  }
  version = verifyInstalledFn(environment?.target, { expectedVersion: release?.version });
  if (environment?.target && version) verifyRuntimeFn(environment.target, version, { brokerRequired });
  if (env.CCDX_PRIVATE_INSTALL_PREFIX && environment?.prefix && (platform === "win32" ? path.win32.resolve(env.CCDX_PRIVATE_INSTALL_PREFIX).toLowerCase() === path.win32.resolve(environment.prefix).toLowerCase() : path.resolve(env.CCDX_PRIVATE_INSTALL_PREFIX) === path.resolve(environment.prefix))) await writePrivateLaunchers(environment);
  transaction.commit();
  return version;
  } catch (error) { transaction.rollback();throw error; }
  };
  let installedVersion;
  try { installedVersion = await install(artifact); }
  catch (error) {
    if (selectedSource !== "github" || allowRemote || !remoteDownloadDenied(error)) throw error;
    output.write("npm refused a remote dependency. Previous installation restored; checking the same version's complete platform package.\n");
    try { artifact = await downloadReleaseFn(release.tagName, { fetchImpl, directory, complete: true, platform }); }
    catch (fallbackError) { error.message += ` Complete platform package unavailable: ${fallbackError.message}`;throw error; }
    if (!artifact.complete) throw new Error("The fallback is not a verified complete platform package; no second installation was started");
    output.write("Complete platform package verified; installing offline with the saved npm policy.\n");
    installedVersion = await install(artifact);
  }
  if (installedVersion) {
    output.write(`Updated ${PACKAGE_NAME}: installed v${terminalCell(installedVersion)} at ${terminalCell(environment.target)}.\n`);
    if (platform === "win32") {
      try {
        const repair = repairCommandFn || (await import("./windows-command.mjs")).inspectWindowsCommand;
        const result = repair({ platform, packageRoot: environment.target, repair: true });
        if (result.status !== "ready") output.write("Command launcher was preserved; use ccdx.cmd doctor --fix to inspect it. PowerShell policy is unchanged.\n");
      } catch { output.write("Installed package verified; optional command setup could not finish. Use ccdx.cmd doctor --fix.\n"); }
    }
  } else {
    output.write("Installer finished; the global target was unavailable, so the installed version was not verified. Run ccdx doctor.\n");
  }
  output.write("Restart the running adapter to use the installed version; an existing service is not replaced automatically.\n");
  return { cancelled: false, source: selectedSource };
  } finally { if (directory) fs.rmSync(directory, { recursive: true, force: true }); }
}
