import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runLimitsCommand } from "../src/cli-limits.mjs";
import { readUserSettings, writeResponseHistoryLimitMib } from "../src/user-settings.mjs";

function outputCapture() {
  let value = "";
  return { write(chunk) { value += chunk; }, value: () => value };
}

function statusResponse(decodedBytes = 128 * 1024 * 1024) {
  return Response.json({
    ok: true,
    name: "codex-copilot-dx",
    version: "0.9.0",
    pid: 1234,
    limits: { max_body_bytes: 64 * 1024 * 1024, max_decoded_body_bytes: decodedBytes },
  });
}

test("limits CLI reads configured and running limits without changing settings", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-limits-status-"));
  const output = outputCapture();
  const calls = [];
  try {
    await runLimitsCommand({ home, env: {}, output, fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      return statusResponse();
    } });
    assert.match(output.value(), /Configured decoded request body: 128 MiB \(default\)/);
    assert.match(output.value(), /Running decoded request body: 128 MiB/);
    assert.match(output.value(), /Raw request body: 64 MiB \(running\)/);
    assert.doesNotMatch(output.value(), /Restart ccdx/);
    assert.deepEqual(calls, [{ url: "http://127.0.0.1:2026/_ccdx/status", method: undefined }]);
    assert.deepEqual(readUserSettings({ home, env: {} }), {});
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("limits CLI saves a decoded limit but does not mutate the running adapter or history", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-limits-save-"));
  const env = {};
  const output = outputCapture();
  try {
    writeResponseHistoryLimitMib(128, { home, env });
    await runLimitsCommand({ action: "set", limitMib: 256, home, env, output,
      fetchImpl: async (_url, init) => {
        assert.equal(init.method, undefined);
        return statusResponse();
      } });
    assert.deepEqual(readUserSettings({ home, env }), {
      response_history_max_mib: 128, decoded_body_limit_mib: 256,
    });
    assert.match(output.value(), /Configured decoded request body: 256 MiB \(settings\)/);
    assert.match(output.value(), /Running decoded request body: 128 MiB/);
    assert.match(output.value(), /Restart ccdx to apply/);
    assert.match(output.value(), /Existing conversations and caches were not modified/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("limits CLI restores the default even when the adapter is offline", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-limits-reset-"));
  const env = {};
  try {
    await runLimitsCommand({ action: "set", limitMib: 256, home, env, output: outputCapture(),
      fetchImpl: async () => { throw new Error("offline"); } });
    const output = outputCapture();
    await runLimitsCommand({ action: "set", resetLimit: true, home, env, output,
      fetchImpl: async () => { throw new Error("offline"); } });
    assert.deepEqual(readUserSettings({ home, env }), {});
    assert.match(output.value(), /Configured decoded request body: 128 MiB \(default\)/);
    assert.match(output.value(), /Running adapter status unavailable; restart ccdx/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("limits CLI rejects environment override and unsafe values without rewriting settings", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-limits-reject-"));
  try {
    await assert.rejects(runLimitsCommand({ action: "set", limitMib: 256, home,
      env: { CCDX_MAX_DECODED_BODY_BYTES: "134217728" }, output: outputCapture() }), /overrides saved limits/);
    for (const limitMib of [64, 513]) {
      await assert.rejects(runLimitsCommand({ action: "set", limitMib, home, env: {}, output: outputCapture() }), /128 to 512 MiB/);
    }
    assert.deepEqual(readUserSettings({ home, env: {} }), {});
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("limits binary saves, reports, and resets a limit without starting the adapter", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-limits-bin-"));
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(home, "xdg"),
    ADAPTER_PORT: "65534",
    CCDX_EXISTING_ADAPTER_TIMEOUT_MS: "50",
  };
  delete env.CCDX_MAX_DECODED_BODY_BYTES;
  const cliPath = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cliPath, "limits", ...args], {
    env, encoding: "utf8", timeout: 10000,
  });
  try {
    const set = run("-256");
    assert.equal(set.status, 0, set.stderr);
    assert.match(set.stdout, /Configured decoded request body: 256 MiB \(settings\)/);
    assert.match(set.stdout, /restart ccdx/);
    const status = run();
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Configured decoded request body: 256 MiB \(settings\)/);
    assert.equal(readUserSettings({ env, home }).decoded_body_limit_mib, 256);
    const reset = run("--decoded", "default");
    assert.equal(reset.status, 0, reset.stderr);
    assert.deepEqual(readUserSettings({ env, home }), {});
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
