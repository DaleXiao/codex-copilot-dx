import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { lookupLatestRelease, githubReleaseVersion } from "./version.mjs";
import { terminalCell } from "./terminal-text.mjs";

const PACKAGE_NAME = "codex-copilot-dx";
const UPDATE_SPECS = {
  npm: `${PACKAGE_NAME}@latest`,
  github: "github:DaleXiao/codex-copilot-dx",
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

export function globalUpdateCommand(source, { platform = process.platform, releaseTag } = {}) {
  const normalized = normalizeUpdateSource(source);
  if (!normalized) throw new Error(`Update source must be npm or github: ${source}`);
  const args = ["install", "--global"];
  if (normalized === "github") {
    if (!githubReleaseVersion(releaseTag)) throw new Error("A valid stable GitHub release tag is required");
    args.push("--allow-git=all", `${UPDATE_SPECS.github}#${releaseTag}`);
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
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      if (signal) finish(reject, new Error(`npm update was interrupted by ${signal}`));
      else if (code !== 0) finish(reject, new Error(`npm update exited with status ${code}`));
      else finish(resolve);
    });
  });
}

export async function runPackageUpdateCommand({
  commandName = "ccdx",
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  platform = process.platform,
  prompt,
  source,
  spawnImpl = spawn,
  fetchImpl = fetch,
  inspectEnvironmentFn = inspectPackageUpdateEnvironment,
} = {}) {
  let selectedSource = normalizeUpdateSource(source);
  if (source && !selectedSource) throw new Error(`Update source must be npm or github: ${source}`);

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
        const answer = String(await ask("Select update source [1], or q to cancel: ") || "").trim().toLowerCase();
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

  let release;
  if (selectedSource === "github") {
    output.write("Checking the latest stable GitHub release...\n");
    release = await lookupLatestRelease({ fetchImpl, timeoutMs: 10000 });
  }
  const update = globalUpdateCommand(selectedSource, { platform, releaseTag: release?.tagName });
  const sourceLabel = selectedSource === "npm" ? "npm registry" : `GitHub release ${release.tagName}`;
  output.write(`Updating ${PACKAGE_NAME} from ${sourceLabel}...\n`);
  const environment = inspectEnvironmentFn({ env, platform });
  if (environment?.state === "different") {
    output.write(`Warning: npm targets ${terminalCell(environment.target)}, not the running package at ${terminalCell(environment.package_root)}. Existing PATH and prefix choices were preserved.\n`);
  }
  // npm.cmd needs cmd.exe. Only fixed install arguments and a validated stable
  // release tag enter this command line; no user-supplied command is evaluated.
  const launch = npmLaunch(update.args, { platform, env });
  const child = spawnImpl(launch.command, launch.args, {
    env,
    shell: false,
    stdio: "inherit",
    ...launch.options,
  });
  await waitForExit(child);
  output.write(`Updated ${PACKAGE_NAME} from ${sourceLabel}. Restart the running adapter to use the new version.\n`);
  return { cancelled: false, source: selectedSource };
}
