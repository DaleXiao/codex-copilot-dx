import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { openDashboard } from "../src/browser-launch.mjs";
test("browser opening is bounded, platform-specific, and restricted to the local dashboard", async () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const calls = [];
    const result = await openDashboard("http://127.0.0.1:2345", { platform, env: { DISPLAY: ":1" }, interactive: true,
      spawnImpl(command, args) { calls.push({ command, args });const child = new EventEmitter();queueMicrotask(() => child.emit("exit", 0));return child; } });
    assert.equal(result.opened, true);assert.equal(calls.length, 1);assert.ok(calls[0].args.includes("http://127.0.0.1:2345/"));
  }
  await assert.rejects(openDashboard("https://evil.invalid"), /local HTTP/);
});
test("headless, query commands, SSH and opted-out starts do not launch a browser", async () => {
  for (const options of [{ interactive: false }, { enabled: false }, { env: { CI: "1" } }, { env: { SSH_CONNECTION: "remote" } }, { platform: "linux", env: {} }]) {
    const result = await openDashboard("http://127.0.0.1:2026", { interactive: true, platform: "darwin", env: {}, ...options,
      spawnImpl: () => assert.fail("must not launch") });assert.equal(result.state, "skipped");
  }
});

test("external launch inherits no pipes and does not wait indefinitely for the opened Windows app", async () => {
  const child = new EventEmitter();let unrefs = 0;
  child.unref = () => { unrefs++; };
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const result = await openDashboard("http://127.0.0.1:2345", { platform: "win32", env: {}, interactive: true, timeoutMs: 5,
      spawnImpl(_command, _args, options) { assert.equal(options.stdio, "ignore");assert.equal(options.windowsHide, true);return child; } });
    assert.equal(result.state, "unavailable");assert.equal(unrefs, 1);
    child.emit("exit", 0); // A late exit cannot extend or restart the completed launch.
  } finally { clearTimeout(keepAlive); }
});
