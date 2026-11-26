import fs from "node:fs";
import path from "node:path";
import { readBoundedFileSync } from "./bounded-file.mjs";

const packageName = "@anthropic-ai/claude-code";
const versionNumber = /^\d+\.\d+\.\d+$/;

export function installedClaudeCodeVersion({ env = process.env, platform = process.platform } = {}) {
  const windows = platform === "win32", paths = windows ? path.win32 : path;
  const value = Object.entries(env).find(([key]) => windows ? key.toLowerCase() === "path" : key === "PATH")?.[1] || "";
  const extensions = windows ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";").filter(ext => /^\.[a-z0-9]+$/.test(ext)) : [""];
  for (const listed of value.split(paths.delimiter).filter(Boolean)) for (const extension of extensions) {
    const directory = listed.replace(/^"|"$/g, "");
    if (!paths.isAbsolute(directory)) continue;
    let executable;
    try {
      executable = fs.realpathSync(paths.join(directory, "claude" + extension));
      if (windows && /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(executable)) return null;
      if (!fs.statSync(executable).isFile()) continue;
      if (!windows) fs.accessSync(executable, fs.constants.X_OK);
    } catch { continue; }
    const metadata = name => {
      try {
        const entry = JSON.parse(readBoundedFileSync(name, { maxBytes: 65536, encoding: "utf8" }));
        return entry.name === packageName && versionNumber.test(entry.version) ? entry.version : null;
      } catch { return null; }
    };
    if (windows && /\.(?:cmd|bat)$/i.test(executable)) {
      try {
        const shim = readBoundedFileSync(executable, { maxBytes: 65536, encoding: "utf8" }).replaceAll("\\", "/");
        if (/%dp0%\/node_modules\/@anthropic-ai\/claude-code\//i.test(shim)) {
          return metadata(paths.join(paths.dirname(executable), "node_modules", packageName, "package.json"));
        }
      } catch { /* The first command exists but has no verifiable version. */ }
      return null;
    }
    const native = /[\\/]versions[\\/](\d+\.\d+\.\d+)(?:\.exe)?$/i.exec(executable)?.[1];
    if (native) return native;
    let parent = paths.dirname(executable);
    for (let depth = 0; depth < 4; depth++, parent = paths.dirname(parent)) {
      const detected = metadata(paths.join(parent, "package.json"));
      if (detected) return detected;
    }
    return null;
  }
  return null;
}
