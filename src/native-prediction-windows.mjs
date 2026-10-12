import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const WINDOWS_PUBLISHER = "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B";
const WINDOWS_PACKAGE_FAMILY = "OpenAI.Codex_2p2nqsd0c76g0";

export function windowsPowerShellEnvironment(env = process.env) {
  // PowerShell 7 can export a Core-only PSModulePath. Prefer the bundled
  // Windows PowerShell modules for this child, retaining user module paths.
  const modules = path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules");
  return { ...env, PSModulePath: [modules, env.PSModulePath].filter(Boolean).join(";") };
}

function powershell(script, { env = process.env, exec = execFileSync, ...options } = {}) {
  const command = path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    return exec(command, ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);" + script],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, env: windowsPowerShellEnvironment(env), windowsHide: true, ...options }).trim();
  } catch {
    throw new Error("Windows prediction check failed; verify PowerShell, App registration and current-user permissions");
  }
}

export function assertWindowsCodexClosed(options = {}) {
  let result;
  try { result = powershell("if (@(Get-Process -Name Codex,ChatGPT -ErrorAction SilentlyContinue).Count) {'running'} else {'closed'}", options); }
  catch { throw new Error("Could not check whether Codex is closed; prediction setup was skipped"); }
  if (result !== "closed") throw new Error("Quit Codex App before changing native prediction setup; no running App will be stopped");
}

export function installedWindowsPredictionApp(options = {}) {
  const raw = powershell(`$p=@(Get-AppxPackage -Name OpenAI.Codex | Where-Object { [int]$_.Status -eq 0 -and [int]$_.SignatureKind -eq 3 -and $_.Publisher -eq '${WINDOWS_PUBLISHER}' -and $_.PackageFamilyName -eq '${WINDOWS_PACKAGE_FAMILY}' });
    if($p.Count -ne 1){throw 'A single official OpenAI.Codex MSIX registration is required'};
    $m=Get-AppxPackageManifest -Package ([string]$p[0].PackageFullName);
    $a=@($m.Package.Applications.Application | Where-Object { [System.IO.Path]::GetFileName($_.Executable) -in @('Codex.exe','ChatGPT.exe') });
    if($a.Count -ne 1){throw 'Unknown Windows App executable'};
    @{root=$p[0].InstallLocation;executable=$a[0].Executable;family=$p[0].PackageFamilyName} | ConvertTo-Json -Compress`, options);
  let metadata;
  try { metadata = JSON.parse(raw); } catch { throw new Error("Could not read the registered Windows Codex App"); }
  const { root, executable, family } = metadata;
  if (typeof root !== "string" || !/^[a-z]:[\\/]/i.test(root) || typeof executable !== "string"
    || path.win32.isAbsolute(executable) || executable.split(/[\\/]/).includes("..")
    || !/^(Codex|ChatGPT)\.exe$/i.test(path.win32.basename(executable))
    || family !== WINDOWS_PACKAGE_FAMILY) {
    throw new Error("Unknown Windows App registration; prediction setup was skipped");
  }
  const app = path.win32.join(root, executable);
  const archives = [path.win32.join(path.win32.dirname(app), "resources", "app.asar"), path.win32.join(root, "resources", "app.asar")];
  const archive = [...new Set(archives)].find(candidate => fs.existsSync(candidate));
  if (!archive) throw new Error("The registered Windows App has no readable app archive");
  return { app, archive, family };
}

export function windowsPredictionProfile({ app, env = process.env, preferredProfile } = {}) {
  const override = String(env.CODEX_ELECTRON_USER_DATA_PATH || "").trim();
  if (override) return path.resolve(override);
  if (preferredProfile !== undefined) {
    if (typeof preferredProfile !== "string" || !path.win32.isAbsolute(preferredProfile)
      || /[\0\r\n]/.test(preferredProfile) || !fs.existsSync(path.win32.join(preferredProfile, "Local State"))) {
      throw new Error("Previously selected Windows profile is unavailable; set CODEX_ELECTRON_USER_DATA_PATH explicitly");
    }
    return path.win32.normalize(preferredProfile);
  }
  const names = path.win32.basename(app?.app || "").toLowerCase() === "chatgpt.exe" ? ["Codex", "ChatGPT"] : ["Codex"];
  const roots = names.flatMap(name => [env.APPDATA && path.win32.join(env.APPDATA, name),
    env.LOCALAPPDATA && app?.family && path.win32.join(env.LOCALAPPDATA, "Packages", app.family, "LocalCache", "Roaming", name)]).filter(Boolean);
  const candidates = roots.flatMap(root => path.win32.basename(root) === "Codex"
    ? [root, path.win32.join(root, "web", "Codex")] : [root]);
  // MSIX can virtualize AppData. Select only an existing App-created profile;
  // newer Windows builds nest the browser profile under web/Codex. Never guess
  // which copy owns trust when more than one initialized profile is present.
  const profiles = [...new Set(candidates)].filter(candidate => fs.existsSync(path.win32.join(candidate, "Local State")));
  if (profiles.length !== 1) throw new Error(profiles.length
    ? "Multiple Codex App profiles found; set CODEX_ELECTRON_USER_DATA_PATH to the active profile"
    : "Open Codex App once, fully quit it, then run ccdx prediction on; its Windows profile was not found");
  return profiles[0];
}

