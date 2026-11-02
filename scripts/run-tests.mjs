import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { testEnvironment } from "../test/helpers/environment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const discover = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? discover(path.join(directory, entry.name)) : entry.isFile() && entry.name.endsWith(".test.mjs") ? [path.join(directory, entry.name)] : []);
const args = process.argv.slice(2), files = args.filter(value => !value.startsWith("--"));
if (files.some(file => !file.endsWith(".test.mjs") || !fs.statSync(path.resolve(file), { throwIfNoEntry: false })?.isFile())) throw Error("A requested test file does not exist");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-tests-"));
const env = testEnvironment(home, { CCDX_M365: "0", CCDX_AUTO_LAUNCH: "0", CCDX_DISABLE_TOKEN_DISCOVERY: "1" });
const flags = args.filter(value => value.startsWith("--"));
if (!flags.some(value => value.startsWith("--test-concurrency="))) flags.push(`--test-concurrency=${Math.max(1, Math.min(4, os.availableParallelism() - 1))}`);
const child = spawn(process.execPath, ["--test", ...flags, ...(files.length ? files : discover(path.join(root, "test")).sort())], { cwd: root, env, stdio: "inherit" });
const stop = signal => child.kill(signal);
const interrupt = () => stop("SIGINT"), terminate = () => stop("SIGTERM");
process.on("SIGINT", interrupt);process.on("SIGTERM", terminate);
try {
  const code = await new Promise((resolve, reject) => { child.once("error", reject);child.once("close", value => resolve(value ?? 1)); });
  process.exitCode = code;
} finally {
  process.off("SIGINT", interrupt);process.off("SIGTERM", terminate);
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
}
