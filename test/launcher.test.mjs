import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { autoLaunchEnabled, launchAttempts, openCodex, macPredictionAppProcesses } from "../src/launcher.mjs";

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

test("prediction route launches only the exact verified App, without profile or auth overrides", async () => {
  const args = ["/Applications/ChatGPT.app", "--args", "--proxy-pac-url=http://127.0.0.1:12345/proxy.pac"];
  const { spawnImpl, calls } = fakeSpawn({ [JSON.stringify(args)]: 0 });
  let inspections = 0;
  assert.equal(await openCodex({ env: {}, platform: "darwin", spawnImpl,
    predictionPacUrl: "http://127.0.0.1:12345/proxy.pac", predictionApp: "/Applications/ChatGPT.app",
    macAppProcesses: () => ++inspections === 1 ? [] : [{ pid: 123, readable: true, route: "http://127.0.0.1:12345/proxy.pac" }] }), true);
  assert.deepEqual(calls, [args]);
});

test("macOS prediction inspection reads only exact App main-process arguments and returns no unrelated data", () => {
  const app = "/Applications/ChatGPT.app", calls = [];
  const listing = ` 101 ${app}/Contents/MacOS/ChatGPT\n102 ${app}/Contents/Frameworks/Helper.app/Contents/MacOS/Helper\n103 /Applications/Other.app/Contents/MacOS/ChatGPT\n104 ${app}/Contents/MacOS/Codex\n`;
  const rows = macPredictionAppProcesses(app, { exec(command, args, options) {
    calls.push(args);assert.equal(command, "/bin/ps");assert.equal(options.timeout, 2000);
    if (args[0] === "-axo") return listing;
    if (args[1] === "101") return `${app}/Contents/MacOS/ChatGPT --proxy-pac-url="http://127.0.0.1:12345/proxy.pac" --private-value=must-not-return`;
    throw new Error("fixture unreadable process");
  } });
  assert.deepEqual(rows, [{ pid: 101, readable: true, route: "http://127.0.0.1:12345/proxy.pac" }, { pid: 104, readable: false, route: null }]);
  assert.equal(calls.length, 3);assert.doesNotMatch(JSON.stringify(rows), /private-value|must-not-return/);
  assert.throws(() => macPredictionAppProcesses("/Applications/Other.app", { exec() { assert.fail(); } }), /Unknown/);
  assert.throws(() => macPredictionAppProcesses(app, { exec() { throw new Error("cannot inspect"); } }), /cannot inspect/);
  for (const args of [
    `/Applications/Other.app/main --proxy-pac-url=http://127.0.0.1:12345/proxy.pac`,
    `${app}/Contents/MacOS/ChatGPT --proxy-pac-url=http://127.0.0.1:12345/proxy.pac --proxy-pac-url=http://127.0.0.1:54321/proxy.pac`,
    `${app}/Contents/MacOS/ChatGPT --proxy-pac-url=http://127.0.0.1:12345/proxy.pac.evil`,
  ]) {
    const [row] = macPredictionAppProcesses(app, { exec(_command, flags) {
      return flags[0] === "-axo" ? `101 ${app}/Contents/MacOS/ChatGPT\n` : args;
    } });
    assert.equal(row.route, null, "changed identity, ambiguous or partial arguments cannot verify a route");
  }
});

test("macOS prediction reuse verifies the current route without spawning or stopping an App", async () => {
  const pac = "http://127.0.0.1:12345/proxy.pac";
  const options = { env: {}, platform: "darwin", predictionApp: "/Applications/ChatGPT.app", predictionPacUrl: pac,
    spawnImpl() { assert.fail("running App must not be relaunched"); } };
  assert.equal(await openCodex({ ...options, macAppProcesses: () => [{ pid: 123, readable: true, route: pac }] }), true);
  for (const processes of [
    [{ pid: 123, readable: true, route: "http://127.0.0.1:54321/proxy.pac" }],
    [{ pid: 123, readable: true, route: null }],
    [{ pid: 123, readable: false, route: pac }],
    [{ pid: 123, readable: true, route: pac }, { pid: 124, readable: true, route: pac }],
  ]) assert.equal(await openCodex({ ...options, macAppProcesses: () => processes }), false);
  assert.equal(await openCodex({ ...options, macAppProcesses() { throw new Error("process access unavailable"); } }), false);
});

