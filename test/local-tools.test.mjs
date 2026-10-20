import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalTools } from "../src/local-tools.mjs";
import { parseCliArgs, cliHelp } from "../src/cli-options.mjs";
import { pauseServiceFeature } from "../src/cli-tools.mjs";
import { servicePreferences } from "../src/user-settings.mjs";

test("configuration repair requires a current preview and preserves unrelated settings and a backup", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-local-tools-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, ".codex", "config.toml");fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = 'model = "my-model"\nopenai_base_url = "http://127.0.0.1:2025/v1"\n';fs.writeFileSync(file, before);
  const tools = createLocalTools({ home, env: {} }), first = tools.preview();
  fs.appendFileSync(file, '# user edit\n');
  assert.throws(() => tools.repair({ revision: first.revision }), { code: "config_preview_changed" });
  const preview = tools.preview(), result = tools.repair({ revision: preview.revision });
  assert.equal(result.status, "verified");assert.equal(result.changed, true);
  assert.equal(fs.readFileSync(`${file}.ccdx-doctor.bak`, "utf8"), `${before}# user edit\n`);
  assert.match(fs.readFileSync(file, "utf8"), /model = "my-model"/);
  assert.match(fs.readFileSync(file, "utf8"), /127\.0\.0\.1:2026\/v1/);
  fs.writeFileSync(file, 'broken = "');
  const invalid = tools.preview();assert.equal(tools.repair({ revision: invalid.revision }).status, "preserved");
  assert.equal(fs.readFileSync(file, "utf8"), 'broken = "');
});

test("local checks are singleflight and exported reports hide accounts, home paths and secrets", async () => {
  let calls = 0;
  const tools = createLocalTools({ home: "/private/home", env: {}, collect: async options => {
    calls++;assert.equal(options.checkAdapter, false);assert.equal(options.online, undefined);
    return [{ kind: "warn", message: "/private/home/.codex/config.toml work@example.test Bearer very-private-secret", token: "do not export" }];
  } });
  await Promise.all([tools.check(), tools.check()]);assert.equal(calls, 1);
  const report = JSON.stringify(tools.report());assert.doesNotMatch(report, /private-secret|private\/home|work@example|do not export/);
  assert.match(report, /\[account\]/);
});

test("network diagnostics do not execute macOS discovery on Linux", () => {
  const tools = createLocalTools({ platform: "linux", env: {} });
  const result = tools.network();assert.equal(result.source, "network_check");assert.match(result.summary, /TLS verification required/);
});

test("new command tools accept only explicit supported actions and expose help", () => {
  for (const args of [["web"], ["source", "github"], ["image", "pause"], ["prediction", "resume"], ["auth", "reauth"], ["reauth"], ["auth", "check"], ["auth", "logout", "--yes"], ["doctor", "network"], ["doctor", "report"]]) assert.ok(parseCliArgs(args).command);
  for (const args of [["web", "--help"], ["source", "--help"], ["image", "--help"], ["auth", "login", "--help"], ["doctor", "network", "--help"]]) {
    const parsed = parseCliArgs(args);assert.equal(parsed.command, "help");assert.match(cliHelp("ccdx", parsed.helpTopic), /Usage:/);
  }
  for (const args of [["web", "--yes"], ["auth", "login", "--login", "not/account"], ["auth", "logout", "--force"], ["image", "destroy"], ["doctor", "report", "--online"]]) assert.throws(() => parseCliArgs(args));
});

test("pause and resume retain setup, and offline operation explicitly requires startup", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-pause-tools-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const request = async () => { throw Error("offline"); };
  for (const feature of ["image", "prediction"]) {
    const paused = await pauseServiceFeature({ home, env: {}, feature, action: "pause", request });assert.match(paused, /paused.*Setup and credentials kept.*restart/);
    assert.equal(servicePreferences({ home, env: {} })[`${feature}_enabled`], false);
    await pauseServiceFeature({ home, env: {}, feature, action: "resume", request });assert.equal(servicePreferences({ home, env: {} })[`${feature}_enabled`], true);
  }
});
