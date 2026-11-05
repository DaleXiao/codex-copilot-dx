import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createImageDockControl, imageDockPaths } from "../src/codex-image-dock.mjs";
import { prepareImageHostLaunch } from "../src/codex-image-host-launch.mjs";
import { createServiceControl } from "../src/service-control.mjs";
import { parseCliArgs } from "../src/cli-options.mjs";
import { runImageCommand } from "../src/cli-image.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-dock-"));t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = { home: directory, env: {}, platform: "darwin" }, files = imageDockPaths(options), state = { value: "", manager: "Aqua", fail: false, ready: true, prepared: 0 }, calls = [];
  const control = createImageDockControl({ ...options, uid: () => 501,
    prepare: async () => { state.prepared++;state.ready = true;fs.mkdirSync(path.dirname(files.wrapper), { recursive: true });fs.writeFileSync(files.wrapper, "owned fixture");return { env: { CODEX_CLI_PATH: files.wrapper } }; },
    exec: async (command, args) => {
      calls.push([command, ...args]);
      if (command === files.wrapper) { if (!state.ready) throw Error("removed runtime");return { stdout: "" }; }
      if (args[0] === "managername") return { stdout: state.manager };
      if (args[0] === "manageruid") return { stdout: "501" };
      if (args[0] === "getenv") return { stdout: state.value };
      if (args[0] === "setenv") { if (state.fail) throw Error("denied");state.value = args[2];return { stdout: "" }; }
      if (args[0] === "unsetenv") { state.value = "";return { stdout: "" }; }
      if (args[0] === "print") throw Object.assign(Error("not loaded"), { code: 113 });
      throw Error("unexpected command");
    } });
  return { directory, options, files, state, control, calls };
}

test("Dock enable, diagnose, upgrade repair and disable preserve ownership", async t => {
  const f = fixture(t);assert.equal(f.control.snapshot().state, "disabled");
  const enabled = await f.control.action("enable");assert.equal(enabled.state, "pending_reopen");assert.equal(enabled.tool_registration, "unconfirmed");
  assert.equal(f.state.value, f.files.wrapper);assert.ok(fs.readFileSync(f.files.agent, "utf8").includes("RunAtLoad"));
  assert.ok(fs.readFileSync(f.files.script, "utf8").includes("--ccdx-host-check"));
  if (process.platform !== "win32") execFileSync("/bin/sh", ["-n", f.files.script]);
  if (process.platform === "darwin") execFileSync("/usr/bin/plutil", ["-lint", f.files.agent]);
  f.state.ready = false;assert.equal((await f.control.action("status")).state, "needs_repair");
  assert.equal((await f.control.action("repair")).state, "pending_reopen");assert.equal(f.state.prepared, 2);
  assert.equal((await f.control.action("disable")).state, "disabled");assert.equal(f.state.value, "");assert.equal(fs.existsSync(f.files.agent), false);
});

test("custom GUI values and external edits are preserved", async t => {
  const f = fixture(t);f.state.value = "/custom/codex";
  await assert.rejects(f.control.action("enable"), /custom/);assert.equal(f.state.prepared, 0);
  f.state.value = "";await f.control.action("enable");f.state.value = "/new/custom";
  assert.equal((await f.control.action("disable")).external_value_preserved, true);assert.equal(f.state.value, "/new/custom");
  f.state.value = "";await f.control.action("enable");fs.appendFileSync(f.files.agent, "external edit");
  await assert.rejects(f.control.action("disable"), /changed externally/);assert.equal(f.state.value, f.files.wrapper);
});

test("failed environment changes roll back saved setup, and non-GUI contexts do not mutate", async t => {
  const f = fixture(t);f.state.fail = true;
  await assert.rejects(f.control.action("enable"), /previous settings were restored/);
  assert.equal(fs.existsSync(f.files.state), false);assert.equal(fs.existsSync(f.files.agent), false);assert.equal(f.state.value, "");
  f.state.manager = "Background";await assert.rejects(f.control.action("enable"), /graphical login/);
  assert.equal(createImageDockControl({ ...f.options, platform: "win32" }).snapshot().supported, false);
});

test("UI and terminal Dock operations use the same service controller", async t => {
  const f = fixture(t), service = createServiceControl({ home: f.directory, env: {}, imageDock: f.control });
  let output = "";
  const result = await runImageCommand({ action: parseCliArgs(["app", "codex", "image", "dock", "enable"]).action, output: { write: v => { output += v; } },
    request: async input => input.body ? service.action(input.body) : service.snapshot() });
  assert.equal(result.dock.state, "pending_reopen");assert.match(output, /graphical login session/);
  assert.equal((await service.action({ action: "image", operation: "dock-disable" })).features.image.dock.state, "disabled");
});

test("a removed host runtime falls back to the untouched native CLI", { skip: process.platform === "win32" }, async t => {
  const f = fixture(t), app = path.join(f.directory, "ChatGPT.app"), codex = path.join(app, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
  fs.mkdirSync(path.dirname(codex), { recursive: true });fs.writeFileSync(codex, '#!/bin/sh\necho native-fallback\n', { mode: 0o700 });
  const launch = await prepareImageHostLaunch({ ...f.options, persistent: true, discoverApp: async () => ({ app }), exec: async () => ({ stdout: "codex-cli 0.166.0" }), entry: path.join(f.directory, "removed.mjs") });
  assert.throws(() => execFileSync(launch.env.CODEX_CLI_PATH, ["--ccdx-host-check"], { stdio: "pipe" }));
  assert.equal(execFileSync(launch.env.CODEX_CLI_PATH, ["--version"], { encoding: "utf8" }).trim(), "native-fallback");
});
