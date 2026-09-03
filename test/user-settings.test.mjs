import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  autoReviewModelPreference,
  readUserSettings,
  savedAutoReviewModel,
  savedTerminalAnimationTheme,
  terminalAnimationPreference,
  userSettingsPath,
  writeAutoReviewModel,
  writeTerminalAnimationTheme,
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
  assert.throws(
    () => writeTerminalAnimationTheme("twin", { env: {}, home }),
    /Invalid ccdx settings/,
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), "{broken");
});

test("user settings: stores animation choices, preserves other keys, and clears the default", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-settings-animation-"));
  const env = {};
  const filePath = userSettingsPath({ env, home });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({
    auto_review_model: "gpt-5.6-sol",
    future_setting: { enabled: true },
  }, null, 2)}\n`, { mode: 0o600 });

  assert.deepEqual(terminalAnimationPreference({ env, home }), {
    theme: "comet",
    source: "default",
  });
  assert.equal(writeTerminalAnimationTheme("twin", { env, home }).changed, true);
  assert.equal(savedTerminalAnimationTheme({ env, home }), "twin");
  assert.deepEqual(terminalAnimationPreference({ env, home }), {
    theme: "twin",
    source: "settings",
  });
  assert.deepEqual(readUserSettings({ env, home }), {
    auto_review_model: "gpt-5.6-sol",
    future_setting: { enabled: true },
    terminal_animation: "twin",
  });
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);

  assert.equal(writeTerminalAnimationTheme("comet", { env, home }).changed, true);
  assert.equal(savedTerminalAnimationTheme({ env, home }), "");
  assert.deepEqual(readUserSettings({ env, home }), {
    auto_review_model: "gpt-5.6-sol",
    future_setting: { enabled: true },
  });
  assert.equal(writeTerminalAnimationTheme("comet", { env, home }).changed, false);
});

test("user settings: invalid animation settings preserve valid runtime settings and block all writes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-settings-animation-invalid-"));
  const env = {};
  const filePath = userSettingsPath({ env, home });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const invalid = `${JSON.stringify({
    auto_review_model: "gpt-5.6-luna",
    terminal_animation: "braille-comet",
    untouched: true,
  }, null, 2)}\n`;
  fs.writeFileSync(filePath, invalid);

  assert.deepEqual(readUserSettings({ env, home }), {
    auto_review_model: "gpt-5.6-luna",
    untouched: true,
  });
  assert.deepEqual(autoReviewModelPreference({ env, home }), {
    model: "gpt-5.6-luna",
    source: "settings",
  });
  assert.deepEqual(terminalAnimationPreference({ env, home }), {
    theme: "comet",
    source: "default",
  });
  assert.throws(
    () => readUserSettings({ env, home, strict: true }),
    /terminal_animation must be one of: comet, twin, shuttle, chase, mirror, pulse, braille/,
  );
  assert.throws(
    () => writeTerminalAnimationTheme("pulse", { env, home }),
    /Invalid ccdx settings/,
  );
  assert.throws(
    () => writeAutoReviewModel("gpt-5.6-sol", { env, home }),
    /Invalid ccdx settings/,
  );
  assert.throws(
    () => writeTerminalAnimationTheme("unknown", { env, home }),
    /Terminal animation must be one of/,
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), invalid);
});
