import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const directory = process.argv[2], mode = process.argv[3] || "draft";
if (!path.isAbsolute(directory || "") || !["draft", "public", "receipt"].includes(mode)) throw Error("Supply an absolute release directory and draft/public/receipt mode");
const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package-manifest.json"))), version = manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error("Invalid release version");
const targets = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"];
const names = [`codex-copilot-dx-${version}.tgz`, "ccdx-install.mjs", "install.sh", "install.ps1", ...targets.map(target => `codex-copilot-dx-${version}-${target}.tgz`), ...targets.map(target => `ccdx-privacy-guard-1-${target}${target.startsWith("win32") ? ".exe" : ""}`), "SHA256SUMS"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const sums = new Map(fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8").trim().split("\n").map(line => { const match = /^([a-f0-9]{64})  ([\w.-]+)$/.exec(line);if (!match) throw Error("Invalid checksum entry");return [match[2], match[1]]; }));
if (sums.size !== names.length - 1 || names.slice(0, -1).some(name => sums.get(name) !== sha(fs.readFileSync(path.join(directory, name))))) throw Error("Incomplete or mismatched release checksums");
for (const target of targets) {
  const name = `codex-copilot-dx-${version}-${target}.tgz`, runtime = JSON.parse(fs.readFileSync(path.join(directory, name + ".manifest.json")));
  const bytes = fs.readFileSync(path.join(directory, name));
  if (runtime.version !== version || runtime.target !== target || runtime.size !== bytes.length || runtime.integrity !== `sha512-${createHash("sha512").update(bytes).digest("base64")}`) throw Error(`Unverified runtime: ${target}`);
}
const repository = process.env.GITHUB_REPOSITORY;
if (!/^[\w.-]+\/[\w.-]+$/.test(repository || "")) throw Error("Missing release repository");
const release = JSON.parse(execFileSync("gh", ["release", "view", `v${version}`, "--repo", repository, "--json", "assets,isDraft"], { encoding: "utf8" }));
const expected = [...names, ...(mode !== "draft" ? ["release-receipt.json"] : [])];
const optionalReceipt = mode === "draft" && release.assets.some(asset => asset.name === "release-receipt.json") ? 1 : 0;
if (release.assets.length !== expected.length + optionalReceipt || expected.some(name => !release.assets.some(asset => asset.name === name)) || mode !== "draft" && release.isDraft) throw Error("GitHub release asset set or visibility differs");
const downloaded = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-release-download-")), assets = [];
try {
  if (mode === "receipt") {
    const prior = JSON.parse(fs.readFileSync(path.join(directory, "public-assets-receipt.json")));
    if (prior.version !== version || !prior.verified || prior.assets.length !== expected.length) throw Error("Missing original public asset verification");
    for (const name of names) {
      const row = prior.assets.find(asset => asset.name === name), bytes = fs.readFileSync(path.join(directory, name)), remote = release.assets.find(asset => asset.name === name);
      if (!row || row.bytes !== bytes.length || row.sha256 !== sha(bytes) || remote.size !== row.bytes || remote.digest && remote.digest !== `sha256:${row.sha256}`) throw Error(`Original verified shipping asset differs: ${name}`);
      assets.push(row);
    }
  }
  if (mode === "draft") execFileSync("gh", ["release", "download", `v${version}`, "--repo", repository, "--dir", downloaded], { stdio: "inherit" });
  for (const name of mode === "receipt" ? ["release-receipt.json"] : expected) {
    const expectedBytes = fs.readFileSync(path.join(directory, name));let actual;
    if (mode === "draft") actual = fs.readFileSync(path.join(downloaded, name));
    else {
      const suffix = name === "release-receipt.json" ? `?ccdx_sha256=${sha(expectedBytes)}` : "";
      const response = await fetch(`https://github.com/${repository}/releases/download/v${version}/${name}${suffix}`, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw Error(`Public asset HTTP ${response.status}: ${name}`);
      const chunks = [];let size = 0;
      for await (const chunk of response.body) { size += chunk.length;if (size > expectedBytes.length) throw Error(`Oversized public asset: ${name}`);chunks.push(chunk); }
      actual = Buffer.concat(chunks);
    }
    if (!actual.equals(expectedBytes)) throw Error(`Downloaded asset differs: ${name}`);
    assets.push({ name, bytes: actual.length, sha256: sha(actual) });
  }
  if (mode === "draft") fs.writeFileSync(path.join(directory, "verified-assets.json"), JSON.stringify(assets, null, 2) + "\n");
  else fs.writeFileSync(path.join(directory, "public-assets-receipt.json"), JSON.stringify({ version, assets, verified: true }, null, 2) + "\n");
  console.log(mode === "receipt" ? "Verified updated receipt with 13 preserved public shipping assets" : `Verified ${expected.length} ${mode} assets byte-for-byte`);
} finally { fs.rmSync(downloaded, { recursive: true, force: true, maxRetries: 3 }); }
