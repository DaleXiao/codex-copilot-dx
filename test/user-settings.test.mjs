import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  autoReviewModelPreference,
  readUserSettings,
  savedAutoReviewModel,
  userSettingsPath,
  writeAutoReviewModel,
} from "../src/user-settings.mjs";

test("user settings: honors XDG_CONFIG_HOME and stores model changes atomically", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-settings-"));
  const env = { XDG_CONFIG_HOME: path.join(home, "xdg") };
  const filePath = userSettingsPath({ env, home });

  assert.equal(filePath, path.join(home, "xdg", "codex-copilot-dx", "config.json"));
  assert.equal(writeAutoReviewModel("gpt-5.6-terra", { env, home }).changed, true);
  assert.equal(savedAutoReviewModel({ env, home }), "gpt-5.6-terra");
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.equal(writeAutoReviewModel("gpt-5.6-terra", { env, home }).changed, false);
  assert.equal(writeAutoReviewModel("", { env, home }).changed, true);
  assert.equal(savedAutoReviewModel({ env, home }), "");
});

test("user settings: environment override wins over saved model and default", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-settings-precedence-"));
  writeAutoReviewModel("gpt-5.6-luna", { env: {}, home });

  assert.deepEqual(autoReviewModelPreference({ env: {}, home }), {
    model: "gpt-5.6-luna",
    source: "settings",
  });
  assert.deepEqual(autoReviewModelPreference({ env: { CCDX_AUTO_REVIEW_MODEL: " gpt-5.6-sol " }, home }), {
    model: "gpt-5.6-sol",
    source: "environment",
  });
  assert.deepEqual(autoReviewModelPreference({ env: {}, home: path.join(home, "missing") }), {
    model: "gpt-5.5",
    source: "default",
  });
});

test("user settings: runtime ignores malformed files while writes fail safely", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-settings-invalid-"));
  const filePath = userSettingsPath({ env: {}, home });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{broken");

  assert.deepEqual(readUserSettings({ env: {}, home }), {});
  assert.deepEqual(autoReviewModelPreference({ env: {}, home }), {
    model: "gpt-5.5",
    source: "default",
  });
  assert.throws(
    () => writeAutoReviewModel("gpt-5.6-sol", { env: {}, home }),
    /Invalid ccdx settings/,
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), "{broken");
});
