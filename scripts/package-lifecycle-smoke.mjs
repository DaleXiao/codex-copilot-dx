import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// CI-only real install/upgrade in an owned prefix. No user installation or provider calls.
const cwd = fileURLToPath(new URL("../", import.meta.url));
const npm = process.env.npm_execpath;
if (!npm || !path.isAbsolute(npm)) throw new Error("Run through npm run test:package");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-package-lifecycle-"));
const prefix = path.join(root, "test prefix");
const cache = path.join(root, "npm-cache");
const runNpm = args => execFileSync(process.execPath, [npm, ...args], {
  cwd, encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, npm_config_prefix: prefix, npm_config_cache: cache },
});
const packageRoot = path.join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "codex-copilot-dx");
const version = () => execFileSync(process.execPath, [path.join(packageRoot, "bin", "cli.mjs"), "version"], { encoding: "utf8", timeout: 10000 }).trim();
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--baseline" || !path.isAbsolute(args[1]) || !fs.statSync(args[1]).isFile())) throw new Error("Use --baseline /absolute/path/to/0.9.41.tgz for a local baseline artifact");
try {
  const install = spec => runNpm(["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", spec]);
  install(args[1] || "codex-copilot-dx@0.9.41");
  assert.match(version(), /ccdx v0\.9\.41 /);
  const expected = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version;
  const result = JSON.parse(runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", root]));
  // npm 10/11 return an array; npm 12 keys pack results by package name.
  const packed = Array.isArray(result) ? result : Object.values(result);
  assert.equal(packed.length, 1);
  assert.equal(packed[0].name, "codex-copilot-dx");assert.equal(packed[0].version, expected);
  assert.equal(packed[0].filename, `codex-copilot-dx-${expected}.tgz`);
  const artifact = path.join(root, packed[0].filename);
  install(artifact);
  assert.ok(version().startsWith(`ccdx v${expected} `));
  const installed = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(installed.scripts?.postinstall, undefined, "Command convenience must not add an installation script");
  if (process.platform === "win32") {
    const verifyCommand = () => {
      assert.equal(fs.existsSync(path.join(prefix, "ccdx.ps1")), true, "Installation does not bypass npm script policy");
      assert.equal(fs.existsSync(path.join(prefix, "ccdx.cmd")), true);
      const home = path.join(root, "isolated-home");
      const token = path.join(home, ".local", "share", "copilot-api", "github_token");
      fs.mkdirSync(path.dirname(token), { recursive: true });
      fs.writeFileSync(token, "synthetic-package-test-token", { mode: 0o600 });
      const preload = path.join(cwd, "scripts", "replay-fixtures", "config-startup-preload.cjs");
      const env = { ...process.env, PATH: `${prefix};${process.env.PATH || ""}`, npm_config_prefix: prefix,
        NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, CCDX_TEST_HOME: home,
        CODEX_HOME: path.join(home, ".codex"), XDG_CONFIG_HOME: path.join(home, ".config"),
        CCDX_DISABLE_TOKEN_DISCOVERY: "1", CCDX_AUTO_LAUNCH: "0", CCDX_LOG_PATH: "" };
      const shells = [path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe")];
      const repair = execFileSync(shells[0], ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Restricted", "-Command",
        "$ErrorActionPreference='Stop';ccdx.cmd doctor --fix --json;if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}"], {
        env, encoding: "utf8", timeout: 45000, maxBuffer: 1024 * 1024,
      });
      const receipt = JSON.parse(repair.trim());
      assert.equal(receipt.checks.find(check => check.id === "windows-command").result, "fixed_verified");
      assert.equal(fs.existsSync(path.join(prefix, "ccdx.ps1")), false, "Explicit doctor repairs the exact npm-owned shim");
      for (const shell of shells.filter(file => fs.existsSync(file))) {
        const result = execFileSync(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Restricted", "-Command",
          "$ErrorActionPreference='Stop';if((Get-Command ccdx).Source -notlike '*.cmd'){throw 'Unexpected command entry'};ccdx version;if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}"], {
          env, encoding: "utf8", timeout: 15000,
        });
        assert.ok(result.includes(`ccdx v${expected}`));
      }
    };
    verifyCommand();
    // A fresh install has the same lifecycle timing as the upgrade above.
    runNpm(["uninstall", "--global", "--ignore-scripts", "codex-copilot-dx"]);
    install(artifact);verifyCommand();
  }
  const checkNative = `const {createRequire}=require('node:module');const sharp=createRequire(${JSON.stringify(path.join(packageRoot, "package.json"))})('sharp');sharp({create:{width:8,height:8,channels:3,background:'white'}}).png().toBuffer({resolveWithObject:true}).then(({info})=>{if(info.width!==8)process.exit(1)}).catch(()=>process.exit(1));`;
  execFileSync(process.execPath, ["-e", checkNative], { encoding: "utf8", timeout: 30000 });
  if (["darwin", "win32"].includes(process.platform)) {
    const checkBroker = `const {createRequire}=require('node:module');const sdk=createRequire(${JSON.stringify(path.join(packageRoot, "package.json"))})('@azure/msal-node-runtime');if(!sdk.msalNodeRuntime)process.exit(1);`;
    execFileSync(process.execPath, ["-e", checkBroker], { encoding: "utf8", timeout: 30000 });
  }
  console.log(`Package lifecycle: 0.9.41 -> ${expected}; isolated prefix; installed sharp and supported broker load work (${process.platform}/${process.arch}).`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
