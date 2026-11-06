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
});

test("manual image repair prepares owned launch files and never reopens a running App", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-control-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let running = true, opened = 0, configured = 0;
  const options = { home, env: {}, integration: { configure: async () => { configured++; }, start: async () => ({ pacUrl: "route", app: "app", prepareRoute: async () => {} }) },
    prepare: async () => ({ app: "app", env: { CODEX_CLI_PATH: "owned" } }), appProcesses: () => running ? [{}] : [],
    launch: async value => { assert.equal(value.predictionPacUrl, "route");assert.equal(value.imageHost.env.CODEX_CLI_PATH, "owned");opened++;return true; } };
  assert.equal((await controlImage("open", options)).status, "needs_app_relaunch");assert.equal(opened, 0);
  running = false;assert.equal((await controlImage("repair", options)).status, "prepared");assert.equal(opened, 0);
  assert.equal((await controlImage("open", options)).status, "opened_new_chat_required");assert.equal(opened, 1);assert.equal(configured, 3);
  await assert.rejects(controlImage("invalid", options));
  await assert.rejects(controlImage("repair", { ...options, prepare: async () => { throw Error("custom route preserved"); } }), /custom route/);
});

test("local diagnostic verifies the nonce and keeps its Node-only scope explicit", async () => {
  const fetchImpl = async url => Response.json({ ok: true, name: "codex-copilot-dx", protocol_version: ADAPTER_PROTOCOL_VERSION, nonce: new URL(url).searchParams.get("nonce") });
  assert.deepEqual(await checkImageConnection({ fetchImpl }), { state: "verified", scope: "node_loopback", app_path: "unconfirmed" });
  assert.equal((await checkImageConnection({ fetchImpl: async () => Response.json({ ok: true, name: "other" }) })).state, "identity_mismatch");
  assert.equal((await checkImageConnection({ fetchImpl: async () => { throw Error("blocked"); } })).state, "unreachable");
  const response = await invokeAdapter({}, { method: "GET", url: "/_ccdx/health?nonce=11111111-1111-1111-1111-111111111111" });
  assert.equal(JSON.parse(response.text).nonce, "11111111-1111-1111-1111-111111111111");
});
