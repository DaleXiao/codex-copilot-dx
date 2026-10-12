import os from "node:os";
import path from "node:path";

export function codexPaths({ env = process.env, home = os.homedir() } = {}) {
  const directory = path.resolve(String(env.CODEX_HOME || "").trim() || path.join(home, ".codex"));
  const profile = path.resolve(String(env.CODEX_ELECTRON_USER_DATA_PATH || "").trim()
    || path.join(home, "Library", "Application Support", "Codex"));
  return { directory, config: path.join(directory, "config.toml"), profile,
    certificateStore: path.join(profile, "Default", "ServerCertificate") };
}
