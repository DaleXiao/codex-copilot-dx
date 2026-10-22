// Build once; npm and GitHub receive the same npm pack artifact.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url)), output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error("Supply an absolute artifact directory");
fs.mkdirSync(output, { recursive: true });
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version;
for (const file of ["README.md", "docs/REFERENCE.md"]) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  for (const match of text.matchAll(/https:\/\/github\.com\/DaleXiao\/codex-copilot-dx\/releases\/download\/([^\s/)]+)\/([^\s)]+?)(?=[\s)]|$)/gi)) {
    if (/^(?:install\.(?:sh|ps1)|codex-copilot-dx-[\d.]+\.tgz)$/.test(match[2])
      && (match[1] !== `v${version}` || match[2].endsWith(".tgz") && match[2] !== `codex-copilot-dx-${version}.tgz`)) {
      throw Error(`Current installation instructions in ${file} differ from package ${version}`);
    }
  }
}
const result = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath || fileURLToPath(new URL("../lib/node_modules/npm/bin/npm-cli.js", `file://${process.execPath}`)), "pack", "--ignore-scripts", "--json", "--pack-destination", output], { cwd: root, encoding: "utf8" }));
const entries = Array.isArray(result) ? result : Object.values(result), name = `codex-copilot-dx-${version}.tgz`;
if (entries.length !== 1 || entries[0].filename !== name) throw Error("Unexpected package artifact");
for (const [source, destination] of [["src/release-install.mjs", "ccdx-install.mjs"], ["install/install.sh", "install.sh"], ["install/install.ps1", "install.ps1"]]) {
  const text = fs.readFileSync(path.join(root, source), "utf8");
  if (source.startsWith("install/") && !text.includes(`version${source.endsWith("ps1") ? " = '" : "="}${version}`)) throw Error("Bootstrap version differs from package");
  fs.copyFileSync(path.join(root, source), path.join(output, destination));
}
const names = [name, "ccdx-install.mjs", "install.sh", "install.ps1"];
fs.writeFileSync(path.join(output, "SHA256SUMS"), names.map(file => `${createHash("sha256").update(fs.readFileSync(path.join(output, file))).digest("hex")}  ${file}\n`).join(""));
fs.writeFileSync(path.join(output, "package-manifest.json"), JSON.stringify(entries[0], null, 2) + "\n");
console.log(`Release ${version}: ${entries[0].size} bytes, ${entries[0].files.length} package files; checksummed bootstrap helpers.`);
