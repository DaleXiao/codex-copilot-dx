import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { autoLaunchEnabled, launchAttempts, openCodex } from "../src/launcher.mjs";

function fakeSpawn(exitPlan) {
  // exitPlan: map from JSON.stringify(args) -> exit code
  const calls = [];
  const spawnImpl = (_cmd, args) => {
    calls.push(args);
    const child = new EventEmitter();
    const key = JSON.stringify(args);
    const code = key in exitPlan ? exitPlan[key] : 1;
    queueMicrotask(() => child.emit("exit", code));
    return child;
  };
  return { spawnImpl, calls };
}

test("autoLaunchEnabled defaults to true", () => {
  assert.equal(autoLaunchEnabled({}), true);
  assert.equal(autoLaunchEnabled({ CCDX_AUTO_LAUNCH: "" }), true);
  assert.equal(autoLaunchEnabled({ CCDX_AUTO_LAUNCH: "1" }), true);
});

test("autoLaunchEnabled honors disabling values", () => {
  for (const v of ["0", "false", "no", "off", "OFF"]) {
    assert.equal(autoLaunchEnabled({ CCDX_AUTO_LAUNCH: v }), false, v);
  }
});

test("launchAttempts tries bundle id first", () => {
  const attempts = launchAttempts();
  assert.deepEqual(attempts[0], ["-b", "com.openai.codex"]);
  assert.ok(attempts.some((a) => a[0] === "/Applications/ChatGPT.app"));
});

test("openCodex succeeds via bundle id without falling back", async () => {
  const { spawnImpl, calls } = fakeSpawn({ '["-b","com.openai.codex"]': 0 });
  const ok = await openCodex({ env: {}, spawnImpl, platform: "darwin" });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
});

test("openCodex falls back to app path when bundle id fails", async () => {
  const { spawnImpl, calls } = fakeSpawn({ '["/Applications/ChatGPT.app"]': 0 });
  const ok = await openCodex({ env: {}, spawnImpl, platform: "darwin" });
  assert.equal(ok, true);
  // bundle id + Codex.app both fail, ChatGPT.app succeeds
  assert.equal(calls.length, 3);
});

test("openCodex returns false when nothing launches", async () => {
  const { spawnImpl } = fakeSpawn({});
  const ok = await openCodex({ env: {}, spawnImpl, platform: "darwin" });
  assert.equal(ok, false);
});

test("openCodex skips launching when disabled", async () => {
  const { spawnImpl, calls } = fakeSpawn({ '["-b","com.openai.codex"]': 0 });
  const ok = await openCodex({ env: { CCDX_AUTO_LAUNCH: "0" }, spawnImpl, platform: "darwin" });
  assert.equal(ok, false);
  assert.equal(calls.length, 0);
});

test("openCodex is a no-op on non-darwin", async () => {
  const { spawnImpl, calls } = fakeSpawn({});
  const ok = await openCodex({ env: {}, spawnImpl, platform: "linux" });
  assert.equal(ok, false);
  assert.equal(calls.length, 0);
});
