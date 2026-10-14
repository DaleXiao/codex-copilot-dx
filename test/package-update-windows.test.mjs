import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runPackageUpdateCommand } from "../src/package-update.mjs";

const cli = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
const windowsOnly = { skip: process.platform !== "win32", timeout: 30_000 };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-windows-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "npm folder 中文 & ! ^ %");fs.mkdirSync(bin);
  const record = path.join(root, "calls.json"), preload = path.join(root, "network-guard.mjs");
  fs.writeFileSync(path.join(bin, "capture.mjs"), `import fs from "node:fs";
const file = process.env.CCDX_UPDATE_TEST_RECORD;
if (process.argv[2] === "--version") { console.log("12.0.1");process.exit(0); }
if (process.argv[2] === "config") { console.log("allow-remote=none\\nregistry=" + process.env.npm_config_registry);process.exit(0); }
if (process.argv[2] === "prefix") { console.log(process.env.npm_config_prefix);process.exit(0); }
const rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
rows.push({args: process.argv.slice(2), registry: process.env.npm_config_registry, marker: process.env.CCDX_UPDATE_TEST_MARKER});
fs.writeFileSync(file, JSON.stringify(rows));process.exitCode = Number(process.env.CCDX_UPDATE_TEST_EXIT || 0);
if (!process.exitCode) { const path = await import("node:path");const target = path.join(process.env.npm_config_prefix, "node_modules", "codex-copilot-dx");
fs.mkdirSync(target, {recursive:true});fs.writeFileSync(path.join(target,"package.json"), JSON.stringify({name:"codex-copilot-dx",version:"0.9.31"})); }
`);
  fs.writeFileSync(path.join(bin, "npm.cmd"), '@"%CCDX_UPDATE_TEST_NODE%" "%~dp0capture.mjs" %*\r\n@exit /b %errorlevel%\r\n');
  fs.writeFileSync(preload, `globalThis.fetch = async url => {
if (String(url) !== "https://github.com/DaleXiao/codex-copilot-dx/releases/latest") throw new Error("Non-fixture network request refused");
return new Response(null, {status: 302, headers: {location: "/DaleXiao/codex-copilot-dx/releases/tag/v0.9.31"}});
};\n`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  Object.assign(env, { PATH: `${bin};${process.env.PATH}`, CCDX_UPDATE_TEST_NODE: process.execPath,
    CCDX_UPDATE_TEST_RECORD: record, CCDX_UPDATE_TEST_MARKER: "space 中文 & ! %PATH%",
    npm_config_registry: "https://approved-mirror.example/npm?company=1&scope=test",
    npm_config_prefix: path.join(root, "global"), npm_config_cache: path.join(root, "cache"),
    npm_config_offline: "true", npm_config_ignore_scripts: "true", XDG_CONFIG_HOME: path.join(root, "config") });
  return { root, env, record, preload, calls: () => JSON.parse(fs.readFileSync(record, "utf8")) };
}

test("real Windows spawn reproduces the original npm.cmd EINVAL without installing anything", windowsOnly, async t => {
  const f = fixture(t);
  await assert.rejects(async () => {
    const child = spawn("npm.cmd", ["install", "--global", "codex-copilot-dx@latest"], { env: f.env, shell: false, stdio: "ignore" });
    await new Promise((resolve, reject) => { child.once("error", reject);child.once("exit", resolve); });
  }, error => error.code === "EINVAL");
  assert.equal(fs.existsSync(f.record), false);
});

test("real Windows updater executes npm.cmd under paths with spaces, Unicode and metacharacters", windowsOnly, async t => {
  const f = fixture(t), output = [];
  await runPackageUpdateCommand({ source: "npm", env: f.env, output: { write: text => output.push(text) },
    fetchImpl() { assert.fail("npm updates must not query a release"); } });
  assert.deepEqual(f.calls(), [{ args: ["install", "--global", "codex-copilot-dx@latest"],
    registry: f.env.npm_config_registry, marker: f.env.CCDX_UPDATE_TEST_MARKER }]);
  assert.match(output.join(""), /Updated codex-copilot-dx/);
});

test("real Windows per-update remote consent keeps strict saved policy and does not accept arbitrary shell fragments", windowsOnly, async t => {
  const f = fixture(t);f.env.npm_config_allow_remote = "none";
  await runPackageUpdateCommand({ source: "npm", allowRemote: true, env: f.env, output: { write() {} } });
  assert.deepEqual(f.calls()[0].args, ["install", "--global", "--allow-remote=all", "codex-copilot-dx@latest"]);
  assert.equal(f.env.npm_config_allow_remote, "none");
});

test("real Windows CLI npm/GitHub updates and installer failure use the same fixed process chain", windowsOnly, t => {
  const f = fixture(t);
  for (const source of ["npm", "github"]) {
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(f.preload).href, cli, "update", source],
      { env: f.env, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.error, undefined);assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Updated codex-copilot-dx/);
  }
  const calls = f.calls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, ["install", "--global", "--allow-git=all", "github:DaleXiao/codex-copilot-dx#v0.9.31"]);
  for (const call of calls) assert.equal(call.registry, f.env.npm_config_registry);
  const failed = spawnSync(process.execPath, ["--import", pathToFileURL(f.preload).href, cli, "update", "github"],
    { env: { ...f.env, CCDX_UPDATE_TEST_EXIT: "17" }, encoding: "utf8", timeout: 20_000 });
  assert.equal(failed.status, 1);assert.match(failed.stderr, /npm update exited with status 17/);
  assert.doesNotMatch(failed.stdout, /Updated codex-copilot-dx/);
  assert.equal(f.calls().length, 3, "nonzero installation is not retried");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, "global", "node_modules", "codex-copilot-dx", "package.json"))).version, "0.9.31");
});
