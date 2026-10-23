// Keep company routing and OS credential access; omit unrelated application secrets and Node hooks.
export function privateHelperEnvironment(env = process.env) {
  const keys = new Set(["PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "WINDIR", "APPDATA", "LOCALAPPDATA",
    "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS",
    "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "DISPLAY"]);
  return Object.fromEntries(Object.entries(env).filter(([key]) => keys.has(key.toUpperCase())));
}
