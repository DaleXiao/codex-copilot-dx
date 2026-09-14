import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { updateImageSkill } from "../src/image-skill.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-skill-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexPath = path.join(home, ".codex", "config.toml");
  const skillDirectory = path.join(home, ".codex", "skills", "ccdx-image");
  return { home, codexPath, skillDirectory, skillPath: path.join(skillDirectory, "SKILL.md"), helperPath: path.join(skillDirectory, "scripts", "generate.mjs") };
}

test("image skill is absent by default and installs a self-contained helper only when enabled", (t) => {
  const fixtureData = fixture(t);
  const disabled = updateImageSkill({ ...fixtureData, enabled: false });
  assert.equal(disabled.changed, false);
  assert.equal(fs.existsSync(fixtureData.skillDirectory), false);
  const installed = updateImageSkill({ ...fixtureData, enabled: true });
  assert.equal(installed.changed, true);
  assert.equal(installed.skillPath, fixtureData.skillPath);
  const help = execFileSync(process.execPath, [fixtureData.helperPath, "--help"], { encoding: "utf8", cwd: fixtureData.home });
  assert.match(help, /^Usage: generate\.mjs/);
  const repeated = updateImageSkill({ ...fixtureData, enabled: true });
  assert.equal(repeated.changed, false);
  assert.equal(fs.existsSync(fixtureData.codexPath), false);
  installed.rollback();
  installed.rollback();
  assert.equal(fs.existsSync(fixtureData.skillDirectory), false);
});

test("image skill update and disable rollback restore the exact previous owned pair", (t) => {
  const fixtureData = fixture(t);
  updateImageSkill({ ...fixtureData, enabled: true });
  const originalSkill = fs.readFileSync(fixtureData.skillPath);
  const originalHelper = fs.readFileSync(fixtureData.helperPath);
  const update = updateImageSkill({ ...fixtureData, enabled: true, adapterPort: 9876, nodePath: "/new node/bin/node" });
  assert.equal(update.changed, true);
  assert.notDeepEqual(fs.readFileSync(fixtureData.helperPath), originalHelper);
  update.rollback();
  assert.deepEqual(fs.readFileSync(fixtureData.skillPath), originalSkill);
  assert.deepEqual(fs.readFileSync(fixtureData.helperPath), originalHelper);
  const disabled = updateImageSkill({ ...fixtureData, enabled: false });
  assert.equal(disabled.changed, true);
  assert.equal(fs.existsSync(fixtureData.skillPath), false);
  disabled.rollback();
  assert.deepEqual(fs.readFileSync(fixtureData.skillPath), originalSkill);
  assert.deepEqual(fs.readFileSync(fixtureData.helperPath), originalHelper);
});

test("image skill preserves unrelated files and refuses unowned or modified files", (t) => {
  const fixtureData = fixture(t);
  updateImageSkill({ ...fixtureData, enabled: true });
  const notes = path.join(fixtureData.skillDirectory, "notes.txt");
  fs.writeFileSync(notes, "user notes");
  updateImageSkill({ ...fixtureData, enabled: false });
  assert.equal(fs.readFileSync(notes, "utf8"), "user notes");
  fs.writeFileSync(fixtureData.skillPath, "my existing skill");
  assert.throws(() => updateImageSkill({ ...fixtureData, enabled: true }), /Preserving/);
  assert.equal(fs.readFileSync(fixtureData.skillPath, "utf8"), "my existing skill");
  fs.unlinkSync(fixtureData.skillPath);
  updateImageSkill({ ...fixtureData, enabled: true });
  fs.appendFileSync(fixtureData.helperPath, "\n// user changes\n");
  const modified = fs.readFileSync(fixtureData.helperPath);
  const disabled = updateImageSkill({ ...fixtureData, enabled: false });
  assert.equal(disabled.preserved, true);
  assert.equal(disabled.changed, true);
  assert.deepEqual(fs.readFileSync(fixtureData.helperPath), modified);
  assert.equal(fs.existsSync(fixtureData.skillPath), false);
  disabled.rollback();
  assert.deepEqual(fs.readFileSync(fixtureData.helperPath), modified);
  assert.equal(fs.existsSync(fixtureData.skillPath), true);
});

test("image skill does not follow an existing skill-directory symlink", (t) => {
  const fixtureData = fixture(t);
  fs.mkdirSync(path.dirname(fixtureData.skillDirectory), { recursive: true });
  const target = path.join(fixtureData.home, "user-skill");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "SKILL.md"), "leave alone");
  fs.symlinkSync(target, fixtureData.skillDirectory, "dir");
  assert.throws(() => updateImageSkill({ ...fixtureData, enabled: true }), /regular directory/);
  const disabled = updateImageSkill({ ...fixtureData, enabled: false });
  assert.equal(disabled.changed, false);
  assert.equal(disabled.preserved, true);
  disabled.rollback();
  assert.equal(fs.readFileSync(path.join(target, "SKILL.md"), "utf8"), "leave alone");
});
