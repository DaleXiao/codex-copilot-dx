import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { cliHelp } from "../src/cli-options.mjs";

test("quick-start command table and full reference retain active CLI and safety boundaries", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const reference = fs.readFileSync(new URL("../docs/REFERENCE.md", import.meta.url), "utf8");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("docs/REFERENCE.md"), "preserve the complete offline reference in npm");
  assert.ok(pkg.files.includes("docs/ARCHITECTURE.md"), "ship the linked architecture reference");
  assert.ok(fs.existsSync(new URL("../docs/ARCHITECTURE.md", import.meta.url)));
  assert.ok(readme.trimEnd().split("\n").length <= 100, "Keep the quick start concise");
  for (const command of ["ccdx source list", "ccdx source github reauth", "ccdx app codex models --edit", "ccdx config show --effective", "ccdx requests --failed"]) assert.ok(readme.includes(command), command);
  for (const group of ["source", "app", "config", "requests", "doctor", "update"]) assert.ok(cliHelp().includes(group), group);
  assert.doesNotMatch(cliHelp(), /Compatibility|help legacy/);
  for (const text of ["## Security", "## Configuration", "## Checks and troubleshooting", "## Debug logging", "## Optional native predictions", "## Optional image generation"]) assert.ok(reference.includes(text), text);
  assert.match(readme, /off by default/);
  assert.match(reference, /can break the next continuation/);
  assert.match(reference, /HTTPS[\s\S]{0,160}decrypted[\s\S]{0,40}locally/);
  assert.match(reference, /recorded usage|recorded token/);
});
