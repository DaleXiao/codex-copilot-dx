import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createImageHostState } from "../src/image-host-state.mjs";
import { controlImage, checkImageConnection } from "../src/image-control.mjs";
import { ADAPTER_PROTOCOL_VERSION } from "../src/running-adapter.mjs";
import { invokeAdapter } from "../test-support/adapter.mjs";

test("runtime image evidence distinguishes registration, process exit and invalid reports", () => {
  let live = true;const state = createImageHostState({ alive: () => live, now: () => 10 });
  const host = { id: "11111111-1111-1111-1111-111111111111", pid: 123 };
  assert.equal(state.snapshot().tool_registration, "unconfirmed");
  state.report({ ...host, event: "connected" });assert.equal(state.snapshot().connected, true);
  state.report({ ...host, event: "registered", thread: "a".repeat(32) });assert.equal(state.snapshot().tool_registration, "observed");
  state.snapshot().hosts[0].threads.length = 0;assert.equal(state.snapshot().hosts[0].threads.length, 1);
  for (const bad of [{ ...host, event: "made_up" }, { ...host, event: "connected", prompt: "private" }, { ...host, event: "registered", thread: "raw-chat-id" }]) assert.throws(() => state.report(bad));
  live = false;assert.equal(state.snapshot().tool_registration, "unconfirmed");
  const resumed = createImageHostState({ alive: () => true });
  resumed.report({ ...host, event: "registered", thread: "b".repeat(32) });
  assert.equal(resumed.snapshot().connected, true);assert.equal(resumed.snapshot().tool_registration, "observed");
});

test("manual image repair prepares owned launch files and never reopens a running App", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-control-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let running = true, opened = 0, configured = 0;
  const options = { home, env: {}, integration: { configure: async () => { configured++; }, start: async () => ({ pacUrl: "route", app: "app", prepareRoute: async () => {} }) },
    prepare: async () => ({ app: "app", env: { CODEX_CLI_PATH: "owned" } }), inspect: async () => running ? { status: "running", pid: 123, host: "unconfirmed" } : { status: "stopped" },
    launch: async value => { assert.equal(value.predictionPacUrl, "route");assert.equal(value.imageHost.env.CODEX_CLI_PATH, "owned");opened++;return true; } };
  assert.equal((await controlImage("open", options)).status, "needs_app_relaunch");assert.equal(opened, 0);
  running = false;assert.equal((await controlImage("repair", options)).status, "prepared");assert.equal(opened, 0);
  assert.equal((await controlImage("open", options)).status, "opened_new_chat_required");assert.equal(opened, 1);assert.equal(configured, 3);
  await assert.rejects(controlImage("invalid", options));
  await assert.rejects(controlImage("repair", { ...options, prepare: async () => { throw Error("custom route preserved"); } }), /custom route/);
});

test("the explicit restart prepares both routes before normally closing the App", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-restart-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const actions = [], app = "/Applications/ChatGPT.app";let checks = 0, clock = 0;
  const options = { home, env: {}, confirmed: true, readSummary: () => ({ enabled: true, configured: true, selected_available: true }),
    integration: { configure: async () => actions.push("configure"), start: async () => { actions.push("prediction");return { pacUrl: "route", app, prepareRoute: async () => actions.push("route") }; } },
    prepare: async () => { actions.push("host");return { app, env: { CODEX_CLI_PATH: "owned" } }; },
    inspect: async () => ++checks < 3 ? { status: "running", host: "unconfirmed", pid: 123 } : { status: "stopped" },
    appControl: async (target, pid, action) => { assert.equal(target, app);assert.equal(pid, 123);actions.push(action);return "sent"; },
    wait: async ms => { clock += ms; }, now: () => clock,
    launch: async value => { assert.equal(value.predictionPacUrl, "route");assert.equal(value.imageHost.env.CODEX_CLI_PATH, "owned");actions.push("launch");return true; } };
  const result = await controlImage("restart", options);
  assert.equal(result.status, "opened_new_chat_required");assert.deepEqual(actions, ["configure", "host", "prediction", "route", "quit", "launch"]);
});

