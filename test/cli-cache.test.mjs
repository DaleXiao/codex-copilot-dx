import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCacheCommand } from "../src/cli-cache.mjs";
import { readUserSettings } from "../src/user-settings.mjs";

function outputCapture() {
  let value = "";
  return { isTTY: false, write(chunk) { value += chunk; }, value: () => value };
}

function runtime(overrides = {}) {
  return {
    response_history: { bytes: 32 * 1024 * 1024, maxBytes: 64 * 1024 * 1024, entries: 4, evicted: 1 },
    image_optimization: { cache_bytes: 2 * 1024 * 1024, cache_max_bytes: 64 * 1024 * 1024, cache_entries: 2 },
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("cache CLI shows configured and live limits without changing settings", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cache-status-"));
  const output = outputCapture();
  try {
    await runCacheCommand({ home, env: {}, output, fetchImpl: async () => jsonResponse(runtime()) });
    assert.match(output.value(), /Configured history limit: 64 MiB \(default\)/);
    assert.match(output.value(), /History: 32 MiB \/ 64 MiB, 4 entries, 1 evicted/);
    assert.match(output.value(), /Image transforms: 2 MiB \/ 64 MiB/);
    assert.deepEqual(readUserSettings({ home, env: {} }), {});
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("cache CLI persists and applies limits, including default reset and legacy shorthand", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cache-limit-"));
  const requests = [];
  let current = runtime();
  const fetchImpl = async (_url, init = {}) => {
    if (!init.body) return jsonResponse(current);
    const body = JSON.parse(init.body);
    requests.push(body);
    current = runtime({ response_history: { ...current.response_history, maxBytes: body.max_bytes } });
    return jsonResponse({ changed: true, ...current });
  };
  try {
    await runCacheCommand({ action: "limit", limitMib: 128, home, env: {}, output: outputCapture(), fetchImpl });
    assert.equal(readUserSettings({ home, env: {} }).response_history_max_mib, 128);
    assert.deepEqual(requests.pop(), { action: "set_limit", max_bytes: 128 * 1024 * 1024 });
    await runCacheCommand({ action: "limit", resetLimit: true, home, env: {}, output: outputCapture(), fetchImpl });
    assert.equal(readUserSettings({ home, env: {} }).response_history_max_mib, undefined);
    assert.deepEqual(requests.pop(), { action: "set_limit", max_bytes: 64 * 1024 * 1024 });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("cache CLI rejects ineffective or unsafe limit changes without rewriting settings", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cache-reject-"));
  try {
    await assert.rejects(runCacheCommand({ action: "limit", limitMib: 128, home,
      env: { CCDX_RESPONSE_HISTORY_MAX_BYTES: "67108864" }, output: outputCapture(), fetchImpl: async () => jsonResponse(runtime()) }), /overrides saved cache settings/);
    await assert.rejects(runCacheCommand({ action: "limit", limitMib: 16, home,
      env: {}, output: outputCapture(), fetchImpl: async () => jsonResponse(runtime()) }), /currently uses 32 MiB/);
    assert.deepEqual(readUserSettings({ home, env: {} }), {});
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("cache CLI clears rebuildable data by default and confirms history cleanup", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cache-clean-"));
  const calls = [];
  const fetchImpl = async (_url, init = {}) => {
    if (!init.body) return jsonResponse(runtime());
    const body = JSON.parse(init.body);
    calls.push(body);
    return jsonResponse({ cleaned: {
      image_optimization: { entries: 2, bytes: 2 * 1024 * 1024 },
      ...(body.history ? { response_history: { entries: 4, bytes: 32 * 1024 * 1024 } } : {}),
    }, ...runtime() });
  };
  try {
    await runCacheCommand({ action: "clean", home, env: {}, output: outputCapture(), fetchImpl });
    assert.deepEqual(calls.pop(), { action: "clean", history: false });
    await assert.rejects(runCacheCommand({ action: "clean", history: true, home, env: {},
      output: outputCapture(), input: { isTTY: false }, fetchImpl }), /rerun with --yes/);
    assert.equal(calls.length, 0);
    const output = outputCapture();
    await runCacheCommand({ action: "clean", history: true, yes: true, home, env: {}, output, fetchImpl });
    assert.deepEqual(calls.pop(), { action: "clean", history: true });
    assert.match(output.value(), /Saved Codex transcripts and generated image files were not deleted/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
