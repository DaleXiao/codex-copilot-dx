import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Explicit doctor-only evidence. Never rewrites ACLs or blocks service startup.
export function inspectCredentialPermissions(file, { platform = process.platform, env = process.env, exec = execFileSync } = {}) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return "review";
    if (platform !== "win32") return stat.mode & 0o077 ? "review" : "private";
    const root = env.SystemRoot || env.WINDIR || "C:\\Windows";
    const command = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = "$ErrorActionPreference='Stop';$a=Get-Acl -LiteralPath $env:CCDX_PERMISSION_FILE;$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$trusted=@($me,'S-1-5-18','S-1-5-32-544');$b=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])|Where-Object {$_.AccessControlType -eq 'Allow' -and (($_.PropagationFlags -band 2) -eq 0) -and (($_.FileSystemRights -band 851975) -ne 0) -and ($trusted -notcontains $_.IdentityReference.Value)});@{review=($b.Count -gt 0)}|ConvertTo-Json -Compress";
    const result = JSON.parse(exec(command, ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...env, CCDX_PERMISSION_FILE: file, PSModulePath: path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "Modules")
        + (env.PSModulePath ? `;${env.PSModulePath}` : "") },
      encoding: "utf8", shell: false, windowsHide: true, timeout: 3000, maxBuffer: 32 * 1024,
    }));
    return typeof result.review === "boolean" ? result.review ? "review" : "private" : "unavailable";
  } catch (error) { return error.code === "ENOENT" ? "missing" : "unavailable"; }
}
