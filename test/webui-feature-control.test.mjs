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
test("image switch defaults on, preserves explicit off, and refuses retired API configuration", async t => {
  const f = fixture(t), control = createServiceControl(f);
  assert.equal(control.snapshot().saved.image_enabled, true);
  assert.equal(control.snapshot().features.image.native, true);
  for (const input of [{ action: "image", operation: "setup" }, { action: "image", operation: "remove" }, { action: "image", operation: "select", endpoint: "https://images.example", key: "old-key" }]) await assert.rejects(control.action(input));
  await control.action({ action: "image", operation: "pause" });assert.equal(readUserSettings(f).image_enabled, false);
  assert.equal(createServiceControl(f).snapshot().saved.image_enabled, false);
  await control.action({ action: "image", operation: "resume" });assert.equal(readUserSettings(f).image_enabled, true);
  assert.equal(fs.existsSync(legacyImageProviderPath(f)), false);
});
test("CLI reads the shared image inventory and toggles requests without image credentials or guidance", async t => {
  const f = fixture(t);let text = "";
  const request = async ({ body }) => {
    if (body?.action === "image") assert.deepEqual(body, { action: "image", operation: "select", model: "render-two" });
    return { features: { image: { native: true, configured: true, enabled: readUserSettings(f).image_enabled !== false, selected_model: "render-two", models: [{ id: "render-two", name: "Render Two" }] } } };
  };
  const result = await runImageCommand({ ...f, action: "enable", request, output: { write: v => { text += v; } } });
  assert.equal(result.native, true);assert.match(text, /built-in Codex image tool/);
  assert.equal(fs.existsSync(path.join(f.home, ".codex", "skills", "ccdx-image")), false);
  assert.equal(fs.existsSync(legacyImageProviderPath(f)), false);
  await runImageCommand({ ...f, action: "disable", request, output: { write() {} } });assert.equal(readUserSettings(f).image_enabled, false);
  const selected = await runImageCommand({ ...f, action: "select", model: "render-two", request, output: { write() {} } });assert.equal(selected.selected_model, "render-two");
});

test("CLI distinguishes an enabled image preference from an unavailable saved model", async t => {
  const f = fixture(t);let text = "";
  await runImageCommand({ ...f, action: "status", output: { write: v => { text += v; } }, request: async () => ({ features: { image: {
    enabled: true, configured: true, selected_model: "missing", selected_available: false, availability: "selected_unavailable", models: [{ id: "available" }] } } }) });
  assert.match(text, /Saved image model is unavailable/);
});
