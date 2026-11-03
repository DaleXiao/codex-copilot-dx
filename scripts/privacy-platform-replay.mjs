import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [prefix, component, weights] = process.argv.slice(2);
if (![prefix, component, weights].every(value => value && path.isAbsolute(value))) throw Error("Supply the isolated client prefix, component and model directories");
const modules = path.join(prefix, "node_modules");
function executable(name) {
  if (process.platform !== "win32") return path.join(modules, ".bin", name);
  const search = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === name + ".exe") return file;
      if (entry.isDirectory()) { const found = search(file);if (found) return found; }
    }
    return null;
  };
  return search(modules);
}
let failed = false;
for (const name of ["codex", "claude"]) {
  const binary = executable(name);
  if (!binary || !fs.existsSync(binary)) { console.error(`Missing isolated ${name} executable`);failed = true;continue; }
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./privacy-client-replay.mjs", import.meta.url)),
    "--client", name, "--binary", binary, "--privacy", "on", "--rounds", "10", "--component-dir", component, "--model-dir", weights],
  { stdio: "inherit", timeout: 360000 });
  if (result.status !== 0 || result.error) failed = true;
}
process.exitCode = failed ? 1 : 0;
