// OS runtime only. Never inherit account, proxy or provider credentials.
export function startupFixtureEnvironment(home) {
  const allowed = new Set(["SYSTEMROOT", "WINDIR", "PATH", "COMSPEC", "PSMODULEPATH"]);
  const values = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
  return { ...values, TMPDIR: home, TEMP: home, TMP: home };
}
