import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url)), missing = [];
for (const name of fs.readdirSync(path.join(root, ".github/workflows"))) {
  if (!/\.ya?ml$/.test(name)) continue;
  const text = fs.readFileSync(path.join(root, ".github/workflows", name), "utf8");
  for (const [file] of text.matchAll(/test\/[\w./-]+\.test\.mjs/g)) if (!fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()) missing.push(`${name}: ${file}`);
}
if (missing.length) throw Error(`Missing CI test paths:\n${[...new Set(missing)].join("\n")}`);
console.log("CI test paths exist; unit suites use automatic discovery.");
