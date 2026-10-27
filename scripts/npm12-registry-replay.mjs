import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { runPackageUpdateCommand, inspectNpmDownloadPolicy } from "../src/package-update.mjs";
import { runtimeReleaseTarget } from "../src/release-install.mjs";

const npm = process.argv[process.argv.indexOf("--npm") + 1];
if (!process.argv.includes("--npm") || !path.isAbsolute(npm || "")) throw Error("Supply --npm /absolute/npm-12.0.1/bin/npm-cli.js");
const run = promisify(execFile), tar = createRequire(npm)("tar");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-npm12-registry-"));
const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url))).version;
const oldVersion = "0.9.31", registryToken = "synthetic-registry-token";
const artifacts = new Map(), servers = [], records = [];
let mirror = false, corrupt = false;
async function listen(server) {
  server.listen(0, "127.0.0.1");servers.push(server);
  await new Promise((resolve, reject) => { server.once("listening", resolve);server.once("error", reject); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function artifact(name, v, dependencies = {}) {
  const directory = path.join(root, "artifacts", name + "-" + v), pkg = path.join(directory, "package");fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name, version: v, dependencies }));
  fs.writeFileSync(path.join(pkg, "index.js"), "module.exports='isolated synthetic fixture';\n");
  const file = path.join(directory, "package.tgz");await tar.c({ cwd: directory, gzip: true, file }, ["package"]);
  const bytes = fs.readFileSync(file), integrity = "sha512-" + crypto.createHash("sha512").update(bytes).digest("base64");
  artifacts.set(`${name}@${v}`, { name, version: v, dependencies, bytes, integrity });return pkg;
}
try {
  const actualVersion = (await run(process.execPath, [npm, "--version"], { timeout: 10000 })).stdout.trim();
  assert.equal(actualVersion, "12.0.1");
  await artifact("codex-copilot-dx", oldVersion);
  const source = await artifact("codex-copilot-dx", version, { sharp: "0.35.5", "smol-toml": "1.9.1" });
  await artifact("sharp", "0.35.5", { "fixture-leaf": "1.0.0" });await artifact("smol-toml", "1.9.1");await artifact("fixture-leaf", "1.0.0");
  const full = path.join(root, "complete", "package");fs.mkdirSync(full, { recursive: true });
  fs.cpSync(source, full, { recursive: true });
  for (const [name, entry] of artifacts) {
    const item = entry.name;if (item === "codex-copilot-dx") continue;
    const destination = path.join(full, "node_modules", item);fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, "package.json"), JSON.stringify({ name: item, version: entry.version, dependencies: entry.dependencies }));
    fs.writeFileSync(path.join(destination, "index.js"), "module.exports='synthetic fixture';\n");
  }
  const native = path.join(full, "node_modules", "@azure/msal-node-runtime");fs.mkdirSync(native, { recursive: true });
  fs.writeFileSync(path.join(native, "package.json"), JSON.stringify({ name: "@azure/msal-node-runtime", version: "0.20.6" }));
  const fullMeta = JSON.parse(fs.readFileSync(path.join(full, "package.json")));
  fullMeta.optionalDependencies = { "@azure/msal-node-runtime": "0.20.6" };
  fullMeta.bundleDependencies = ["sharp", "smol-toml", "@azure/msal-node-runtime"];
  fullMeta.ccdx_runtime = { schema: 1, target: runtimeReleaseTarget() };
  fs.writeFileSync(path.join(full, "package.json"), JSON.stringify(fullMeta));
  const fullFile = path.join(root, "complete.tgz");await tar.c({ cwd: path.dirname(full), gzip: true, file: fullFile }, ["package"]);
  const fullBytes = fs.readFileSync(fullFile), fullSha = crypto.createHash("sha256").update(fullBytes).digest("hex"), fullName = `codex-copilot-dx-${version}-${runtimeReleaseTarget()}.tgz`;
  const serve = (req, res, cdn) => {
    records.push({ url: req.url, cdn, authorization: req.headers.authorization });
    const decoded = decodeURIComponent(req.url.split("?")[0]);
    if (decoded.includes(".tgz")) {
      const key = decoded.split("/").at(-1).replace(/\.tgz$/, ""), entry = [...artifacts.values()].find(item => `${item.name}-${item.version}` === key);
      if (!entry) { res.writeHead(404);res.end();return; }
      const bytes = Buffer.from(entry.bytes);
      if (corrupt && entry.name === "sharp") bytes[4] ^= 1; // Valid gzip, wrong SRI; not a malformed-archive test.
      res.setHeader("Content-Type", "application/octet-stream");res.end(bytes);return;
    }
    const name = decoded.replace(/^\/npm\//, ""), available = [...artifacts.values()].filter(item => item.name === name);
    if (!available.length) { res.writeHead(404);res.end(JSON.stringify({ error: "synthetic package not found" }));return; }
    const versions = Object.fromEntries(available.map(item => [item.version, { name, version: item.version, dependencies: item.dependencies,
      dist: { tarball: `${mirror && name !== "codex-copilot-dx" ? cdnUrl + "/cdn" : registryUrl + "/npm"}/${name}/-/${name}-${item.version}.tgz`, integrity: item.integrity } }]));
    res.setHeader("Content-Type", "application/json");res.end(JSON.stringify({ name, "dist-tags": { latest: name === "codex-copilot-dx" ? version : available[0].version }, versions }));
  };
  const cdnUrl = await listen(http.createServer((req, res) => serve(req, res, true)));
  const registryUrl = await listen(http.createServer((req, res) => serve(req, res, false)));
  const bin = path.join(root, "npm shim 中文 & ! %");fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "npm.cmd"), '@"%CCDX_REPLAY_NODE%" "%CCDX_REPLAY_NPM%" %*\r\n@exit /b %errorlevel%\r\n');
  fs.writeFileSync(path.join(bin, "npm"), '#!/bin/sh\nexec "$CCDX_REPLAY_NODE" "$CCDX_REPLAY_NPM" "$@"\n', { mode: 0o700 });
  const work = path.join(root, "working project");fs.mkdirSync(work);
  // The updater must inspect global policy, not adopt an unrelated project file.
  fs.writeFileSync(path.join(work, ".npmrc"), "allow-remote=all\nregistry=https://unrelated.invalid/\n");
  const originalCwd = process.cwd();process.chdir(work);
  try {
    for (const sourceType of ["npm", "github"]) for (const mode of ["strict-same-origin", "strict-cross-origin", "explicit-cross-origin", "corrupt-cross-origin", ...(sourceType === "github" ? ["complete-cross-origin"] : [])]) {
      mirror = mode !== "strict-same-origin";corrupt = mode === "corrupt-cross-origin";
      const directory = path.join(root, `${sourceType}-${mode}`), prefix = path.join(directory, "global prefix");fs.mkdirSync(directory);
      const userconfig = path.join(directory, "user.npmrc"), globalconfig = path.join(directory, "global.npmrc");
      const config = `registry=${registryUrl}/npm/\nallow-remote=none\nallow-git=none\n${registryUrl.replace("http:", "")}/npm/:_authToken=${registryToken}\n`;
      fs.writeFileSync(userconfig, config);fs.writeFileSync(globalconfig, "");
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/^npm_config_/i.test(key) || key.toLowerCase() === "path") delete env[key];
      Object.assign(env, { PATH: bin + path.delimiter + process.env.PATH, CCDX_REPLAY_NODE: process.execPath, CCDX_REPLAY_NPM: npm,
        npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig, npm_config_prefix: prefix,
        npm_config_cache: path.join(directory, "cache"), npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_fetch_retries: "0" });
      const npmRun = args => run(process.execPath, [npm, ...args], { env, cwd: work, encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 });
      // Install an old registry fixture first; failed upgrade must retain it.
      await npmRun(["install", "--global", `codex-copilot-dx@${oldVersion}`]);
      assert.equal(inspectNpmDownloadPolicy({ env }).allowRemote, "none");
      const output = [];let launches = 0, stderr = "", childClosed;
      const update = () => runPackageUpdateCommand({ source: sourceType, allowRemote: mode.startsWith("explicit") || mode.startsWith("corrupt"), env,
        output: { isTTY: false, write: value => output.push(value) }, verifyRuntimeFn() {}, fetchImpl: async url => {
          if (url.endsWith("/latest")) return new Response(null, { status: 302, headers: { location: `/DaleXiao/codex-copilot-dx/releases/tag/v${version}` } });
          const bytes = artifacts.get(`codex-copilot-dx@${version}`).bytes;
          return new Response(url.endsWith("SHA256SUMS") ? `${crypto.createHash("sha256").update(bytes).digest("hex")}  codex-copilot-dx-${version}.tgz\n${mode === "complete-cross-origin" ? `${fullSha}  ${fullName}\n` : ""}` : url.endsWith(fullName) ? fullBytes : bytes);
        },
        spawnImpl(command, args, options) {
          launches++;
          assert.ok(!args.some(value => /allow-git|github:Dale/.test(value)));
          const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
          child.stdout.resume();child.stderr.on("data", bytes => { stderr = (stderr + bytes.toString()).slice(-65536); });
          childClosed = new Promise(resolve => child.once("close", resolve));return child;
        } });
      const target = path.join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "codex-copilot-dx", "package.json");
      if (mode === "strict-cross-origin" || corrupt) {
        await assert.rejects(update(), /npm update exited with status/);
        await childClosed;assert.match(stderr, corrupt ? /EINTEGRITY/ : /EALLOWREMOTE/);
        assert.doesNotMatch(output.join(""), /Updated codex-copilot-dx/);
        assert.equal(JSON.parse(fs.readFileSync(target)).version, oldVersion, "failed update must retain the previous fixture");
      } else {
        await update();await childClosed;assert.equal(JSON.parse(fs.readFileSync(target)).version, version);assert.match(output.join(""), /Updated codex-copilot-dx/);
      }
      assert.equal(launches, mode === "complete-cross-origin" ? 2 : 1, "only one policy-specific complete-package retry");assert.equal(fs.readFileSync(userconfig, "utf8"), config);assert.equal(fs.readFileSync(globalconfig, "utf8"), "");
      assert.equal(inspectNpmDownloadPolicy({ env }).allowRemote, "none");
      console.log(`npm 12.0.1 replay: ${sourceType}/${mode}; saved policy unchanged; launches=${launches}`);
    }
  } finally { process.chdir(originalCwd); }
  assert.ok(records.some(record => !record.cdn && record.authorization === `Bearer ${registryToken}`));
  assert.ok(records.some(record => record.cdn));
  assert.ok(records.filter(record => record.cdn).every(record => record.authorization === undefined), "registry tokens must not reach the other origin");
  console.log("Synthetic loopback registry/CDN/Release fixtures passed; this is not company-network or native-sharp acceptance.");
} finally {
  for (const server of servers) { server.closeAllConnections();await new Promise(resolve => server.close(resolve)); }
  fs.rmSync(root, { recursive: true, force: true });
}
