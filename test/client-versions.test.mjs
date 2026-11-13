import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClientVersionMonitor, inspectInstalledClientVersions, clientVersionChecks } from "../src/client-versions.mjs";
import { userSettingsPath } from "../src/user-settings.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-client-versions-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, home: path.join(root, "home"), systemApplications: path.join(root, "apps"), env: {} };
}
async function bundle(root, name, identifier, version, build, cliVersion) {
  const contents = path.join(root, name, "Contents");await fs.mkdir(contents, { recursive: true });
  await fs.writeFile(path.join(contents, "Info.plist"), `<plist><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${build}</string></dict></plist>`);
  if (cliVersion) {
    const directory = path.join(contents, "Resources", "codex-cli");await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "codex-package.json"), JSON.stringify({ version: cliVersion }));
  }
}

test("version observation detects upgrades across service restarts without reading conversations", async t => {
  const f = await fixture(t), monitorOptions = { ...f, platform: "darwin" };
  await bundle(f.systemApplications, "ChatGPT.app", "com.openai.codex", "26.1103.32239", "25471", "0.167.0-alpha.3.2");
  await bundle(f.systemApplications, "Claude.app", "com.anthropic.claudefordesktop", "4.23118.0", "100", null);
  let changes = [];
  const first = createClientVersionMonitor({ ...monitorOptions, onChange: names => changes.push(names) });
  assert.equal(first.snapshot().checked_at, null);
  const observed = await first.refresh();assert.equal(observed.codex[0].cli_version, "0.167.0-alpha.3.2");
  assert.equal(observed.claude[0].first_observed, true);assert.deepEqual(changes, []);
  const file = path.join(path.dirname(userSettingsPath(f)), "client-versions.json");
  const saved = await fs.readFile(file, "utf8"), stat = await fs.stat(file);
  if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600);
  assert.doesNotMatch(saved, /prompt|credential|token|contents|home/);
  await first.refresh();assert.equal(await fs.readFile(file, "utf8"), saved);assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
  first.close();
  await bundle(f.systemApplications, "Claude.app", "com.anthropic.claudefordesktop", "4.23119.0", "101", null);
  await bundle(f.systemApplications, "ChatGPT.app", "com.openai.codex", "26.1103.32239", "25471", "0.167.0-alpha.4.0");
  const second = createClientVersionMonitor({ ...monitorOptions, onChange: names => changes.push(names) });
  const updated = await second.refresh();
  assert.equal(updated.claude[0].previous.version, "4.23118.0");assert.equal(updated.claude[0].version, "4.23119.0");
  assert.equal(updated.codex[0].previous.cli_version, "0.167.0-alpha.3.2");assert.equal(updated.codex[0].cli_version, "0.167.0-alpha.4.0");
  assert.deepEqual(new Set(changes[0]), new Set(["codex", "claude"]));
  assert.match(clientVersionChecks(updated)[0].message, /Running version and feature compatibility are not confirmed/);
  second.close();
});

test("missing, malformed and multiple App installations stay distinct and unknown when unavailable", async t => {
  const f = await fixture(t);
  await bundle(f.systemApplications, "ChatGPT.app", "com.openai.codex", "26.1.1", "12", null);
  await bundle(path.join(f.home, "Applications"), "Codex.app", "com.openai.codex", "26.2.1", "13", null);
  await bundle(f.systemApplications, "Claude.app", "unknown.bundle", "4.1", "1", null);
  const rows = await inspectInstalledClientVersions({ ...f, platform: "darwin" });
  assert.deepEqual(rows.map(row => row.id), ["codex_system_chatgpt", "codex_user_codex"]);
  const monitor = createClientVersionMonitor({ ...f, platform: "darwin" }), state = await monitor.refresh();
  assert.equal(state.codex.length, 2);assert.deepEqual(state.claude, []);assert.match(clientVersionChecks(state)[1].message, /not observed/);
  monitor.close();
});

test("an App replaced between bundle and CLI metadata reads is not reported as a mixed version", async t => {
  const f = await fixture(t), app = "ChatGPT.app";
  await bundle(f.systemApplications, app, "com.openai.codex", "26.1.1", "12", "0.167.0-alpha.1");
  const stat = fs.stat.bind(fs);let changed = false;
  t.mock.method(fs, "stat", async (file, ...args) => {
    if (!changed && String(file).endsWith("codex-package.json")) {
      changed = true;await bundle(f.systemApplications, app, "com.openai.codex", "27.9999.1", "999", "0.168.0-alpha.1");
    }
    return stat(file, ...args);
  });
  assert.deepEqual(await inspectInstalledClientVersions({ ...f, platform: "darwin" }), []);
  t.mock.restoreAll();
  const rows = await inspectInstalledClientVersions({ ...f, platform: "darwin" });
  assert.equal(rows[0].version, "27.9999.1");assert.equal(rows[0].cli_version, "0.168.0-alpha.1");
});

