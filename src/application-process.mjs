import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { installedWindowsPredictionAppAsync } from "./native-prediction-windows.mjs";
import { inspectWindowsAntigravity } from "./windows-antigravity-app.mjs";

const execute = promisify(execFile);
const definitions = {
  codex: { bundles: ["Codex.app", "ChatGPT.app"], id: "com.openai.codex", executables: ["Codex", "ChatGPT"] },
  claude_app: { bundles: ["Claude.app"], id: "com.anthropic.claudefordesktop", executables: ["Claude"] },
  antigravity: { bundles: ["Gemini.app"], id: "com.google.GeminiMacOS", executables: ["Gemini"] },
};
const runOptions = { encoding: "utf8", timeout: 3000, maxBuffer: 4 * 1024 * 1024, windowsHide: true };
const metadataEnvironment = env => ({ ...Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOME", "TZ"]
  .filter(key => env[key] !== undefined || process.env[key] !== undefined).map(key => [key, env[key] ?? process.env[key]])), LC_ALL: "C", LANG: "C" });
const windowsInventory = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';$claude=$null;
$p=@(Get-AppxPackage -Name '*Claude*' | Where-Object { $_.Publisher -match 'Anthropic' -and [int]$_.Status -eq 0 });
if($p.Count -eq 1){$m=Get-AppxPackageManifest -Package $p[0].PackageFullName;$a=@($m.Package.Applications.Application | Where-Object { [IO.Path]::GetFileName($_.Executable) -eq 'Claude.exe' });if($a.Count -eq 1){$claude=@{app=(Join-Path $p[0].InstallLocation $a[0].Executable);target=('shell:AppsFolder\\'+$p[0].PackageFamilyName+'!'+$a[0].Id)}}}
if(!$claude){$f=Join-Path $env:LOCALAPPDATA 'AnthropicClaude\\Claude.exe';if(Test-Path -LiteralPath $f){$v=[Diagnostics.FileVersionInfo]::GetVersionInfo($f);if($v.CompanyName -match 'Anthropic' -and $v.ProductName -in @('Claude','Claude Desktop')){$claude=@{app=$f;target=$f}}}}
$rows=@(Get-CimInstance Win32_Process | ForEach-Object { if($_.CreationDate -and $_.ExecutablePath){@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;command=[string]$_.ExecutablePath;started=$_.CreationDate.ToUniversalTime().ToString('o')}} });
@{claude=$claude;processes=$rows} | ConvertTo-Json -Depth 5 -Compress`;

export function processFamily(processes, root) {
  const rows = new Map(processes.map(row => [row.pid, row]));
  return processes.filter(row => {
    let node = row;const visited = new Set();
    while (node && !visited.has(node.pid)) { if (node.pid === root) return true;visited.add(node.pid);node = rows.get(node.parent); }
    return false;
  });
}

export async function inspectApplicationProcesses({ platform = process.platform, home = os.homedir(), env = process.env,
  exec = execute, discoverWindows = installedWindowsPredictionAppAsync, discoverWindowsAntigravity = inspectWindowsAntigravity,
  applicationsRoot = "/Applications" } = {}) {
  if (!["darwin", "win32"].includes(platform)) return { apps: Object.fromEntries(Object.keys(definitions).map(id => [id, { status: "unsupported" }])), processes: [] };
  const apps = {}, processes = [];
  if (platform === "darwin") {
    const listing = await exec("/bin/ps", ["-ww", "-axo", "pid=,ppid=,lstart=,comm="], { ...runOptions, env: metadataEnvironment(env) });
    for (const line of String(listing.stdout).split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s+(\/.*?)\s*$/.exec(line);
      if (match) processes.push({ pid: Number(match[1]), parent: Number(match[2]), started: Number.isFinite(Date.parse(match[3])) ? new Date(match[3]).toISOString() : null, command: match[4] });
    }
    for (const [id, definition] of Object.entries(definitions)) {
      const installed = [];
      for (const directory of [applicationsRoot, path.join(home, "Applications")]) for (const bundle of definition.bundles) {
        const app = path.join(directory, bundle), file = path.join(app, "Contents/Info.plist");
        try { await fs.access(file); } catch { continue; }
        const result = await exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { ...runOptions, maxBuffer: 65536 });
        const info = JSON.parse(result.stdout);
        if (info.CFBundleIdentifier !== definition.id || !definition.executables.includes(info.CFBundleExecutable)) continue;
        installed.push({ app, target: app, identity: definition.id, executable: path.join(app, "Contents/MacOS", info.CFBundleExecutable), version: info.CFBundleShortVersionString });
      }
      const running = installed.filter(info => processes.some(row => row.command === info.executable));
      apps[id] = running.length > 1 ? { status: "multiple" } : running[0] || installed[0] || { status: "not_installed" };
    }
  } else {
    const [result, codex, antigravity] = await Promise.all([
      exec("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsInventory], { ...runOptions, env: metadataEnvironment(env) }),
      Promise.resolve().then(() => discoverWindows({ env })).catch(() => null),
      Promise.resolve().then(() => discoverWindowsAntigravity({ env, exec })).catch(() => ({ status: "unknown" })),
    ]);
    const inventory = JSON.parse(result.stdout);
    for (const row of inventory.processes || []) if (Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isFinite(Date.parse(row.started))) processes.push(row);
    apps.codex = codex ? { app: codex.app, target: codex.app, executable: codex.app } : { status: "not_installed" };
    const claude = inventory.claude;
    apps.claude_app = claude && path.win32.isAbsolute(claude.app) && path.win32.basename(claude.app).toLowerCase() === "claude.exe"
      && (claude.target === claude.app || /^shell:AppsFolder\\[A-Za-z0-9._-]+![A-Za-z0-9._-]+$/.test(claude.target))
      ? { app: claude.app, target: claude.target, executable: claude.app } : { status: "not_installed" };
    apps.antigravity = antigravity;
  }
  for (const info of Object.values(apps)) if (info.executable) {
    const same = command => platform === "win32" ? command?.toLowerCase() === info.executable.toLowerCase() : command === info.executable;
    const candidates = processes.filter(row => same(row.command));
    const matches = candidates.filter(row => !candidates.some(other => other.pid !== row.pid && processFamily(processes, other.pid).some(child => child.pid === row.pid)));
    Object.assign(info, { status: matches.length > 1 ? "multiple" : matches.length ? matches[0].started ? "running" : "unknown" : "stopped" });
    if (matches.length === 1) Object.assign(info, { pid: matches[0].pid, started: matches[0].started });
  }
  return { apps, processes };
}

export async function applicationConnections(pids, port, { platform = process.platform, exec = execute, env = process.env } = {}) {
  if (!pids.length || pids.length > 128 || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0) || !Number.isInteger(port) || port < 1 || port > 65535) return [];
  if (platform === "darwin") {
    let out;
    try { out = await exec("/usr/sbin/lsof", ["-nP", "-a", "-p", pids.join(","), `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-Fpn"], { ...runOptions, maxBuffer: 256 * 1024 }); }
    catch (error) { if (error.code === 1 && !String(error.stderr || "").trim()) return [];throw error; }
    let pid;const connections = [];
    for (const line of out.stdout.split("\n")) {
      if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
      const match = /^n(?:127\.0\.0\.1|\[::1\]):(\d+)->(?:127\.0\.0\.1|\[::1\]):(\d+)$/.exec(line);
      if (match && pids.includes(pid) && Number(match[2]) === port) connections.push({ pid, peerPort: Number(match[1]), port });
    }
    return connections;
  }
  if (platform === "win32") {
    const script = `$ids=@(${pids.join(",")});@(Get-NetTCPConnection -State Established -RemotePort ${port} -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $ids -and $_.RemoteAddress -in @('127.0.0.1','::1') } | ForEach-Object { @{pid=[int]$_.OwningProcess;peerPort=[int]$_.LocalPort;port=[int]$_.RemotePort} }) | ConvertTo-Json -Compress`;
    const result = await exec("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { ...runOptions, env });
    const value = JSON.parse(result.stdout || "[]");return Array.isArray(value) ? value : [value];
  }
  return [];
}

