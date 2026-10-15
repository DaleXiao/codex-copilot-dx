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
try {
  const install = (spec, scripts = false) => runNpm(["install", "--global", `--ignore-scripts=${!scripts}`, "--no-audit", "--no-fund", spec]);
  install("codex-copilot-dx@0.9.31");
  assert.match(version(), /ccdx v0\.9\.31 /);
  const expected = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version;
  const result = JSON.parse(runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", root]));
  // npm 10/11 return an array; npm 12 keys pack results by package name.
  const packed = Array.isArray(result) ? result : Object.values(result);
  assert.equal(packed.length, 1);
  assert.equal(packed[0].name, "codex-copilot-dx");assert.equal(packed[0].version, expected);
  assert.equal(packed[0].filename, `codex-copilot-dx-${expected}.tgz`);
  const artifact = path.join(root, packed[0].filename);
  install(artifact, true);
  assert.ok(version().startsWith(`ccdx v${expected} `));
  if (process.platform === "win32") {
    const verifyCommand = () => {
      assert.equal(fs.existsSync(path.join(prefix, "ccdx.ps1")), false, "postinstall removes the exact npm PS shim");
      assert.equal(fs.existsSync(path.join(prefix, "ccdx.cmd")), true);
      const shells = [path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe")];
      for (const shell of shells.filter(file => fs.existsSync(file))) {
        const result = execFileSync(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Restricted", "-Command",
          "$ErrorActionPreference='Stop';if((Get-Command ccdx).Source -notlike '*.cmd'){throw 'Unexpected command entry'};ccdx version;if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}"], {
          env: { ...process.env, PATH: `${prefix};${process.env.PATH || ""}` }, encoding: "utf8", timeout: 15000,
        });
        assert.ok(result.includes(`ccdx v${expected}`));
      }
    };
    verifyCommand();
    // A fresh install has the same lifecycle timing as the upgrade above.
    runNpm(["uninstall", "--global", "--ignore-scripts", "codex-copilot-dx"]);
    install(artifact, true);verifyCommand();
  }
  const checkNative = `const {createRequire}=require('node:module');const sharp=createRequire(${JSON.stringify(path.join(packageRoot, "package.json"))})('sharp');sharp({create:{width:8,height:8,channels:3,background:'white'}}).png().toBuffer({resolveWithObject:true}).then(({info})=>{if(info.width!==8)process.exit(1)}).catch(()=>process.exit(1));`;
  execFileSync(process.execPath, ["-e", checkNative], { encoding: "utf8", timeout: 30000 });
  console.log(`Package lifecycle: 0.9.31 -> ${expected}; isolated prefix; installed sharp works (${process.platform}/${process.arch}).`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
