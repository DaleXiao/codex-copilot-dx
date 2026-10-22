import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("release packaging refuses a stale current installer link before invoking npm", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-release-doc-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));fs.mkdirSync(path.join(root, "docs"));
  fs.copyFileSync(new URL("../scripts/release-artifacts.mjs", import.meta.url), path.join(root, "scripts/release-artifacts.mjs"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.2.10" }));
  for (const file of ["README.md", "docs/REFERENCE.md"]) {
    fs.writeFileSync(path.join(root, "README.md"), "Current instructions");
    fs.writeFileSync(path.join(root, "docs/REFERENCE.md"), "Current instructions");
    fs.writeFileSync(path.join(root, file), "https://github.com/DaleXiao/codex-copilot-dx/releases/download/v1.2.9/install.sh\n");
    const result = spawnSync(process.execPath, [path.join(root, "scripts/release-artifacts.mjs"), path.join(root, "out")], { encoding: "utf8", timeout: 10000 });
    assert.notEqual(result.status, 0);assert.match(result.stderr, /Current installation instructions.*differ from package 1\.2\.10/);
    assert.deepEqual(fs.readdirSync(path.join(root, "out")), [], "A stale link cannot reach npm pack");
  }
});
