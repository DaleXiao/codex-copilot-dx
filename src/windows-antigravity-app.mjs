import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { windowsPowerShellEnvironment } from "./windows-process.mjs";
import { createWindowsAntigravityManifest } from "./windows-antigravity-compat.mjs";

const execute = promisify(execFile);
const publishedBundles = createWindowsAntigravityManifest();
// Extracted from Google's Authenticode-bearing Antigravity App installers, not the IDE.
// Windows App payload identity is verified against all three routing components.
// https://antigravity.google/download
const officialBundles = new Map([
  ["fdf8a0a6af474d54301740bdf0144d95a30be3105d96a2cb39bb8086278513ac", [
    "9f0aad7274795d7fbde04931d96b348dcfc5f3d81d7373e6b70aeb09307442df",
    "73ce9a2405b455a93d1f13db2ae555da50406110217a349b6dd85c377fbdb9d1",
  ]],
  ["ec43b6ade67822195c8529c99468bddc10baa5de1aaeccaa8e55f9d79fd03ff7", [
    "9f0aad7274795d7fbde04931d96b348dcfc5f3d81d7373e6b70aeb09307442df",
    "3ab260e0e1bed6e2c86eab13f385200f62e26c33f27174f485ddae21933c4f74",
  ]],
  ["baa56cfeb0f0934782b60fba2733313822cff5f48606d47c5a463a276f2ed138", [
    "e057115571cf5085406d20f2427a5afac272b712ec84332c7157da0113d4b2d0",
    "fcdf7454007c6edc8162e601628c28cc1e6f575be849f329bb864c41ba6e6b02",
  ]],
  ["9693f0cb3c142fd629d9468275fd33e9d36b64df36d2e9899e7c62726f09e677", [
    "e057115571cf5085406d20f2427a5afac272b712ec84332c7157da0113d4b2d0",
    "aeb57eb01da844a6bce41f2bc8b8d20d7bc0e1154f57e6ee61a9da6782f6325d",
  ]],
]);

const inventory = String.raw`
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
$paths=@()
if($env:CCDX_AGY_INSPECT_APP){$paths=@($env:CCDX_AGY_INSPECT_APP)}
else{
  if($env:LOCALAPPDATA){$paths+=Join-Path $env:LOCALAPPDATA 'Programs\Antigravity\Antigravity.exe'}
  if($env:ProgramFiles){$paths+=Join-Path $env:ProgramFiles 'Antigravity\Antigravity.exe'}
  $guid='121a0be4-63bd-531e-acf8-fc3924c7e984'
  foreach($key in @("HKCU:\Software\$guid", "HKLM:\Software\$guid", "HKLM:\Software\WOW6432Node\$guid")){
    $dir=(Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).InstallLocation
    if($dir){$paths+=Join-Path $dir.Trim().Trim('"') 'Antigravity.exe'}
  }
  $keys=@('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
  foreach($entry in (Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue)){
    if($entry.DisplayName -ne 'Antigravity' -or $entry.Publisher -notin @('Google','Google LLC')){continue}
    if($entry.InstallLocation){$paths+=Join-Path $entry.InstallLocation 'Antigravity.exe'}
    if($entry.DisplayIcon -match '^\s*"?([a-z]:\\[^"]*\\Antigravity\.exe)"?(?:,\d+)?\s*$'){$paths+=$Matches[1]}
    if($entry.UninstallString -match '^\s*"?([a-z]:\\[^"]*\\)Uninstall Antigravity\.exe(?:"|\s|$)'){
      $paths+=Join-Path $Matches[1] 'Antigravity.exe'
    }
  }
}
$rows=@(foreach($p in ($paths|Sort-Object -Unique)){
  if($p -notmatch '^[a-z]:\\' -or [IO.Path]::GetFileName($p) -ne 'Antigravity.exe'){continue}
  $item=Get-Item -LiteralPath $p -ErrorAction SilentlyContinue
  if(!$item -or $item.PSIsContainer){continue}
  $v=$item.VersionInfo
  if($v.ProductName -ne 'Antigravity' -or $v.CompanyName -notin @('Google','Google LLC')){continue}
  $helper=Join-Path $item.DirectoryName 'resources\bin\language_server.exe'
  $asar=Join-Path $item.DirectoryName 'resources\app.asar'
  if(!(Test-Path -LiteralPath $helper -PathType Leaf) -or !(Test-Path -LiteralPath $asar -PathType Leaf)){continue}
  $row=@{app=$item.FullName;helper=$helper;version=$v.ProductVersion}
  if($env:CCDX_AGY_INSPECT_APP){
    $before=@($item, (Get-Item -LiteralPath $asar), (Get-Item -LiteralPath $helper))
    $row.hashes=@(foreach($f in $before){(Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash})
    foreach($f in $before){
      $after=Get-Item -LiteralPath $f.FullName
      if($after.Length -ne $f.Length -or $after.LastWriteTimeUtc -ne $f.LastWriteTimeUtc){throw 'Antigravity files changed during verification'}
    }
    $row.pids=@(Get-CimInstance Win32_Process -Filter "Name = 'Antigravity.exe'" |
      Where-Object { $_.ExecutablePath -eq $item.FullName } | ForEach-Object { [int]$_.ProcessId })
    if($env:APPDATA){
      $state=Get-Item -LiteralPath (Join-Path $env:APPDATA 'Antigravity\wsl_state.json') -ErrorAction SilentlyContinue
      if($state -and $state.Length -le 16384){
        try {$row.wsl=[bool]((Get-Content -Raw -LiteralPath $state.FullName | ConvertFrom-Json).distro)}catch{}
      }
    }
  }
  $row
})
ConvertTo-Json -InputObject @($rows) -Depth 4 -Compress
`;