test("a damaged observation file is preserved and failed or stuck checks cannot block callers", async t => {
  const f = await fixture(t), file = path.join(path.dirname(userSettingsPath(f)), "client-versions.json");
  await fs.mkdir(path.dirname(file), { recursive: true });await fs.writeFile(file, "not valid JSON");
  const rows = [{ id: "claude_system_claude", client: "claude", scope: "system", name: "Claude.app", version: "5.0.0", build: null, cli_version: null }];
  const monitor = createClientVersionMonitor({ ...f, inspect: async () => rows });
  const state = await monitor.refresh();assert.equal(state.claude[0].version, "5.0.0");assert.equal(state.persistence, "unavailable");
  assert.equal(await fs.readFile(file, "utf8"), "not valid JSON");monitor.close();

  let release, calls = 0;
  const blocked = createClientVersionMonitor({ ...f, timeoutMs: 20, inspect: () => { calls++;return new Promise(resolve => { release = resolve; }); } });
  assert.equal(blocked.snapshot().checked_at, null);assert.equal(calls, 0);
  const [one, two] = await Promise.all([blocked.refresh(), blocked.refresh()]);
  assert.deepEqual(one.codex, []);assert.deepEqual(two.claude, []);assert.equal(calls, 1);
  await blocked.refresh();assert.equal(calls, 1);release([]);blocked.close();
});

test("Windows uses only a recognized registered Codex version and leaves Claude unknown", async () => {
  const codex = await inspectInstalledClientVersions({ platform: "win32", env: {}, windowsCodexVersion: async () => "26.1103.32239.0" });
  assert.equal(codex[0].id, "codex_windows_codex");assert.equal(codex[0].version, "26.1103.32239.0");
  assert.deepEqual(await inspectInstalledClientVersions({ platform: "win32", env: {}, windowsCodexVersion: async () => null }), []);
});

test("Antigravity uses the same installed-version observation and preserves old version records",async t=>{
  const f=await fixture(t),options={...f,platform:"darwin"};
  await bundle(f.systemApplications,"Claude.app","com.anthropic.claudefordesktop","4.1","100",null);
  const old=createClientVersionMonitor(options);await old.refresh();old.close();
  await bundle(f.systemApplications,"Gemini.app","com.google.GeminiMacOS","1.141.3.1394","1394",null);
  const monitor=createClientVersionMonitor(options),first=await monitor.refresh();
  assert.equal(first.antigravity[0].version,"1.141.3.1394");assert.equal(first.claude[0].version,"4.1");
  assert.match(clientVersionChecks(first)[2].message,/Antigravity: Gemini.app 1.141.3.1394/);monitor.close();
  await bundle(f.systemApplications,"Gemini.app","com.google.GeminiMacOS","1.142.0","1400",null);
  const next=createClientVersionMonitor(options),updated=await next.refresh();assert.equal(updated.antigravity[0].previous.version,"1.141.3.1394");assert.ok(updated.antigravity[0].changed_at);next.close();
  await bundle(f.systemApplications,"Gemini.app","unknown.bundle","9.0","1",null);
  assert.equal((await inspectInstalledClientVersions(options)).some(row=>row.client==="antigravity"),false);
});

test("an unrecognized Claude major remains guarded through temporary observation failures", async t => {
  const f = await fixture(t), row = { id: "claude_system_claude", client: "claude", scope: "system", name: "Claude.app", version: "5.0.0", build: null, cli_version: null };
  let observed = [row];const monitor = createClientVersionMonitor({ ...f, inspect: async () => observed });
  assert.equal((await monitor.refresh()).claude_unrecognized, true);
  observed = [];const missing = await monitor.refresh();assert.deepEqual(missing.claude, []);assert.equal(missing.claude_unrecognized, true);
  observed = [{ ...row, version: "4.999.0" }];assert.equal((await monitor.refresh()).claude_unrecognized, false);monitor.close();
});

test("temporarily unreadable optional metadata is unknown rather than a false App update", async t => {
  const f = await fixture(t), row = { id: "codex_system_chatgpt", client: "codex", scope: "system", name: "ChatGPT.app",
    version: "26.1.1", build: "100", cli_version: "0.167.0-alpha.1" };
  let observed = [row], updates = 0;
  const monitor = createClientVersionMonitor({ ...f, inspect: async () => observed, onChange: () => { updates++; } });
  await monitor.refresh();observed = [{ ...row, build: null, cli_version: null }];
  const missing = await monitor.refresh();assert.equal(missing.codex[0].build, null);assert.equal(missing.codex[0].cli_version, null);
  assert.equal(missing.codex[0].changed_at, null);assert.equal(updates, 0);
  observed = [row];assert.equal((await monitor.refresh()).codex[0].changed_at, null);assert.equal(updates, 0);
  observed = [{ ...row, cli_version: "0.167.0-alpha.2" }];assert.ok((await monitor.refresh()).codex[0].changed_at);assert.equal(updates, 1);
  monitor.close();
});
