import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("CI delegates the Node matrix to the package verify contract", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const nodeJob = workflow.slice(workflow.indexOf("  test:"), workflow.indexOf("  pm-studio-macos:"));

  assert.match(nodeJob, /node:\s*\["22\.15\.0", "24\.x"\]/);
  assert.equal((nodeJob.match(/- run: npm run verify\b/g) || []).length, 1);
  for (const duplicatedStep of ["npm test", "npm run test:smoke", "npm run bench:check", "npm run pack:check"]) {
    assert.doesNotMatch(nodeJob, new RegExp(`- run: ${duplicatedStep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
  }
});

test("CI retains the dedicated macOS PM Studio check", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const macJob = workflow.slice(workflow.indexOf("  pm-studio-macos:"));

  assert.match(macJob, /runs-on: macos-latest/);
  assert.match(macJob, /node-version: 24\.x/);
  assert.match(macJob, /- run: node --test test\/pm-studio-setup\.test\.mjs/);
});
