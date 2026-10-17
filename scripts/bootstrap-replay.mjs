// Run real npm and the platform bootstrap with Git absent from PATH. Downloads
// official Node only in the no-Node case; Release delivery is a loopback fixture.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const run = promisify(execFile), root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-bootstrap-replay-"));
const repo = fileURLToPath(new URL("../", import.meta.url)), windows = process.platform === "win32";
const version = JSON.parse(fs.readFileSync(path.join(repo, "package.json"))).version;
const npmCli = process.env.npm_execpath || fs.realpathSync(execFileSync(windows ? "where.exe" : "/usr/bin/which", [windows ? "npm.cmd" : "npm"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]);
const actualNpm = windows && npmCli.endsWith(".cmd") ? path.join(path.dirname(npmCli), "node_modules", "npm", "bin", "npm-cli.js") : npmCli;
const config = key => execFileSync(process.execPath, [actualNpm, "config", "get", "--global", key], { encoding: "utf8", timeout: 10000 }).trim();
const assets = new Map();let corrupt = false;
const server = http.createServer((req, res) => {
  const name = req.url.split("/").at(-1), bytes = assets.get(name);
  if (!bytes) { res.writeHead(404);res.end();return; }
  res.end(corrupt && name.endsWith(".tgz") ? Buffer.from("corrupt fixture") : bytes);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const packed = JSON.parse(execFileSync(process.execPath, [actualNpm, "pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: repo, encoding: "utf8", timeout: 30000 }));
  const entry = (Array.isArray(packed) ? packed : Object.values(packed))[0];
  assets.set(entry.filename, fs.readFileSync(path.join(root, entry.filename)));
  // Only the test copy accepts a loopback HTTP asset origin. Production checks
  // fixed HTTPS GitHub origins; unit tests reject untrusted redirects and bytes.
  const helper = fs.readFileSync(path.join(repo, "src", "release-install.mjs"), "utf8")
    .replace('https://github.com/DaleXiao/codex-copilot-dx/releases/download', base)
    .replace('final.protocol !== "https:"', 'final.protocol !== "http:"').replace('["github.com",', '["127.0.0.1", "github.com",');
  assets.set("ccdx-install.mjs", Buffer.from(helper));
  assets.set("SHA256SUMS", Buffer.from([...assets].map(([name, bytes]) => `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`).join("")));
  const platformScript = path.join(root, windows ? "install.ps1" : "install.sh");
  fs.writeFileSync(platformScript, fs.readFileSync(path.join(repo, "install", path.basename(platformScript)), "utf8")
    .replace(/https:\/\/github.com\/DaleXiao\/codex-copilot-dx\/releases\/download\/v\$version/g, `${base}/v$version`)
    .replaceAll("--proto '=https' --proto-redir '=https'", "--proto '=https,http' --proto-redir '=https,http'"));
  const tools = path.join(root, "tools"), compatible = path.join(root, "with-node");fs.mkdirSync(tools);fs.mkdirSync(compatible);
  if (windows) {
    fs.copyFileSync(process.execPath, path.join(compatible, "node.exe"));
    fs.writeFileSync(path.join(compatible, "npm.cmd"), '@"%CCDX_REPLAY_NODE%" "%CCDX_REPLAY_NPM%" %*\r\n');
    fs.symlinkSync(path.dirname(path.dirname(path.dirname(actualNpm))), path.join(compatible, "node_modules"), "junction");
  } else {
    for (const name of ["curl", "mktemp", "rm", "cut", "shasum", "sha256sum", "uname", "head", "grep", "ldd", "tar", "gzip", "mkdir", "mv", "awk", "sh"]) {
      try { const file = execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim();fs.symlinkSync(file, path.join(tools, name)); } catch {}
    }
    fs.symlinkSync(process.execPath, path.join(compatible, "node"));fs.symlinkSync(actualNpm, path.join(compatible, "npm"));
  }
  const shells = windows ? [path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    path.join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe")].filter(file => fs.existsSync(file)) : ["/bin/sh"];
  for (const mode of ["with-node", "no-node"]) {
    const home = path.join(root, mode + " 中文 & !"), prefix = path.join(home, "global");fs.mkdirSync(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "local"), XDG_DATA_HOME: path.join(home, "data"),
      CCDX_REPLAY_NODE: process.execPath, CCDX_REPLAY_NPM: actualNpm,
      npm_config_userconfig: config("userconfig"), npm_config_globalconfig: config("globalconfig"), npm_config_registry: config("registry"),
      npm_config_cache: path.join(root, "cache"), npm_config_fetch_retries: "0", CCDX_M365: "0", CCDX_DISABLE_USAGE: "1" };
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path" || key === "NODE_OPTIONS" || key.toLowerCase() === "npm_config_prefix") delete env[key];
    env.PATH = [mode === "with-node" ? compatible : "", tools, windows ? path.join(process.env.SystemRoot, "System32") : ""].filter(Boolean).join(path.delimiter);
    if (mode === "with-node") env.npm_config_prefix = prefix;
    const installedPrefix = mode === "with-node" ? prefix : windows ? path.join(env.LOCALAPPDATA, "CCDX") : path.join(env.XDG_DATA_HOME, "ccdx");
    const invoke = async shell => {
      const args = windows ? ["-NoProfile", "-NonInteractive", "-File", platformScript] : [platformScript];
      return run(shell, args, { env, cwd: home, timeout: 600000, maxBuffer: 2 * 1024 * 1024 });
    };
    for (const shell of shells) {
      if (windows) {
        const unsupportedPrefix = path.join(root, "unsupported%prefix");
        await assert.rejects(run(shell, ["-NoProfile", "-NonInteractive", "-File", platformScript], {
          env: { ...env, npm_config_prefix: unsupportedPrefix }, cwd: home, timeout: 15000 }), error => error.stderr?.includes("without %"));
        assert.equal(fs.existsSync(unsupportedPrefix), false, "Unsupported batch prefix is refused before installation");
      }
      const installed = await invoke(shell);assert.match(installed.stdout, new RegExp(`Installed CCDX ${version.replaceAll(".", "\\.")}`));
      const args = windows ? ["/d", "/s", "/v:off", "/c", '"chcp 437>nul & ccdx.cmd version"'] : ["version"];
      const result = await run(windows ? path.join(process.env.SystemRoot, "System32", "cmd.exe") : path.join(installedPrefix, "bin", "ccdx"), args,
        { env, cwd: installedPrefix, encoding: "utf8", timeout: 15000, ...(windows ? { windowsVerbatimArguments: true } : {}) });
      assert.ok(result.stdout.includes(`ccdx v${version} `));
      if (windows) {
        const bare = await run(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Restricted", "-Command",
          "$env:PATH=$env:CCDX_REPLAY_PREFIX+';'+$env:PATH;ccdx version;if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}"],
          { env: { ...env, CCDX_REPLAY_PREFIX: installedPrefix }, cwd: home, timeout: 15000 });
        assert.ok(bare.stdout.includes(`ccdx v${version} `), "Bootstrap command works directly in PowerShell without a ps1 shim");
      }
      corrupt = true;await assert.rejects(invoke(shell), /Command failed/);corrupt = false;
      const retained = await run(windows ? path.join(process.env.SystemRoot, "System32", "cmd.exe") : path.join(installedPrefix, "bin", "ccdx"), args,
        { env, cwd: installedPrefix, encoding: "utf8", timeout: 15000, ...(windows ? { windowsVerbatimArguments: true } : {}) });
      assert.ok(retained.stdout.includes(`ccdx v${version} `));
      console.log(`Bootstrap: ${process.platform}/${process.arch}/${path.basename(shell)}/${mode}; no Git; installed command, native checks and corrupt-download retention passed.`);
    }
  }
} finally { server.closeAllConnections();await new Promise(resolve => server.close(resolve));fs.rmSync(root, { recursive: true, force: true }); }
