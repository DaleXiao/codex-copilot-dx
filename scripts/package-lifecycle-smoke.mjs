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
  const install = spec => runNpm(["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", spec]);
  install("codex-copilot-dx@0.9.31");
  assert.match(version(), /ccdx v0\.9\.31 /);
  const packed = JSON.parse(runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", root]));
  assert.equal(packed.length, 1);
  const artifact = path.join(root, packed[0].filename);
  install(artifact);
  const expected = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version;
  assert.ok(version().startsWith(`ccdx v${expected} `));
  const checkNative = `const {createRequire}=require('node:module');const sharp=createRequire(${JSON.stringify(path.join(packageRoot, "package.json"))})('sharp');sharp({create:{width:8,height:8,channels:3,background:'white'}}).png().toBuffer({resolveWithObject:true}).then(({info})=>{if(info.width!==8)process.exit(1)}).catch(()=>process.exit(1));`;
  execFileSync(process.execPath, ["-e", checkNative], { encoding: "utf8", timeout: 30000 });
  console.log(`Package lifecycle: 0.9.31 -> ${expected}; isolated prefix; installed sharp works (${process.platform}/${process.arch}).`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