export const windowsAntigravityPath = value => typeof value === "string" && /^[a-z]:\\/i.test(value)
  && path.win32.normalize(value) === value && path.win32.basename(value).toLowerCase() === "antigravity.exe";

export async function inspectWindowsAntigravity({ env = process.env, exec = execute, app, readBundles = publishedBundles } = {}) {
  if (app !== undefined && !windowsAntigravityPath(app)) throw new Error("Unrecognized Antigravity App location");
  const command = path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const childEnv = windowsPowerShellEnvironment({ ...env, CCDX_AGY_INSPECT_APP: app || "" });
  const { stdout } = await exec(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", inventory],
    { env: childEnv, encoding: "utf8", timeout: app ? 15000 : 3000, maxBuffer: 64 * 1024, windowsHide: true });
  const value = JSON.parse(stdout);
  const rows = Array.isArray(value) ? value.filter(row => windowsAntigravityPath(row?.app)
    && (!app || row.app.toLowerCase() === app.toLowerCase())
    && typeof row.version === "string" && /^[0-9][0-9A-Za-z.+_-]{0,63}$/.test(row.version)) : [];
  const distinct = [...new Map(rows.map(row => [row.app.toLowerCase(), row])).values()];
  if (distinct.length !== 1) return { status: distinct.length ? "multiple" : "not_installed" };
  const row = distinct[0], executable = row.app,
    helper = path.win32.join(path.win32.dirname(executable), "resources", "bin", "language_server.exe");
  const result = { app: executable, target: executable, executable, helper, version: row.version };
  if (!app) return result;
  const hashes = Array.isArray(row.hashes) && row.hashes.length === 3 ? row.hashes.map(value => String(value).toLowerCase()) : [];
  const expected = officialBundles.get(hashes[0]);
  const known = expected?.every((value, i) => hashes[i + 1] === value);
  if (!known) {
    const installed = hashes.length === 3 && !/^2\.35\.[12](?:\.0)?$/.test(row.version)
      ? await readBundles(row.version, { env }) : [];
    if (!installed.some(files => files.every((hash, i) => hashes[i] === hash))) return { ...result, status: "unverified_build" };
  }
  const pids = Array.isArray(row.pids) ? row.pids.filter(pid => Number.isSafeInteger(pid) && pid > 0) : [];
  return { ...result, status: pids.length ? "running" : "stopped", pids, wsl: row.wsl === true };
}

export function windowsAntigravityEnvironment(env, url) {
  const launch = Object.fromEntries(Object.entries(env).filter(([name]) =>
    /^(PATH|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|PATHEXT|LOCALAPPDATA|APPDATA|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|USERNAME|USERDOMAIN|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|LANG|LC_ALL|TZ|(?:HTTP|HTTPS|ALL|NO)_PROXY|ANTIGRAVITY_WSL_DISTRO)$/i.test(name)));
  if (url) launch.CLOUD_CODE_URL = url;
  return launch;
}

export async function launchWindowsAntigravity(plan, { spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(plan.command, plan.args, {
      cwd: path.win32.dirname(plan.command), env: plan.environment,
      detached: true, stdio: "ignore", shell: false,
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref();resolve(); });
  });
}
