import test from "node:test";
import assert from "node:assert/strict";
import { inspectCodexApp, controlCodexApp } from "../src/codex-app-control.mjs";

const app = "/Applications/ChatGPT.app";
test("App inspection ties host evidence to the selected process ancestry", async () => {
  const rows = ` 1 0 /sbin/launchd\n 20 1 ${app}/Contents/MacOS/ChatGPT\n 21 20 helper\n 22 21 node\n 23 1 node\n`;
  const exec = async (command, args) => { assert.equal(command, "/bin/ps");assert.deepEqual(args, ["-axo", "pid=,ppid=,comm="]);return { stdout: rows }; };
  assert.deepEqual(await inspectCodexApp(app, [{ pid: 22, connected: true, threads: ["observed"] }], { platform: "darwin", exec }),
    { status: "running", pid: 20, host: "connected", tool_registration: "observed" });
  assert.deepEqual(await inspectCodexApp(app, [{ pid: 23, connected: true, threads: ["other"] }, { pid: 22, connected: false }], { platform: "darwin", exec }),
    { status: "running", pid: 20, host: "unconfirmed", tool_registration: "unconfirmed" });
  assert.equal((await inspectCodexApp(app, [], { platform: "darwin", exec: async () => ({ stdout: "1 0 /sbin/launchd" }) })).status, "stopped");
  assert.equal((await inspectCodexApp(app, [], { platform: "darwin", exec: async () => ({ stdout: rows + ` 24 1 ${app}/Contents/MacOS/ChatGPT\n` }) })).status, "multiple");
  assert.equal((await inspectCodexApp(app, [], { platform: "win32", exec })).status, "unsupported");
  await assert.rejects(inspectCodexApp("/Applications/Other.app", [], { platform: "darwin", exec }), /Unrecognized/);
});

test("native App actions are limited to the exact App and never use force termination", async () => {
  const calls = [];
  const exec = async (command, args) => { calls.push({ command, args });return { stdout: "sent\n" }; };
  assert.equal(await controlCodexApp(app, 20, "quit", { platform: "darwin", exec }), "sent");
  assert.equal(await controlCodexApp(app, 20, "activate", { platform: "darwin", exec }), "sent");
  assert.equal(calls[0].command, "/usr/bin/osascript");assert.deepEqual(calls[0].args.slice(-3), ["20", app, "quit"]);
  assert.match(calls[0].args[3], /bundleIdentifier/);assert.match(calls[0].args[3], /app\.terminate/);assert.doesNotMatch(calls[0].args[3], /forceTerminate|SIGKILL/);
  await assert.rejects(controlCodexApp(app, 20, "force", { platform: "darwin", exec }), /Invalid/);
  await assert.rejects(controlCodexApp("/Applications/Other.app", 20, "quit", { platform: "darwin", exec }), /Invalid/);
});
