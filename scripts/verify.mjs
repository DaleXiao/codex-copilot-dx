import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { testEnvironment } from "../test/helpers/environment.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const node = process.env.npm_node_execpath || process.execPath;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-verify-"));
const env = testEnvironment(home, { XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"), CODEX_HOME: path.join(home, "codex"),
  PATH: path.dirname(node) + path.delimiter + (process.env.PATH || "") });
// Packing does not contact a provider. Keep the selected npm policy while all
// executable checks use an isolated profile and no developer credentials.
const npmEnv = { ...env, npm_config_userconfig: process.env.npm_config_userconfig || path.join(os.homedir(), ".npmrc") };
for (const [key, value] of Object.entries(process.env)) {
  if (/^npm_config_/i.test(key) && !/auth|token|password/i.test(key)) npmEnv[key] = value;
}
npmEnv.npm_config_cache = path.join(home, "npm-cache");
const checks = [["unit", ["scripts/run-tests.mjs"]], ["CI paths", ["scripts/check-ci-test-lists.mjs"]], ["smoke", ["scripts/offline-smoke.mjs"]], ["SSE idle", ["scripts/sse-idle-replay.mjs"]], ["performance", ["scripts/benchmark.mjs", "--check"]], ["package", [process.env.npm_execpath, "pack", "--dry-run", "--json"]]];
let failed = false;
try {
  for (const [name, args] of checks) {
    console.log("Checking " + name);
    const result = spawnSync(node, args, { cwd: root, env: name === "package" ? npmEnv : env, stdio: "inherit" });
    if (result.status !== 0 || result.error) { failed = true;console.error("Failed: " + name); }
  }
} finally { fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 }); }
process.exitCode = failed ? 1 : 0;
