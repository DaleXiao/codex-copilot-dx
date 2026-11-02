import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const checks = [["unit", ["scripts/run-tests.mjs"]], ["CI paths", ["scripts/check-ci-test-lists.mjs"]], ["smoke", ["scripts/offline-smoke.mjs"]], ["SSE idle", ["scripts/sse-idle-replay.mjs"]], ["performance", ["scripts/benchmark.mjs", "--check"]], ["package", [process.env.npm_execpath, "pack", "--dry-run", "--json"]]];
let failed = false;
for (const [name, args] of checks) {
  console.log(`Checking ${name}`);
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.status !== 0 || result.error) { failed = true;console.error(`Failed: ${name}`); }
}
process.exitCode = failed ? 1 : 0;
