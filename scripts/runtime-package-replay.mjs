// An empty-cache, offline install must load the actual packaged native modules.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyPackageRuntime, runtimeReleaseTarget, packageMetadata } from "../src/release-install.mjs";
const directory = process.argv[2], npm = process.argv[3] || process.env.npm_execpath;
if (!path.isAbsolute(directory || "") || !path.isAbsolute(npm || "")) throw Error("Supply the artifact directory and npm CLI path");
const source = JSON.parse(fs.readFileSync(path.join(directory, "package-manifest.json")));
const asset = path.join(directory, `codex-copilot-dx-${source.version}-${runtimeReleaseTarget()}.tgz`), metadata = packageMetadata(fs.readFileSync(asset), { complete: true });
if (metadata.ccdx_runtime?.target !== runtimeReleaseTarget()) throw Error("Wrong platform package");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-runtime-replay-")), prefix = path.join(root, "prefix"), cache = path.join(root, "empty-cache");
try {
  const args = [npm, "install", "--global", "--prefix", prefix, "--cache", cache, "--offline", "--ignore-scripts", "--no-audit", "--no-fund"];
  const version = execFileSync(process.execPath, [npm, "--version"], { encoding: "utf8" }).trim();
  if (Number(version.split(".")[0]) >= 12) args.push("--allow-remote=none", "--allow-git=none");
  args.push(asset);execFileSync(process.execPath, args, { stdio: "pipe", timeout: 90000 });
  const target = path.join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules/codex-copilot-dx");
  verifyPackageRuntime(target, source.version, { brokerRequired: ["darwin", "win32"].includes(process.platform) });
  // Loading the native addon directly also catches a missing binary hidden by a
  // Broker fallback object on a CI machine without an enrolled company account.
  if (["darwin", "win32"].includes(process.platform)) {
    const system = process.platform === "darwin" ? "macos" : "windows";
    const native = path.join(target, "node_modules/@azure/msal-node-runtime/dist", system, process.arch, "msal-node-runtime.node");
    execFileSync(process.execPath, ["-e", `try{require(${JSON.stringify(native)})}catch(e){if(!Number.isInteger(e.errorStatus))throw e;}`], { stdio: "pipe", timeout: 15000 });
  }
  console.log(JSON.stringify({ target: runtimeReleaseTarget(), npm: version, offline_empty_cache: true, native_modules: true, version: source.version, compressed_bytes: fs.statSync(asset).size }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
