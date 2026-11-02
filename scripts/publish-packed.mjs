import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
const directory = process.argv[2], manifest = JSON.parse(fs.readFileSync(path.join(directory, "package-manifest.json")));
const npm = process.env.npm_execpath || path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
const result = spawnSync(process.execPath, [npm, "view", `${manifest.name}@${manifest.version}`, "dist.integrity", "--registry=https://registry.npmjs.org/", "--json"], { encoding: "utf8" });
if (!result.status) {
  if (JSON.parse(result.stdout) !== manifest.integrity) throw Error("An existing npm version has different bytes");
  console.log("Matching npm version already published; continuing verification");
} else {
  let error;try { error = JSON.parse(result.stdout).error; } catch {}
  if (error?.code !== "E404") throw Error("Could not verify whether the version already exists");
  execFileSync(process.execPath, [npm, "publish", path.join(directory, manifest.filename), "--tag", "latest", "--ignore-scripts"], { stdio: "inherit" });
}
