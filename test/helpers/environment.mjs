import path from "node:path";

export function testEnvironment(home, extra = {}) {
  const allowed = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PSMODULEPATH", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA", "LANG", "LC_ALL", "CI", "TERM", "NO_COLOR", "FORCE_COLOR"]);
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
  return { ...base, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home, ...extra };
}