export function windowsPredictionOpenSSL(options = {}) {
  const raw = powershell(`$found=Get-Command openssl.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1;
    if($found){$found.Source}else{
      $paths=@("$env:ProgramFiles\\Git\\usr\\bin\\openssl.exe", "$env:LOCALAPPDATA\\Programs\\Git\\usr\\bin\\openssl.exe");
      $paths | Where-Object {Test-Path -LiteralPath $_ -PathType Leaf} | Select-Object -First 1
    }`, options);
  if (!path.win32.isAbsolute(raw) || !/openssl\.exe$/i.test(path.win32.basename(raw))) {
    throw new Error("Native prediction needs OpenSSL on Windows; install Git for Windows (includes OpenSSL) and retry");
  }
  return raw;
}

export function windowsPrivatePredictionPath(filePath, { create = false, env = process.env, ...options } = {}) {
  powershell(`$p=$env:CCDX_PREDICTION_PRIVATE_PATH;$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
    $acl=Get-Acl -LiteralPath $p;
    ${create ? `$acl.SetAccessRuleProtection($true,$false);
      $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');
      $acl.AddAccessRule($rule);$acl.SetOwner($sid);Set-Acl -LiteralPath $p -AclObject $acl;$acl=Get-Acl -LiteralPath $p;` : ""}
    $allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544');
    if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $allowed){throw 'Prediction key path has a different owner'};
    foreach($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){
      if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed){throw 'Prediction key path is not private'}
    }`, { ...options, env: { ...env, CCDX_PREDICTION_PRIVATE_PATH: filePath } });
}

export function windowsProxySettings(options = {}) {
  const raw = powershell(`Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class CCDXWinInetProxy {
  [StructLayout(LayoutKind.Sequential)] public struct Config { [MarshalAs(UnmanagedType.Bool)] public bool AutoDetect;public IntPtr Pac;public IntPtr Proxy;public IntPtr Bypass; }
  [DllImport("winhttp.dll",SetLastError=true)] public static extern bool WinHttpGetIEProxyConfigForCurrentUser(ref Config value);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr value);
}
'@
    $c=[CCDXWinInetProxy+Config]::new();
    if(-not [CCDXWinInetProxy]::WinHttpGetIEProxyConfigForCurrentUser([ref]$c)){throw 'Could not read current-user proxy settings'};
    try{@{autoDetect=$c.AutoDetect;pac=[Runtime.InteropServices.Marshal]::PtrToStringUni($c.Pac);proxy=[Runtime.InteropServices.Marshal]::PtrToStringUni($c.Proxy);bypass=[Runtime.InteropServices.Marshal]::PtrToStringUni($c.Bypass)} | ConvertTo-Json -Compress}
    finally{foreach($p in @($c.Pac,$c.Proxy,$c.Bypass)){if($p -ne [IntPtr]::Zero){[void][CCDXWinInetProxy]::GlobalFree($p)}}}`, options);
  let settings;
  try { settings = JSON.parse(raw); } catch { throw new Error("Could not read Windows proxy settings; existing routes were preserved"); }
  if (!settings || typeof settings !== "object" || Array.isArray(settings) || typeof settings.autoDetect !== "boolean"
    || [settings.pac, settings.proxy, settings.bypass].some(value => value !== undefined && value !== null && typeof value !== "string")) {
    throw new Error("Unknown Windows proxy settings; existing routes were preserved");
  }
  return settings;
}

export function windowsSystemProxy(options = {}) { return windowsProxyText(windowsProxySettings(options)); }

export function windowsProxyText({ autoDetect, pac, proxy = "", bypass = "" } = {}) {
  if (autoDetect || pac) throw new Error("Native prediction setup skipped: Windows PAC/WPAD needs dynamic routing; its rules were preserved");
  if (/[\r\n{}]/.test(String(proxy || "") + String(bypass || ""))) throw new Error("Unsupported Windows proxy rules; existing routes were preserved");
  const protocols = new Map();
  for (const item of String(proxy || "").split(";").map(value => value.trim()).filter(Boolean)) {
    const match = /^(http|https|socks)=(.+)$/i.exec(item);
    if (!match && item.includes("=")) throw new Error("Unsupported Windows proxy protocol; existing routes were preserved");
    for (const scheme of match ? [match[1].toLowerCase()] : ["http", "https"]) {
      if (protocols.has(scheme)) throw new Error("Duplicate Windows proxy route; existing routes were preserved");
      let url;
      try { url = new URL("http://" + (match ? match[2] : item)); } catch {}
      if (!url?.hostname || (url.port && Number(url.port) < 1) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        throw new Error("Unsupported Windows proxy address; existing routes were preserved");
      }
      protocols.set(scheme, url);
    }
  }
  const parts = [...protocols].map(([scheme, url]) => {
    const name = scheme === "socks" ? "SOCKS" : scheme.toUpperCase();
    return `${name}Enable : 1\n${name}Proxy : ${url.hostname.replace(/^\[|\]$/g, "")}\n${name}Port : ${url.port || 80}`;
  });
  const exceptions = String(bypass || "").split(";").map(value => value.trim()).filter(Boolean);
  if (exceptions.includes("<local>")) parts.push("ExcludeSimpleHostnames : 1");
  parts.push(`ExceptionsList : <array> {\n${exceptions.filter(value => value !== "<local>").map((value, index) => `${index} : ${value}`).join("\n")}\n}`);
  return parts.join("\n");
}