export async function controlApplicationProcess(info, action, { platform = process.platform, exec = execute, env = process.env } = {}) {
  if (!Number.isSafeInteger(info.pid) || !["focus", "quit"].includes(action)) throw new Error("Invalid application control");
  if (platform === "darwin") {
    const script = `ObjC.import('AppKit');function run(a){var p=$.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(a[0]));if(p.isNil())return 'absent';if(ObjC.unwrap(p.bundleIdentifier)!==a[1]||ObjC.unwrap(p.bundleURL.path)!==a[2])return 'different';return (a[3]==='quit'?p.terminate:p.activateWithOptions($.NSApplicationActivateIgnoringOtherApps))?'sent':'refused';}`;
    const result = await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, String(info.pid), info.identity, info.app, action], { ...runOptions, timeout: 5000, maxBuffer: 4096 });
    return String(result.stdout).trim();
  }
  if (platform === "win32") {
    const script = action === "focus" ? `$w=New-Object -ComObject WScript.Shell;if($w.AppActivate(${info.pid})){'sent'}else{'refused'}`
      : `$p=Get-Process -Id ${info.pid} -ErrorAction SilentlyContinue;if(!$p){'absent'}elseif($p.CloseMainWindow()){'sent'}else{'refused'}`;
    const result = await exec("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { ...runOptions, env });
    return String(result.stdout).trim();
  }
  return "unsupported";
}
