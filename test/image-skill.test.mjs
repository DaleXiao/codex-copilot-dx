import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { updateImageSkill } from "../src/image-skill.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-skill-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexPath = path.join(home, ".codex", "config.toml");
  const skillDirectory = path.join(home, ".codex", "skills", "ccdx-image");
  const skillPath = path.join(skillDirectory, "SKILL.md");
  const helperPath = path.join(skillDirectory, "scripts", "generate.mjs");
  const referencePaths = ["editing.md", "helper.md"].map((name) => path.join(skillDirectory, "references", name));
  return { home, codexPath, skillDirectory, skillPath, helperPath, referencePaths, files: [skillPath, helperPath, ...referencePaths] };
}

function snapshot(files) {
  return files.map((file) => ({ content: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777, mtime: fs.statSync(file).mtimeMs }));
}

function assertRestored(files, before) {
  assert.deepEqual(snapshot(files).map(({ content, mode }) => ({ content, mode })), before.map(({ content, mode }) => ({ content, mode })));
}

test("image skill is absent by default and installs a self-contained helper only when enabled", (t) => {
  const fixtureData = fixture(t);
  const disabled = updateImageSkill({ ...fixtureData, enabled: false });
  assert.equal(disabled.changed, false);
  assert.equal(fs.existsSync(fixtureData.skillDirectory), false);
  const installed = updateImageSkill({ ...fixtureData, enabled: true });
  assert.equal(installed.changed, true);
  assert.equal(installed.skillPath, fixtureData.skillPath);
  const guidance = fs.readFileSync(fixtureData.skillPath, "utf8");
  const references = [...guidance.matchAll(/\[[^\]]+\]\((references\/[^)]+)\)/g)].map((match) => match[1]);
  assert.deepEqual(references, ["references/editing.md", "references/helper.md"]);
  assert.doesNotMatch(guidance, /```sh|--image-id|\{\{/);
  for (const reference of references) assert.ok(fs.readFileSync(path.join(fixtureData.skillDirectory, reference), "utf8").length > 0);
  for (const file of fixtureData.files) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const help = execFileSync(process.execPath, [fixtureData.helperPath, "--help"], { encoding: "utf8", cwd: fixtureData.home });
  assert.match(help, /^Usage: generate\.mjs/);
  assert.match(help, /--image-id/);
  const before = snapshot(fixtureData.files);
  const repeated = updateImageSkill({ ...fixtureData, enabled: true });
  assert.equal(repeated.changed, false);
  assert.deepEqual(snapshot(fixtureData.files), before);
  assert.equal(fs.existsSync(fixtureData.codexPath), false);
  installed.rollback();
  installed.rollback();
  assert.equal(fs.existsSync(fixtureData.skillDirectory), false);
});

test("installed self-contained helper validates editing input before contacting the adapter", (t) => {
  const fixtureData = fixture(t);
  updateImageSkill({ ...fixtureData, enabled: true, adapterPort: 1 });
  const result = spawnSync(process.execPath, [fixtureData.helperPath, "--prompt", "Make the sky blue", "--image-id", "../source.png"], {
    encoding: "utf8", cwd: fixtureData.home,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Invalid CCDX image ID/);
  assert.equal(fs.existsSync(path.join(fixtureData.home, "output")), false);
});

test("image skill update and disable rollback restore the entire owned bundle", (t) => {
  const fixtureData = fixture(t);
  updateImageSkill({ ...fixtureData, enabled: true });
  const originalSkill = fs.readFileSync(fixtureData.skillPath);
  const originalHelper = fs.readFileSync(fixtureData.helperPath);
  fs.chmodSync(fixtureData.referencePaths[1], 0o640);
  const originalBundle = snapshot(fixtureData.files);
  const update = updateImageSkill({ ...fixtureData, enabled: true, adapterPort: 9876, nodePath: "/new node/bin/node" });
  assert.equal(update.changed, true);
  assert.notDeepEqual(fs.readFileSync(fixtureData.helperPath), originalHelper);
  update.rollback();
  assertRestored(fixtureData.files, originalBundle);
  assert.deepEqual(fs.readFileSync(fixtureData.skillPath), originalSkill);
  assert.deepEqual(fs.readFileSync(fixtureData.helperPath), originalHelper);
  const disabled = updateImageSkill({ ...fixtureData, enabled: false });
  assert.equal(disabled.changed, true);
  assert.equal(fs.existsSync(fixtureData.skillPath), false);
  assert.equal(fs.existsSync(fixtureData.skillDirectory), false);
  disabled.rollback();
  assertRestored(fixtureData.files, originalBundle);
  assert.deepEqual(fs.readFileSync(fixtureData.skillPath), originalSkill);
  assert.deepEqual(fs.readFileSync(fixtureData.helperPath), originalHelper);
});

test("legacy two-file guidance upgrades and rolls back without leaving references", (t) => {
  const data = fixture(t);
  fs.mkdirSync(path.dirname(data.helperPath), { recursive: true });
  const body = "---\nname: ccdx-image\ndescription: Legacy image guidance.\n---\n\n# CCDX image generation\nLegacy workflow.\n";
  const helper = "// Legacy self-contained helper\n";
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  fs.writeFileSync(data.skillPath, body.replace("# CCDX", `<!-- ccdx:image-skill:${hash(body)} -->\n# CCDX`));
  fs.writeFileSync(data.helperPath, `// ccdx:image-helper:${hash(helper)}\n${helper}`);
  const before = snapshot([data.skillPath, data.helperPath]);
  const upgrade = updateImageSkill({ ...data, enabled: true });
  assert.equal(upgrade.changed, true);
  for (const file of data.referencePaths) assert.ok(fs.existsSync(file));
  upgrade.rollback();
  assertRestored([data.skillPath, data.helperPath], before);
  assert.equal(fs.existsSync(path.join(data.skillDirectory, "references")), false);
});

