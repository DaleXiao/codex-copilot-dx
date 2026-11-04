import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServiceControl } from "../src/service-control.mjs";
import { runImageCommand } from "../src/cli-image.mjs";
import { legacyImageProviderPath } from "../src/image-retirement.mjs";
import { readUserSettings } from "../src/user-settings.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-native-image-control-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, env: {} };
}
test("image controls only enable or pause native GHC images and refuse old endpoint/key setup", async t => {
  const f = fixture(t), control = createServiceControl(f);
  const data = await control.action({ action: "image", operation: "setup" });
  assert.equal(data.features.image.native, true);assert.equal(data.features.image.model, "gpt-image-2.5-flare");
  assert.equal(readUserSettings(f).image_enabled, true);assert.equal(fs.existsSync(legacyImageProviderPath(f)), false);
  await assert.rejects(control.action({ action: "image", operation: "setup", endpoint: "https://images.example", key: "old-key" }));
  await control.action({ action: "image", operation: "pause" });assert.equal(readUserSettings(f).image_enabled, false);
  await control.action({ action: "image", operation: "resume" });assert.equal(readUserSettings(f).image_enabled, true);
  await control.action({ action: "image", operation: "remove" });assert.equal(readUserSettings(f).image_enabled, false);
});
test("CLI no longer prompts for image credentials or installs an MCP or skill", async t => {
  const f = fixture(t);let text = "";
  const result = await runImageCommand({ ...f, action: "enable", output: { write: v => { text += v; } }, prompt: () => assert.fail("No image prompts"), promptSecret: () => assert.fail("No image keys") });
  assert.equal(result.native, true);assert.match(text, /built-in image tool/);
  assert.equal(fs.existsSync(path.join(f.home, ".codex", "skills", "ccdx-image")), false);
  assert.equal(fs.existsSync(legacyImageProviderPath(f)), false);
  await runImageCommand({ ...f, action: "disable", output: { write() {} } });assert.equal(readUserSettings(f).image_enabled, false);
});
