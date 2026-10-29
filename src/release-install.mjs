// Also shipped as the standalone bootstrap helper. Keep imports built-in only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RELEASE_BASE = "https://github.com/DaleXiao/codex-copilot-dx/releases/download";
export function stableVersion(tag) {
  const match = typeof tag === "string" && tag.length <= 64 && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  return match && match.slice(1).every(part => Number.isSafeInteger(Number(part))) ? match.slice(1).join(".") : null;
}
// Use the downloader already shipped with the selected npm, rather than adding
// a second runtime dependency or bypassing its proxy/CA/offline settings.
export function createNpmReleaseFetch(npmCli, { env = process.env, exec = execFileSync } = {}) {
  try {
    const npmFetch = createRequire(npmCli)("make-fetch-happen");
    const keys = ["https-proxy", "proxy", "noproxy", "cafile", "strict-ssl", "offline"];
    const output = exec(process.execPath, [npmCli, "config", "get", "--global", ...keys], {
      env, encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    const values = Object.fromEntries(output.trim().split(/\r?\n/).map(line => /^(https-proxy|proxy|noproxy|cafile|strict-ssl|offline)=(.*)$/.exec(line)).filter(Boolean).map(match => [match[1], match[2]]));
    if (values.offline === "true") throw new Error("offline");
    const present = value => value && !["null", "undefined"].includes(value) ? value : undefined;
    const caFile = present(values.cafile);let ca;
    if (caFile) {
      if (!fs.statSync(caFile).isFile() || fs.statSync(caFile).size > 1024 * 1024) throw new Error("CA file");
      ca = fs.readFileSync(caFile, "utf8");
    }
    return async (url, options = {}) => {
      try {
        const response = await npmFetch(url, { ...options, retry: 0, cache: "no-store", ca,
          proxy: present(values["https-proxy"]) || present(values.proxy) || env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY,
          noProxy: present(values.noproxy) || env.no_proxy || env.NO_PROXY,
          strictSSL: values["strict-ssl"] !== "false" });
        const body = [204, 205, 304].includes(response.status) ? null : Readable.toWeb(Readable.from(response.body));
        const result = new Response(body, { status: response.status, headers: Object.fromEntries(response.headers) });
        Object.defineProperty(result, "url", { value: response.url });return result;
      } catch { throw new Error("Release download failed. Check the configured npm proxy, CA file and approved GitHub access; no fallback was attempted."); }
    };
  } catch (error) {
    if (error.message === "offline") throw new Error("npm offline mode is enabled. Use an approved local Release package/cache; no download was started.");
    throw new Error("Could not use this npm's download component or network settings. Keep its proxy/CA policy; use an approved local Release package or a complete supported npm distribution.");
  }
}

export async function releaseBytes(url, { fetchImpl = fetch, maxBytes, timeoutMs = 60000, signal } = {}) {
  const response = await fetchImpl(url, { redirect: "follow", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "codex-copilot-dx", Accept: "application/octet-stream" } });
  const final = response.url && new URL(response.url);
  if (!response.ok || final && (final.protocol !== "https:" || !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(final.hostname))) {
    await response.body?.cancel();throw new Error(`Release download refused (HTTP ${response.status}). Check company proxy, certificates and approved download access. No fallback was attempted.`);
  }
  const chunks = [];let size = 0;
  try {
    for await (const chunk of response.body || []) {
      size += chunk.length;if (size > maxBytes) throw new Error("Release download exceeds its size limit");chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } catch (error) { throw new Error("Release download did not finish; the existing installation was preserved", { cause: error }); }
}
export function releaseChecksum(manifest, name) {
  const lines = manifest.toString("utf8").split(/\r?\n/).filter(line => line.endsWith(`  ${name}`));
  if (lines.length !== 1 || !/^[a-f0-9]{64}  [\w.-]+$/.test(lines[0])) throw new Error("Release checksum is missing or invalid");
  return lines[0].slice(0, 64);
}
export function packageMetadata(bytes, { complete = false } = {}) {
  const tar = gunzipSync(bytes, { maxOutputLength: (complete ? 256 : 64) * 1024 * 1024 });
  let metadata;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512), name = header.subarray(0, 100).toString().replace(/\0.*$/s, "");
    if (!name) break;
    const sizeText = header.subarray(124, 136).toString().replace(/\0.*$/s, "").trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("Invalid release package header");
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || offset + 512 + size > tar.length) throw new Error("Invalid release package size");
    if (name === "package/package.json") {
      if (metadata || size > 65536 || ![0, 48].includes(header[156])) throw new Error("Invalid release package metadata");
      metadata = JSON.parse(tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (metadata?.name !== "codex-copilot-dx" || !stableVersion(metadata.version)) throw new Error("Release package identity is invalid");
  return metadata;
}
export function runtimeReleaseTarget({ platform = process.platform, arch = process.arch } = {}) {
  if (!["darwin", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) {
    throw new Error("CCDX supports macOS and Windows on x64 or arm64");
  }
  return `${platform}-${arch}`;
}
export function remoteDownloadDenied(error) {
  return error?.npmCode === "EALLOWREMOTE" || /(?:^|\n)npm (?:error|ERR!) code EALLOWREMOTE(?:\r?\n|$)/.test(String(error?.stderr || ""));
}
export async function downloadRelease(tag, { fetchImpl = fetch, directory, signal, complete = false, preferComplete = false, platform, arch } = {}) {
  const target = runtimeReleaseTarget({ platform, arch });
  const version = stableVersion(tag);if (!version) throw new Error("A valid stable GitHub release tag is required");
  const base = `${RELEASE_BASE}/v${version}`;
  const manifest = await releaseBytes(`${base}/SHA256SUMS`, { fetchImpl, maxBytes: 65536, signal });
  let name = `codex-copilot-dx-${version}.tgz`;
  if (complete || preferComplete) {
    if (target) {
      const runtimeName = `codex-copilot-dx-${version}-${target}.tgz`;
      if (complete || manifest.toString("utf8").split(/\r?\n/).some(line => line.endsWith(`  ${runtimeName}`))) { name = runtimeName;complete = true; }
    }
  }
  const expected = releaseChecksum(manifest, name);
  const bytes = await releaseBytes(`${base}/${name}`, { fetchImpl, maxBytes: (complete ? 64 : 16) * 1024 * 1024, signal });
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Release checksum mismatch; no installation was started");
  const metadata = packageMetadata(bytes, { complete });
  if (metadata.version !== version) throw new Error("Release package version does not match its tag");
  if (complete && (metadata.ccdx_runtime?.schema !== 1 || metadata.ccdx_runtime.target !== target
    || !Array.isArray(metadata.bundleDependencies) || !["sharp", "smol-toml", "@azure/msal-node-runtime"].every(name => metadata.bundleDependencies.includes(name)))) {
    throw new Error("Complete Release package does not match this runtime or lacks bundled dependencies");
  }
  const file = path.join(directory, name);fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });return { file, name, version, complete };
}

// Preserve only this package and its command entries. Never snapshot credentials
// or change npm settings. A busy/readonly Windows installation fails in place.
export function protectInstallation({ target, prefix, platform = process.platform } = {}) {
  if (!target || !prefix) return { commit() {}, rollback() {} };
  const parent = path.dirname(target);fs.mkdirSync(parent, { recursive: true });
  const lock = path.join(parent, ".ccdx-install.lock");let fd;
  try { fd = fs.openSync(lock, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another install may be running. CCDX install lock: ${lock}. Inspect its owner and .ccdx-backup-* in ${parent} before recovery; do not remove an active install lock.`, { cause: error });
    throw new Error(`Cannot create the CCDX install lock at ${lock} (${error.code || "I/O error"}). Check directory permissions and free space; no installation was started.`, { cause: error });
  }
  let backup;
  try {
    backup = fs.mkdtempSync(path.join(parent, ".ccdx-backup-"));
    fs.writeFileSync(fd, JSON.stringify({ version: 1, pid: process.pid, created_at: new Date().toISOString(), backup }) + "\n");
  } catch (error) { if (backup) fs.rmSync(backup, { recursive: true, force: true });fs.closeSync(fd);fs.unlinkSync(lock);throw error; }
  const entries = [target, ...["ccdx", "codex-copilot-dx"].flatMap(name => platform === "win32"
    ? [name, `${name}.cmd`, `${name}.ps1`].map(file => path.join(prefix, file)) : [path.join(prefix, "bin", name)])];
  const saved = [];
  const closeLock = () => { if (fd !== undefined) { const handle = fd;fd = undefined;fs.closeSync(handle); } };
  const copyEntry = (from, to) => {
    if (fs.lstatSync(from).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  };
  const clean = () => { fs.rmSync(backup, { recursive: true, force: true });closeLock();fs.unlinkSync(lock); };
  try {
    entries.forEach((file, index) => {
      let stat;try { stat = fs.lstatSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (file === target && stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("The npm target is linked or not a regular installation; use its owning installer");
      const copy = path.join(backup, String(index));
      if (stat) copyEntry(file, copy);
      saved.push({ file, copy, existed: Boolean(stat) });
    });
  } catch (error) { clean();throw error; }
  let finalized = false;
  return {
    commit() {
      if (finalized) return;
      finalized = true;
      try { clean(); }
      catch { console.error(`CCDX was installed, but backup cleanup needs attention: ${backup}; check ${lock} before retrying.`); }
    },
    rollback() {
      if (finalized) return;
      try {
        for (const { file, copy, existed } of saved) {
          fs.rmSync(file, { recursive: true, force: true });
          if (existed) copyEntry(copy, file);
        }
      } catch (error) {
        closeLock();
        throw new Error(`Restore could not finish. Previous package and commands remain at ${backup}; do not delete the install lock until restored.`, { cause: error });
      }
      finalized = true;
      try { clean(); }
      catch { console.error(`Previous CCDX was restored, but backup cleanup needs attention: ${backup}; check ${lock} before retrying.`); }
    },
  };
}

export function verifyPackageRuntime(target, version, { brokerRequired = false } = {}) {
  const code = `const {createRequire}=require('node:module');const r=createRequire(${JSON.stringify(path.join(target, "package.json"))});const pkg=r('./package.json');if(pkg.name!=='codex-copilot-dx'||pkg.version!==${JSON.stringify(version)})throw Error('Version mismatch');r('sharp')({create:{width:1,height:1,channels:3,background:'white'}}).png().toBuffer().then(()=>{${brokerRequired ? "if(!r('@azure/msal-node-runtime').msalNodeRuntime)throw Error('Native broker unavailable');" : ""}}).catch(e=>{console.error(e.message);process.exitCode=1});`;
  execFileSync(process.execPath, ["-e", code], { timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
  const output = execFileSync(process.execPath, [path.join(target, "bin", "cli.mjs"), "version"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
  if (!output.includes(`ccdx v${version} `)) throw new Error("Installed command version could not be verified");
}

export function privateUnixLauncher({ prefix, target, name, node = process.execPath }) {
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const cli = path.join(target, "bin", "cli.mjs");
  return `#!/bin/sh\nPATH=${quote(path.dirname(node))}:"$PATH"\nexport PATH\nCCDX_PRIVATE_INSTALL_PREFIX=${quote(prefix)}\nexport CCDX_PRIVATE_INSTALL_PREFIX\nif [ -z "\${npm_config_prefix:-}\${NPM_CONFIG_PREFIX:-}" ]; then npm_config_prefix=${quote(prefix)}; export npm_config_prefix; fi\nexec ${quote(node)} ${quote(cli)} "$@"\n`;
}
export async function writePrivateLaunchers({ prefix, target }) {
  const windows = process.platform === "win32"
    ? await import(pathToFileURL(path.join(target, "src", "windows-command.mjs")).href) : null;
  for (const name of ["ccdx"]) {
    const cli = path.join(target, "bin", "cli.mjs");
    if (windows) {
      fs.writeFileSync(path.join(prefix, `${name}.cmd`), windows.privateWindowsCommand({ node: process.execPath, cli, prefix }));
    } else {
      const file = path.join(prefix, "bin", name);fs.rmSync(file, { force: true });
      fs.writeFileSync(file, privateUnixLauncher({ prefix, target, name }), { mode: 0o755 });
    }
  }
  if (windows && windows.inspectWindowsCommand({ packageRoot: target, repair: true }).status !== "ready") throw new Error("Private Windows commands could not be verified");
}

async function bootstrap() {
  const [tag, prefix, npmCli, ...flags] = process.argv.slice(2);
  const permission = flags.includes("--allow-remote"), privateRuntime = flags.includes("--private-runtime");
  if (!stableVersion(tag) || !prefix || !path.isAbsolute(prefix) || !npmCli || !path.isAbsolute(npmCli) || flags.some(flag => !["--allow-remote", "--private-runtime"].includes(flag))) throw new Error("Use: node ccdx-install.mjs vVERSION /absolute/prefix /absolute/npm-cli.js [--allow-remote]");
  const target = path.join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "codex-copilot-dx");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-install-"));let transaction;
  try {
    const release = await downloadRelease(tag, { directory, fetchImpl: createNpmReleaseFetch(npmCli), preferComplete: true });
    transaction = protectInstallation({ target, prefix });
    const npmVersion = execFileSync(process.execPath, [npmCli, "--version"], { encoding: "utf8", timeout: 10000 }).trim();
    const args = [npmCli, "install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund"];
    if (release.complete) args.push("--offline");
    else if (permission && Number(npmVersion.split(".")[0]) >= 12) args.push("--allow-remote=all");
    args.push(release.file);
    execFileSync(process.execPath, args, { stdio: "inherit", timeout: 300000 });
    verifyPackageRuntime(target, release.version, { brokerRequired: ["darwin", "win32"].includes(process.platform) });
    if (privateRuntime || process.platform === "win32") await writePrivateLaunchers({ prefix, target });
    transaction.commit();transaction = null;
    console.log(`Installed CCDX ${release.version}. Existing services keep running until restarted.`);
  } catch (error) {
    transaction?.rollback();throw new Error("Installation failed. Previous CCDX package and commands were restored. Check the Release package, platform, proxy, certificates and npm policy. Older source-only releases still need registry access.", { cause: error });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && path.basename(process.argv[1]) === "ccdx-install.mjs" && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await bootstrap(); } catch (error) { console.error(error.message);if (error.cause) console.error(error.cause.message);process.exitCode = 1; }
}
