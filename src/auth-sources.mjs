import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Known provider contracts only; never treat unrelated API keys as GitHub tokens.
export function additionalGithubSources(home, env) {
  const data = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const sources = [];
  const auth = path.join(data, "opencode", "auth.json");
  if (fs.existsSync(auth)) sources.push({ type: "opencode-auth", path: auth });
  const search = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] || "";
  const seen = new Set();
  for (const item of search.split(path.delimiter)) {
    const directory = item.trim().replace(/^"|"$/g, "");
    if (!directory || !path.isAbsolute(directory)) continue;
    const key = process.platform === "win32" ? directory.toLowerCase() : directory;
    if (seen.has(key)) continue;
    seen.add(key);
    const command = path.join(directory, process.platform === "win32" ? "gh.exe" : "gh");
    try {
      if (fs.statSync(command).isFile()) { sources.push({ type: "github-cli", path: command });break; }
    } catch {}
  }
  return sources;
}

export function readAdditionalGithubSource(source, { readJson, env = process.env, exec = execFileSync } = {}) {
  if (source.type === "opencode-auth") {
    const credential = readJson(source.path)?.["github-copilot"];
    // Legacy OpenCode auth.json stores GitHub's OAuth token in refresh, not the
    // short-lived Copilot service token. Enterprise credentials have another audience.
    if (credential?.type !== "oauth" || credential.enterpriseUrl || credential.enterprise_url) return "";
    return typeof credential.refresh === "string" ? credential.refresh.trim() : "";
  }
  if (source.type === "github-cli") {
    return exec(source.path, ["auth", "token", "--hostname", "github.com"], {
      env: { ...env, GH_PROMPT_DISABLED: "1" }, encoding: "utf8", shell: false,
      windowsHide: true, timeout: 1000, maxBuffer: 16 * 1024, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  return "";
}
