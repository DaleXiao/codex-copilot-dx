import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { codexPaths } from "../src/codex-paths.mjs";
import { ensureCodexConfig } from "../src/config.mjs";
import { inspectCodexConfig } from "../src/codex-config-doctor.mjs";
import { ensureCodexThreadCompression } from "../src/codex-thread-compression.mjs";
import { withFileLockSync } from "../src/lock.mjs";

test("core setup, config doctor and optional compression honor the same CODEX_HOME", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-path-ownership-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { CODEX_HOME: path.join(home, "custom-codex") };
  const resolved = codexPaths({ env, home });
  ensureCodexConfig(2026, { env, home });
  assert.equal(fs.existsSync(path.join(home, ".codex")), false);
  assert.ok(inspectCodexConfig({ env, home }).some(x => x.kind === "ok"));
  await ensureCodexThreadCompression({ env, home, probe: async () => true });
  assert.match(fs.readFileSync(resolved.config, "utf8"), /local_thread_store_compression = true/);
  assert.equal(fs.existsSync(resolved.config+".ccdx.lock"), false);
});

test("cross-process settings writes reread after acquiring the same lock", { timeout: 5000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-settings-lock-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, ".config", "codex-copilot-dx"), file = path.join(directory, "config.json");
  fs.mkdirSync(directory, { recursive: true });fs.writeFileSync(file, '{"user_owned":true}\n');
  const lockModule = fileURLToPath(new URL("../src/lock.mjs", import.meta.url));
  const settingsModule = fileURLToPath(new URL("../src/user-settings.mjs", import.meta.url));
  const first = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';import {withFileLockSync} from ${JSON.stringify(lockModule)};
    withFileLockSync(${JSON.stringify(file+".lock")},()=>{process.stdout.write('locked\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);
      const value=JSON.parse(fs.readFileSync(${JSON.stringify(file)},'utf8'));value.peer_write=true;fs.writeFileSync(${JSON.stringify(file)},JSON.stringify(value));});
  `]);
  const firstExit = once(first, "exit");t.after(() => { if (first.exitCode === null) first.kill(); });
  await once(first.stdout, "data");
  const second = spawn(process.execPath, ["--input-type=module", "-e", `import {writeAutoReviewModel} from ${JSON.stringify(settingsModule)};writeAutoReviewModel('gpt-6.1-sol',{env:{},home:${JSON.stringify(home)}});`]);
  t.after(() => { if (second.exitCode === null) second.kill(); });
  assert.equal((await once(second, "exit"))[0], 0);assert.equal((await firstExit)[0], 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { user_owned: true, peer_write: true, auto_review_model: "gpt-6.1-sol" });
  assert.equal(fs.existsSync(file+".lock"), false);
});

test("nested synchronous writers cannot steal a live lock", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-live-lock-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "config.lock");
  withFileLockSync(file, () => {
    assert.throws(() => withFileLockSync(file, () => assert.fail("must not enter")), /being updated/);
    assert.equal(fs.existsSync(file), true);
  });
  assert.equal(fs.existsSync(file), false);
});