test("restart never closes an App on incomplete preparation, stale identity or refused quit", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-restart-refused-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let quits = 0, launches = 0, clock = 0, inspections = [];
  const app = "/Applications/ChatGPT.app", running = { status: "running", host: "unconfirmed", pid: 123 };
  const options = { home, env: {}, confirmed: true, readSummary: () => ({ enabled: true, configured: true, selected_available: true }),
    integration: { configure: async () => {}, start: async () => null }, prepare: async () => ({ app, env: { CODEX_CLI_PATH: "owned" } }),
    inspect: async () => inspections.shift() || running, appControl: async () => { quits++;return "sent"; },
    wait: async ms => { clock += ms; }, now: () => clock, quitTimeoutMs: 500, launch: async () => { launches++;return true; } };
  await assert.rejects(controlImage("restart", { ...options, confirmed: false }), /Confirm/);assert.equal(quits, 0);
  assert.equal((await controlImage("restart", { ...options, readSummary: () => ({ enabled: true, configured: false }) })).status, "image_unavailable");
  assert.equal((await controlImage("restart", { ...options, prepare: async () => { throw Error("custom route"); } }).catch(() => ({ status: "failed" }))).status, "failed");
  assert.equal((await controlImage("restart", { ...options, inspect: async () => ({ status: "multiple" }) })).status, "multiple_apps");
  assert.equal((await controlImage("restart", { ...options, inspect: async () => ({ status: "running", host: "connected", pid: 123 }) })).status, "already_connected");
  assert.equal((await controlImage("restart", { ...options, inspect: async () => { throw Error("unreadable"); } })).status, "app_check_failed");
  inspections = [running, { ...running, host: "connected" }];
  assert.equal((await controlImage("restart", options)).status, "already_connected");
  assert.equal(quits, 0);assert.equal(launches, 0);
  assert.equal((await controlImage("restart", { ...options, appControl: async () => "refused" })).status, "quit_refused");
  inspections = [running, { ...running, pid: 456 }];
  assert.equal((await controlImage("restart", options)).status, "app_changed");
  inspections = [];clock = 0;assert.equal((await controlImage("restart", options)).status, "quit_timeout");
  assert.equal(launches, 0);
});

test("check and focus identify a connected App without claiming other chats have the tool", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-focus-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const app = "/Applications/ChatGPT.app";let actions = [];
  const options = { home, env: {}, platform: "darwin", discover: async () => ({ app }),
    inspect: async () => ({ status: "running", pid: 123, host: "connected", tool_registration: "observed" }),
    appControl: async (_app, _pid, operation) => { actions.push(operation);return "sent"; },
    connection: async () => ({ state: "verified" }) };
  const checked = await controlImage("check", options);assert.deepEqual(checked.app, { status: "running", host: "connected", tool_registration: "observed" });
  assert.equal((await controlImage("focus", options)).status, "focused");assert.deepEqual(actions, ["activate"]);
});

test("local diagnostic verifies the nonce and keeps its Node-only scope explicit", async () => {
  const fetchImpl = async url => Response.json({ ok: true, name: "codex-copilot-dx", protocol_version: ADAPTER_PROTOCOL_VERSION, nonce: new URL(url).searchParams.get("nonce") });
  assert.deepEqual(await checkImageConnection({ fetchImpl }), { state: "verified", scope: "node_loopback", app_path: "unconfirmed" });
  assert.equal((await checkImageConnection({ fetchImpl: async () => Response.json({ ok: true, name: "other" }) })).state, "identity_mismatch");
  assert.equal((await checkImageConnection({ fetchImpl: async () => { throw Error("blocked"); } })).state, "unreachable");
  const response = await invokeAdapter({}, { method: "GET", url: "/_ccdx/health?nonce=11111111-1111-1111-1111-111111111111" });
  assert.equal(JSON.parse(response.text).nonce, "11111111-1111-1111-1111-111111111111");
});

test("Windows image checks do not start a macOS App lookup", async () => {
  const result = await controlImage("check", { platform: "win32", readSummary: () => ({}),
    discover: () => assert.fail("App discovery is unnecessary"), connection: async () => ({ state: "verified" }) });
  assert.equal(result.app.status, "unsupported");
});
