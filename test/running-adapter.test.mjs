import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTER_HEALTH_PATH,
  adapterBaseUrl,
  adapterProbeHost,
  checkRunningAdapter,
} from "../src/running-adapter.mjs";

function jsonResp(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("adapterProbeHost: maps wildcard hosts to loopback for local probing", () => {
  assert.equal(adapterProbeHost("0.0.0.0"), "127.0.0.1");
  assert.equal(adapterProbeHost("::"), "127.0.0.1");
  assert.equal(adapterProbeHost("::1"), "::1");
});

test("adapterBaseUrl: builds local probe URLs", () => {
  assert.equal(adapterBaseUrl("0.0.0.0", 2026), "http://127.0.0.1:2026");
  assert.equal(adapterBaseUrl("::1", 2026), "http://[::1]:2026");
});

test("checkRunningAdapter: accepts only codex-copilot-dx health payloads", async () => {
  const seen = [];
  const ok = await checkRunningAdapter({
    port: 2026,
    fetchImpl: async (url) => {
      seen.push(url);
      return jsonResp(200, { ok: true, name: "codex-copilot-dx", pid: 123 });
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(seen[0], `http://127.0.0.1:2026${ADAPTER_HEALTH_PATH}`);

  const other = await checkRunningAdapter({
    port: 2026,
    fetchImpl: async () => jsonResp(200, { ok: true, name: "other-service" }),
  });
  assert.equal(other.ok, false);
});
