import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const directory = process.argv[2], read = name => JSON.parse(fs.readFileSync(path.join(directory, name)));
const manifest = read("package-manifest.json"), npm = read("public-npm-receipt.json"), assets = read("verified-assets.json");
if (npm.version !== manifest.version || npm.integrity !== manifest.integrity || !npm.installed_cli || !npm.native_modules) throw Error("Public npm verification is incomplete");
fs.writeFileSync(path.join(directory, "release-receipt.json"), JSON.stringify({ version: manifest.version, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), ci_run: process.env.CCDX_CI_RUN, workflow_run: process.env.GITHUB_RUN_ID, npm, assets, receipt_checksum_scope: "All shipping assets except this receipt; SHA256SUMS excludes itself" }, null, 2) + "\n");
