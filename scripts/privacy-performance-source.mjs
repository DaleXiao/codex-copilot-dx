import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const runtimePaths = ["src", "bin", "native/privacy-guard", "package.json", "package-lock.json", "install"];
export function privacyRuntimeFingerprint(root) {
  execFileSync("git", ["diff", "--quiet", "HEAD", "--", ...runtimePaths], { cwd: root });
  const tree = execFileSync("git", ["ls-tree", "-rz", "HEAD", "--", ...runtimePaths], { cwd: root });
  return createHash("sha256").update(tree).digest("hex");
}
export function privacyMeasurementFingerprint(root) {
  const hash = createHash("sha256");
  for (const name of ["scripts/privacy-candidate-replay.mjs", "scripts/privacy-performance-analysis.mjs", "scripts/privacy-performance-source.mjs"]) {
    hash.update(name + "\0").update(fs.readFileSync(path.join(root, name)));
  }
  return hash.digest("hex");
}
