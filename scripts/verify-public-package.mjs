// Release-only check of the actual public npm bytes and a fresh isolated install.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { verifyPackageRuntime } from "../src/release-install.mjs";

const directory = process.argv[2];
if (!path.isAbsolute(directory || "")) throw Error("Supply the downloaded source artifact directory");
const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package-manifest.json")));
const { name, version, filename } = manifest;
if (name !== "codex-copilot-dx" || !/^\d+\.\d+\.\d+$/.test(version) || filename !== `${name}-${version}.tgz`) throw Error("Invalid release manifest");
const expected = fs.readFileSync(path.join(directory, filename));
const digest = value => createHash("sha256").update(value).digest("hex");
if (expected.length !== manifest.size || `sha512-${createHash("sha512").update(expected).digest("base64")}` !== manifest.integrity) throw Error("Source artifact differs from its manifest");

async function read(url, limit) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20000) });
  if (!response.ok) { await response.body?.cancel();throw Error(`Public npm HTTP ${response.status}`); }
  const chunks = [];let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) { await response.body.cancel().catch(() => {});throw Error("Public response is oversized"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
let published;
for (let attempt = 0; attempt < 18; attempt++) {
  try {
    const record = JSON.parse(await read(`https://registry.npmjs.org/${name}/${version}`, 2 * 1024 * 1024));
    const latest = JSON.parse(await read(`https://registry.npmjs.org/${name}/latest`, 2 * 1024 * 1024));
    if (record.version !== version || latest.version !== version) throw Error("Public version/latest is not ready");
    published = record;break;
  } catch (error) {
    if (attempt === 17) throw error;
    console.log(`Waiting for public npm processing (${attempt + 1}/18)`);await delay(10000);
  }
}
const url = `https://registry.npmjs.org/${name}/-/${filename}`;
if (published.dist?.tarball !== url || published.dist.integrity !== manifest.integrity) throw Error("Public npm metadata differs from the packed release");
const actual = await read(url, 16 * 1024 * 1024);
if (!actual.equals(expected)) throw Error("Public npm bytes differ from the packed release");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-public-install-"));
try {
  const tarball = path.join(root, filename);fs.writeFileSync(tarball, actual);
  const prefix = path.join(root, "prefix"), cache = path.join(root, "empty-cache");
  const npm = path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
  execFileSync(process.execPath, [npm, "install", "--global", "--prefix", prefix, "--cache", cache, "--ignore-scripts", "--no-audit", "--no-fund", tarball], { stdio: "pipe", timeout: 180000 });
  const installed = path.join(prefix, "lib/node_modules", name);
  verifyPackageRuntime(installed, version, { brokerRequired: true });
  const output = execFileSync(process.execPath, [path.join(installed, "bin/cli.mjs"), "version"], { encoding: "utf8", timeout: 15000 });
  if (!output.includes(`ccdx v${version} `)) throw Error("Public installed CLI version differs");
  const receipt = { name, version, latest: version, bytes: actual.length, sha256: digest(actual), integrity: manifest.integrity, installed_cli: true, native_modules: true };
  fs.writeFileSync(path.join(directory, "public-npm-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
} finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
