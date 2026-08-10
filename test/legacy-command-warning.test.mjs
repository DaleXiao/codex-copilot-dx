import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LEGACY_COMMAND_WARNING_INTERVAL_MS,
  legacyCommandWarningPath,
  shouldShowLegacyCommandWarning,
} from "../src/legacy-command-warning.mjs";

test("legacy command warning is interactive and limited to once every seven days", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-legacy-warning-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = {};
  const startedAt = 1_700_000_000_000;
  const warningPath = legacyCommandWarningPath({ env, home });

  assert.equal(shouldShowLegacyCommandWarning({ env, home, interactive: false, now: startedAt }), false);
  assert.equal(fs.existsSync(warningPath), false);

  assert.equal(shouldShowLegacyCommandWarning({ env, home, interactive: true, now: startedAt }), true);
  assert.equal(fs.readFileSync(warningPath, "utf8"), `${startedAt}\n`);
  assert.equal(shouldShowLegacyCommandWarning({
    env,
    home,
    interactive: true,
    now: startedAt + LEGACY_COMMAND_WARNING_INTERVAL_MS - 1,
  }), false);
  assert.equal(fs.readFileSync(warningPath, "utf8"), `${startedAt}\n`);

  const nextWarningAt = startedAt + LEGACY_COMMAND_WARNING_INTERVAL_MS;
  assert.equal(shouldShowLegacyCommandWarning({ env, home, interactive: true, now: nextWarningAt }), true);
  assert.equal(fs.readFileSync(warningPath, "utf8"), `${nextWarningAt}\n`);
});

test("legacy command warning honors XDG_CACHE_HOME", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-legacy-warning-xdg-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cacheHome = path.join(root, "cache");
  const env = { XDG_CACHE_HOME: cacheHome };

  assert.equal(shouldShowLegacyCommandWarning({ env, home: root, interactive: true, now: 42 }), true);
  assert.equal(
    legacyCommandWarningPath({ env, home: root }),
    path.join(cacheHome, "codex-copilot-dx", "legacy-command-warning"),
  );
});

test("legacy command warning stays silent when its throttle cache is unwritable", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-legacy-warning-readonly-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const blockedCache = path.join(root, "not-a-directory");
  fs.writeFileSync(blockedCache, "blocked");
  const env = { XDG_CACHE_HOME: blockedCache };
  const startedAt = 1_800_000_000_000;

  assert.equal(shouldShowLegacyCommandWarning({ env, home: root, interactive: true, now: startedAt }), false);
  assert.equal(shouldShowLegacyCommandWarning({ env, home: root, interactive: true, now: startedAt + 1 }), false);
  assert.equal(shouldShowLegacyCommandWarning({
    env,
    home: root,
    interactive: true,
    now: startedAt + LEGACY_COMMAND_WARNING_INTERVAL_MS,
  }), false);
});
