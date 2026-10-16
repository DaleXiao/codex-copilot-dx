import path from "node:path";

export function windowsPowerShellEnvironment(env = process.env) {
  // PowerShell 7 can export a Core-only PSModulePath. Prefer the bundled
  // Windows PowerShell modules for this child, retaining user module paths.
  const modules = path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules");
  return { ...env, PSModulePath: [modules, env.PSModulePath].filter(Boolean).join(";") };
}