test("reference conflicts preserve the entire bundle, and disabling retains only user-modified files", (t) => {
  const data = fixture(t);
  updateImageSkill({ ...data, enabled: true });
  fs.appendFileSync(data.referencePaths[0], "\nUser editing instructions.\n");
  const before = snapshot(data.files);
  assert.throws(() => updateImageSkill({ ...data, enabled: true, adapterPort: 9876 }), /Preserving/);
  assertRestored(data.files, before);
  const disabled = updateImageSkill({ ...data, enabled: false });
  assert.equal(disabled.preserved, true);
  assert.deepEqual(fs.readFileSync(data.referencePaths[0]), before[2].content);
  for (const file of [data.skillPath, data.helperPath, data.referencePaths[1]]) assert.equal(fs.existsSync(file), false);
  disabled.rollback();
  assertRestored(data.files, before);
});

for (const existing of [false, true]) {
  for (const target of ["editing.md", "helper.md", "SKILL.md"]) {
    test(`image bundle rolls back a ${target} write failure (existing=${existing})`, (t) => {
      const data = fixture(t);
      if (existing) updateImageSkill({ ...data, enabled: true });
      // Simulate an older owned reference so the upgrade writes both references.
      if (existing) {
        const body = "# Previous editing reference\n";
        fs.writeFileSync(data.referencePaths[0], `<!-- ccdx:image-reference:${createHash("sha256").update(body).digest("hex")} -->\n${body}`);
      }
      const before = existing ? snapshot(data.files) : null;
      const rename = fs.renameSync;
      let injected = false;
      const stub = t.mock.method(fs, "renameSync", (from, to) => {
        rename(from, to);
        if (!injected && path.basename(to) === target) {
          injected = true;
          throw Object.assign(new Error("Injected post-rename failure"), { code: "EIO" });
        }
      });
      assert.throws(() => updateImageSkill({ ...data, enabled: true, nodePath: "/updated node/bin/node" }), /Injected/);
      stub.mock.restore();
      assert.equal(injected, true);
      if (existing) {
        assertRestored(data.files, before);
        const installedFiles = fs.readdirSync(data.skillDirectory, { recursive: true }).filter((file) => fs.statSync(path.join(data.skillDirectory, file)).isFile());
        assert.equal(installedFiles.length, 4);
      } else assert.equal(fs.existsSync(data.skillDirectory), false);
    });
  }
}

test("helper reference safely renders installed paths without replacing prompt text", (t) => {
  const data = fixture(t);
  const nodePath = "/fixture's node/$&/node";
  updateImageSkill({ ...data, enabled: true, nodePath });
  const reference = fs.readFileSync(data.referencePaths[1], "utf8");
  assert.ok(reference.includes("'/fixture'\\''s node/$&/node'"));
  assert.ok(reference.includes(`'${data.helperPath}'`));
  assert.doesNotMatch(reference, /\{\{NODE\}\}|\{\{HELPER\}\}/);
});

test("reference-directory symlinks are never followed", (t) => {
  const data = fixture(t);
  const target = path.join(data.home, "user-references");
  fs.mkdirSync(data.skillDirectory, { recursive: true });
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "editing.md"), "user-owned reference");
  fs.symlinkSync(target, path.join(data.skillDirectory, "references"), "dir");
  assert.throws(() => updateImageSkill({ ...data, enabled: true }), /regular directory/);
  assert.equal(updateImageSkill({ ...data, enabled: false }).preserved, true);
  assert.equal(fs.readFileSync(path.join(target, "editing.md"), "utf8"), "user-owned reference");
  assert.equal(fs.existsSync(data.skillPath), false);
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
