import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { userSettingsPath, servicePreferences } from "./user-settings.mjs";
import { atomicWriteFileIfChangedSync } from "./atomic-file.mjs";
import { installedPredictionApp } from "./native-prediction-app.mjs";
import { autoLaunchEnabled } from "./launcher.mjs";
import { adapterBaseUrl } from "./running-adapter.mjs";

const execute = promisify(execFile);
const PREFIX = "#!/bin/sh\n# CCDX native image host\n";
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export function imageHostLauncherPath(options = {}) {
  return path.join(path.dirname(userSettingsPath(options)), "native-image-host", "codex-cli");
}

export async function prepareImageHostLaunch({ env = process.env, home, platform = process.platform, host = "127.0.0.1", port = 2026,
  discoverApp = installedPredictionApp, exec = execute, node = process.execPath,
  persistent = false,
  entry = fileURLToPath(new URL("../bin/codex-image-host.mjs", import.meta.url)) } = {}) {
  if (platform !== "darwin" || !persistent && (!autoLaunchEnabled(env) || !servicePreferences({ env, home }).image_enabled)) return null;
  const wrapper = imageHostLauncherPath({ env, home });
  if (env.CODEX_CLI_PATH?.trim() && path.resolve(env.CODEX_CLI_PATH) !== wrapper) throw new Error("A custom Codex CLI route is already configured; image host setup was preserved");
  const app = await discoverApp({ env, platform });
  const codex = path.join(app.app, "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex");
  if (!fs.statSync(codex).isFile()) throw new Error("The verified App has no native Codex runtime");
  const result = await exec(codex, ["--version"], { encoding: "utf8", timeout: 3000, maxBuffer: 4096 });
  const match = /codex-cli\s+0\.(\d+)\./.exec(String(result?.stdout ?? result));
  if (!match || Number(match[1]) < 166) throw new Error("Native host tools require Codex 0.166 or later");
  for (const value of [node, entry, codex]) if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error("Invalid image host executable path");
  if (fs.existsSync(wrapper) && !fs.readFileSync(wrapper, "utf8").startsWith(PREFIX)) throw new Error("Image host launcher ownership conflict; existing file preserved");
  const check = `[ -x ${quote(node)} ] && [ -r ${quote(entry)} ] && [ -x ${quote(codex)} ]`;
  const content = PREFIX + `if [ "\${1-}" = --ccdx-host-check ]; then ${check}; exit $?; fi\n`
    + `if ! ( ${check} ); then exec ${quote(codex)} "$@"; fi\n`
    + "exec " + [node, entry, "--codex", codex, "--base-url", adapterBaseUrl(host, port) + "/v1", "--"].map(quote).join(" ") + ' "$@"\n';
  fs.mkdirSync(path.dirname(wrapper), { recursive: true, mode: 0o700 });
  atomicWriteFileIfChangedSync(wrapper, content, { mode: 0o700 });fs.chmodSync(wrapper, 0o700);
  return { app: app.app, env: { CODEX_CLI_PATH: wrapper } };
}
