import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { withFileLockSync } from "./lock.mjs";

// Match npm's generated launcher, not an arbitrary script mentioning CCDX.
function npmPowerShellShim(target) {
  return `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  # Fix case when both the Windows and Linux builds of Node
  # are installed in the same directory
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe"  "$basedir/${target}" $args
  } else {
    & "$basedir/node$exe"  "$basedir/${target}" $args
  }
  $ret=$LASTEXITCODE
} else {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "node$exe"  "$basedir/${target}" $args
  } else {
    & "node$exe"  "$basedir/${target}" $args
  }
  $ret=$LASTEXITCODE
}
exit $ret
`;
}

export function privateWindowsCommand({ node, cli, prefix }) {
  const literal = value => value.replaceAll("%", "%%");
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "CCDX_PRIVATE_INSTALL_PREFIX=${literal(prefix)}"\r\nset "PATH=${literal(path.dirname(node))};%PATH%"\r\nif not defined npm_config_prefix set "npm_config_prefix=${literal(prefix)}"\r\n"${literal(node)}" "${literal(cli)}" %*\r\nexit /b %errorlevel%\r\n`;
}

export function inspectWindowsCommand({ platform = process.platform,
  packageRoot = fileURLToPath(new URL("../", import.meta.url)), repair = false, locked = false } = {}) {
  if (platform !== "win32") return { status: "not_applicable", changed: false };
  const root = path.resolve(packageRoot);
  if (path.basename(path.dirname(root)).toLowerCase() !== "node_modules"
    || path.basename(root) !== "codex-copilot-dx") return { status: "checkout", changed: false };
  try {
    const pkg = JSON.parse(readBoundedFileSync(path.join(root, "package.json"), { encoding: "utf8", maxBytes: 64 * 1024 }));
    if (pkg.name !== "codex-copilot-dx" || pkg.bin?.ccdx !== "bin/cli.mjs"
      || pkg.bin?.["codex-copilot-dx"] !== "bin/codex-copilot-dx.mjs") throw new Error();
  } catch { return { status: "preserved", changed: false }; }
  if (repair && !locked) return withFileLockSync(path.join(root, ".ccdx-command.lock"),
    () => inspectWindowsCommand({ platform, packageRoot, repair, locked: true }), { timeoutMs: 1000 });
  const prefix = path.dirname(path.dirname(root));
  const results = [];
  for (const [name, script] of [["ccdx", "cli.mjs"], ["codex-copilot-dx", "codex-copilot-dx.mjs"]]) {
    const ps1 = path.join(prefix, `${name}.ps1`), cmd = path.join(prefix, `${name}.cmd`);
    const target = `node_modules/codex-copilot-dx/bin/${script}`;
    try {
      if (!fs.lstatSync(cmd).isFile() || fs.statSync(cmd).size > 8192) throw new Error();
      const batch = fs.readFileSync(cmd, "utf8");
      const ownedNpm = batch.startsWith("@ECHO off") && batch.includes(`"%dp0%\\${target.replaceAll("/", "\\")}" %*`);
      const ownedPrivate = batch === privateWindowsCommand({ node: process.execPath, cli: path.join(root, "bin", script), prefix });
      if (!ownedNpm && !ownedPrivate) throw new Error();
      let stat;
      try { stat = fs.lstatSync(ps1); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!stat) { results.push({ name, status: "ready", changed: false });continue; }
      if (!stat.isFile() || stat.size > 8192 || fs.readFileSync(ps1, "utf8").replaceAll("\r\n", "\n") !== npmPowerShellShim(target)) {
        results.push({ name, status: "custom_preserved", changed: false });continue;
      }
      if (repair) fs.unlinkSync(ps1);
      results.push({ name, status: repair ? "ready" : "repairable", changed: repair });
    } catch {
      results.push({ name, status: "unavailable", changed: false });
    }
  }
  return { status: results.every(item => item.status === "ready") ? "ready"
    : results.some(item => item.status === "repairable") ? "repairable" : "preserved",
  changed: results.some(item => item.changed), commands: results };
}
