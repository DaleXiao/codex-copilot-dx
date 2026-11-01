import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServiceControl } from "../src/service-control.mjs";
import { configureImageSetup } from "../src/image-setup.mjs";
import { readImageProviderConfig } from "../src/image-provider-config.mjs";
import { readUserSettings } from "../src/user-settings.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-webui-features-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [], options = { home, env: {} };
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method || "GET" });
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "gpt-image-1" }] });
    assert.deepEqual(JSON.parse(init.body), { model: "gpt-image-1" }, "setup must never submit an image prompt");
    return Response.json({ error: { message: "prompt required" } }, { status: 400 });
  };
  const control = createServiceControl({ ...options, imageControl: (input, opts) => configureImageSetup(input, { ...opts, fetchImpl }) });
  return { ...options, control, calls };
}

test("WebUI image discovery, configuration and removal share safe native setup", async t => {
  const f = fixture(t), input = { action: "image", endpoint: "https://images.example.test/v1", key: "PRIVATE_FIXTURE_KEY" };
  const discovery = await f.control.action({ ...input, operation: "inspect" });
  assert.deepEqual(discovery.last_operation.result.models, ["gpt-image-1"]);
  assert.equal(readImageProviderConfig(f), null);
  const saved = await f.control.action({ ...input, operation: "setup", model: "gpt-image-1" });
  assert.equal(saved.features.image.configured, true);assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_FIXTURE_KEY|api_key/);
  assert.equal(readImageProviderConfig(f).api_key, "PRIVATE_FIXTURE_KEY");
  await assert.rejects(f.control.action({ action: "image", operation: "setup", endpoint: "https://different.example.test/v1", model: "gpt-image-1" }), /key/);
  assert.equal(f.calls.length, 4, "a changed origin with no new key is rejected before network access");
  assert.equal(readImageProviderConfig(f).api_key, "PRIVATE_FIXTURE_KEY");
  await f.control.action({ action: "image", operation: "pause" });assert.equal(readUserSettings(f).image_enabled, false);
  await f.control.action({ action: "image", operation: "remove" });assert.equal(readImageProviderConfig(f), null);
  assert.doesNotMatch(fs.readFileSync(path.join(f.home, ".codex/config.toml"), "utf8"), /mcp_servers.ccdx_image/);
});

test("feature controls reject unexpected fields, oversized secrets and unconfirmed updates", async t => {
  const f = fixture(t);
  await assert.rejects(f.control.action({ action: "image", operation: "setup", command: "anything" }), /Unknown/);
  await assert.rejects(f.control.action({ action: "image", operation: "inspect", key: "a".repeat(8193) }), /Invalid/);
  await assert.rejects(f.control.action({ action: "update" }), /Confirm/);
  await assert.rejects(f.control.action({ action: "update", confirmed: true }), /cannot update/);
  await assert.rejects(f.control.action({ action: "decoded_limit", mib: 127 }), /128.*512/);
  assert.equal(f.control.busy(), false);assert.deepEqual(f.calls, []);
});

test("WebUI update requests use the supervisor and decoded limits retain environment ownership", async t => {
  const f = fixture(t);let updates = 0;
  const control = createServiceControl({ ...f, manualUpdate: () => { updates++;return { status: "queued" }; } });
  assert.equal((await control.action({ action: "update", confirmed: true })).last_operation.result.status, "queued");
  assert.equal(updates, 1);
  await control.action({ action: "decoded_limit", mib: 256 });assert.equal(control.snapshot().decoded_body.bytes, 256 * 1048576);
  await control.action({ action: "decoded_limit", mib: null });assert.equal(control.snapshot().decoded_body.source, "default");
  await control.action({ action: "decoded_limit", mib: 256 });
  const locked = createServiceControl({ home: f.home, env: { CCDX_MAX_DECODED_BODY_BYTES: "134217728" } });
  await assert.rejects(locked.action({ action: "decoded_limit", mib: 256 }), /environment/);
  assert.equal(readUserSettings(f).decoded_body_limit_mib, 256);
});