test("macOS prediction launch does not report success when the active App drops its route", async () => {
  const pac = "http://127.0.0.1:12345/proxy.pac";
  const args = ["/Applications/ChatGPT.app", "--args", `--proxy-pac-url=${pac}`];
  const { spawnImpl } = fakeSpawn({ [JSON.stringify(args)]: 0 });let inspections = 0;
  assert.equal(await openCodex({ env: {}, platform: "darwin", spawnImpl, predictionApp: args[0], predictionPacUrl: pac,
    macAppProcesses: () => ++inspections === 1 ? [] : [{ pid: 123, readable: true, route: null }] }), false);
  assert.equal(inspections, 2, "an observed wrong route fails immediately rather than waiting or relaunching");
});

test("a persisted App preference is reuse evidence, not a verified launch route or permission to restart", async () => {
  let route;
  const logs = [];
  const ok = await openCodex({ env: {}, platform: "darwin", predictionApp: "/Applications/ChatGPT.app",
    predictionPacUrl: "http://127.0.0.1:12345/proxy.pac", persistedPredictionRoute: true,
    macAppProcesses: () => [{ pid: 123, readable: true, route: null }], onPredictionRoute: value => { route = value; },
    log: value => logs.push(value), preparePredictionRoute() { assert.fail("running App must not be edited"); },
    spawnImpl() { assert.fail("running App must not be restarted"); } });
  assert.equal(ok, true);assert.equal(route, "persisted");
  assert.match(logs.join("\n"), /waiting for configuration traffic/);assert.doesNotMatch(logs.join("\n"), /route verified/);
});

test("macOS prediction launch allows delayed main-process visibility without an unbounded watcher", async () => {
  const pac = "http://127.0.0.1:12345/proxy.pac", args = ["/Applications/ChatGPT.app", "--args", `--proxy-pac-url=${pac}`];
  const { spawnImpl } = fakeSpawn({ [JSON.stringify(args)]: 0 });let inspections = 0;
  assert.equal(await openCodex({ env: {}, platform: "darwin", spawnImpl, predictionApp: args[0], predictionPacUrl: pac,
    macAppProcesses: () => ++inspections < 4 ? [] : [{ pid: 123, readable: true, route: pac }] }), true);
  assert.equal(inspections, 4);
  const failure = fakeSpawn({});
  assert.equal(await openCodex({ env: {}, platform: "darwin", spawnImpl: failure.spawnImpl, predictionApp: args[0], predictionPacUrl: pac,
    macAppProcesses: () => [] }), false);
  assert.equal(failure.calls.length, 1, "no unverified App fallback when the exact prediction launch fails");
});

test("disabled auto-launch and ordinary macOS launch never inspect prediction processes", async () => {
  const { spawnImpl } = fakeSpawn({ '["-b","com.openai.codex"]': 0 });
  const options = { platform: "darwin", spawnImpl, macAppProcesses() { assert.fail("must not inspect"); } };
  assert.equal(await openCodex({ ...options, env: {} }), true);
  assert.equal(await openCodex({ ...options, env: { CCDX_AUTO_LAUNCH: "0" },
    predictionApp: "/Applications/ChatGPT.app", predictionPacUrl: "http://127.0.0.1:12345/proxy.pac" }), false);
});

test("untrusted prediction launch metadata cannot inject App arguments", async () => {
  for (const overrides of [
    { predictionPacUrl: "https://remote.test/proxy.pac", predictionApp: "/Applications/ChatGPT.app" },
    { predictionPacUrl: "http://127.0.0.1:12345/proxy.pac", predictionApp: "--bad-option" },
  ]) {
    const { spawnImpl, calls } = fakeSpawn({ '["-b","com.openai.codex"]': 0 });
    await openCodex({ env: {}, platform: "darwin", spawnImpl, ...overrides });
    assert.deepEqual(calls, [["-b", "com.openai.codex"]]);
  }
});
