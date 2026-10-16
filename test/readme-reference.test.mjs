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
  assert.match(reference, /Startup, image setup, config doctor, compression and legacy prediction cleanup share this path/);
  assert.doesNotMatch(reference, /does not redirect it through `CODEX_HOME`/);
  assert.ok(readme.trimEnd().split("\n").length <= 130, "keep the expanded two-provider quick start concise");
  assert.match(readme, /ccdx m365 switch/);
  assert.match(reference, /## Microsoft 365 provider/);
  for (const command of ["start", "status", "doctor", "models", "usage", "auto-review-model", "animation", "cache", "limits", "enable-image", "image-status", "disable-image", "update"]) {
    assert.ok(readme.includes(`ccdx ${command}`), command);
    assert.ok(cliHelp().includes(command), command);
  }
  for (const text of ["## Security", "## Configuration", "## Authentication", "## Debug logging"]) {
    if (text === "## Authentication") assert.match(reference, /### Authentication recovery/);
    else assert.ok(reference.includes(text), text);
  }
  assert.match(readme, /Image generation is \*\*off by default\*\*/);
  assert.match(readme, /can\n  break continuations/);
  assert.match(reference, /not an exact live/);
});
