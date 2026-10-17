import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { computeThreadCompressionDefault, codexNeedsThreadCompressionDefault, ensureCodexThreadCompression } from "../src/codex-thread-compression.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-compression-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const binary = path.join(home, "codex");
  fs.writeFileSync(binary, "fixture");
  return { home, binary, filePath: path.join(home, "config.toml") };
}

test("compression default adds only its feature, retains comments, and is idempotent", () => {
  for (const content of [
    'model = "gpt-6.1-sol"\n',
    '["features"] # flags\ncontext_management = false\n\n[projects.sample]\ntrust_level = "trusted"\n',
    '[features]\ncontext_management = true',
  ]) {
    const updated = computeThreadCompressionDefault(content);
    assert.equal(updated.changed, true);
    const parsed = parse(updated.content);
    assert.equal(parsed.features.local_thread_store_compression, true);
    delete parsed.features.local_thread_store_compression;
    if (!Object.keys(parsed.features).length) delete parsed.features;
    assert.deepEqual(parsed, parse(content));
    assert.deepEqual(computeThreadCompressionDefault(updated.content), { content: updated.content, changed: false });
    if (content.includes("# flags")) assert.ok(updated.content.includes("# flags"));
  }
});

test("compression preserves explicit values, profiles and alternative feature declarations", () => {
  for (const content of [
    '[features]\nlocal_thread_store_compression = false\n',
    '[features]\nlocal_thread_store_compression = true\n',
    'features.local_thread_store_compression = false\n',
    'features = { local_thread_store_compression = true }\n',
    '[profiles.work.features]\nlocal_thread_store_compression = false\n',
    'local_thread_store_compression = true\n',
    'features = { context_management = false }\n',
    'features.context_management = true\n',
    '[features.context_management]\ncustom = true\n',
  ]) assert.deepEqual(computeThreadCompressionDefault(content), { content, changed: false });
});

test("compression probe is local, isolated, bounded and checks every installed App reader", async t => {
  const { binary, home } = fixture(t);
  const second = path.join(home, "second-codex");
  fs.writeFileSync(second, "fixture");
  let calls = 0;
  let isolated;
  const run = async (state, paths = [binary]) => codexNeedsThreadCompressionDefault({
    binaryPaths: paths,
    execFileFn: async (file, args, options) => {
      calls++;
      assert.ok(paths.map(candidate => fs.realpathSync(candidate)).includes(file));
      assert.deepEqual(args, ["features", "list"]);
      assert.equal(options.timeout, 1500);
      assert.equal(options.maxBuffer, 128 * 1024);
      assert.equal(options.cwd, options.env.CODEX_HOME);
      assert.notEqual(options.cwd, home);
      assert.deepEqual(Object.keys(options.env).sort(), ["CODEX_HOME", "PATH"]);
      assert.ok(fs.existsSync(options.cwd));
      isolated = options.cwd;
      return { stdout: `other_feature stable true\nlocal_thread_store_compression ${file === fs.realpathSync(second) ? "removed false" : state}\n` };
    },
  });
  for (const stage of ["under development", "experimental", "beta", "stable"]) assert.equal(await run(`${stage} false`), true);
  for (const row of ["stable true", "removed false", "deprecated false", "unknown false", "stable maybe"]) assert.equal(await run(row), false);
  assert.equal(await run("stable false", [binary, second]), false);
  assert.equal(await run("stable false", [binary, binary]), true);
  assert.equal(fs.existsSync(isolated), false);
  const before = calls;
  assert.equal(await run("stable false", [path.join(home, "missing")]), false);
  assert.equal(calls, before);
  for (const execFileFn of [async () => { throw new Error("timeout"); }, async () => ({ stdout: "" }), async () => ({ stdout: "local_thread_store_compression stable false\nlocal_thread_store_compression stable false" })]) {
    assert.equal(await codexNeedsThreadCompressionDefault({ binaryPaths: [binary], execFileFn }), false);
  }
});

test("optional compression setup preserves user edits during probe and unchanged inode", async t => {
  const { filePath } = fixture(t);
  const before = '[features]\ncontext_management = true\n';
  fs.writeFileSync(filePath, before);
  await ensureCodexThreadCompression({ filePath, probe: async () => true });
  assert.equal(parse(fs.readFileSync(filePath, "utf8")).features.local_thread_store_compression, true);
  const stat = fs.statSync(filePath);
  await ensureCodexThreadCompression({ filePath, probe: async () => { assert.fail("configured must skip probe"); } });
  assert.equal(fs.statSync(filePath).ino, stat.ino);
  fs.writeFileSync(filePath, before);
  const optedOut = `${before}local_thread_store_compression = false\n`;
  await ensureCodexThreadCompression({ filePath, probe: async () => { fs.writeFileSync(filePath, optedOut); return true; } });
  assert.equal(fs.readFileSync(filePath, "utf8"), optedOut);
  fs.writeFileSync(filePath, before);
  await ensureCodexThreadCompression({ filePath, probe: async () => { fs.writeFileSync(filePath, `${before}[projects.new]\ntrust_level = "trusted"\n`); return true; } });
  assert.deepEqual(parse(fs.readFileSync(filePath, "utf8")).projects, parse('[projects.new]\ntrust_level = "trusted"\n').projects);
});

test("unsupported/default-on/failed probes and unsafe config cannot block optional setup", async t => {
  const { filePath } = fixture(t);
  const before = '[features]\ncontext_management = true\n';
  for (const probe of [async () => false, async () => { throw new Error("private failure"); }]) {
    fs.writeFileSync(filePath, before);
    await assert.doesNotReject(ensureCodexThreadCompression({ filePath, probe }));
    assert.equal(fs.readFileSync(filePath, "utf8"), before);
  }
  for (const invalid of ['secret = "private', Buffer.from([0xff])]) {
    fs.writeFileSync(filePath, invalid);
    const bytes = fs.readFileSync(filePath);
    await assert.doesNotReject(ensureCodexThreadCompression({ filePath, probe: async () => { assert.fail("invalid must skip probe"); } }));
    assert.deepEqual(fs.readFileSync(filePath), bytes);
  }
  await assert.doesNotReject(ensureCodexThreadCompression({ filePath: path.join(filePath, "missing") }));
});
