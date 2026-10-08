import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { cliHelp } from "../src/cli-options.mjs";

test("quick-start command table and full reference retain active CLI and safety boundaries", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const reference = fs.readFileSync(new URL("../docs/REFERENCE.md", import.meta.url), "utf8");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("docs/REFERENCE.md"), "preserve the complete offline reference in npm");
  assert.ok(readme.split("\n").length < 110);
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
