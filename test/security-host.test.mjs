import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { isAllowedAdapterHostHeader } from "../src/security.mjs";
import { invokeAdapterRequest } from "../test-support/adapter.mjs";

test("loopback clients cannot use a rebound external Host", () => {
  const request = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", allowLan: true };
  for (const host of ["127.0.0.1:2026", "localhost:2026", "[::1]:2026"]) {
    assert.equal(isAllowedAdapterHostHeader(host, request), true, host);
  }
  for (const host of ["evil.example:2026", "localhost.evil.example", "localhost@evil.example", "127.0.0.1, evil.example"]) {
    assert.equal(isAllowedAdapterHostHeader(host, request), false, host);
  }
  assert.equal(isAllowedAdapterHostHeader(undefined, request), true);
});

test("in-process dispatchers accept local Host values but reject external Host values", () => {
  assert.equal(isAllowedAdapterHostHeader(undefined), true);
  assert.equal(isAllowedAdapterHostHeader("127.0.0.1:2026"), true);
  assert.equal(isAllowedAdapterHostHeader("localhost:2026"), true);
  assert.equal(isAllowedAdapterHostHeader("evil.example:2026"), false);
  assert.equal(isAllowedAdapterHostHeader("codex-box.local:2026", {
    configuredHost: "codex-box.local",
    allowLan: true,
  }), false);
});

test("LAN clients must address the actual interface or configured adapter host", () => {
  const request = {
    remoteAddress: "192.168.1.20",
    localAddress: "192.168.1.10",
    configuredHost: "codex-box.local",
    allowLan: true,
  };
  assert.equal(isAllowedAdapterHostHeader("192.168.1.10:2026", request), true);
  assert.equal(isAllowedAdapterHostHeader("192.168.1.10:2026", { ...request, localAddress: "::ffff:192.168.1.10" }), true);
  assert.equal(isAllowedAdapterHostHeader("[::ffff:c0a8:10a]:2026", { ...request, localAddress: "::ffff:192.168.1.10" }), true);
  assert.equal(isAllowedAdapterHostHeader("codex-box.local:2026", request), true);
  assert.equal(isAllowedAdapterHostHeader("evil.example:2026", request), false);
  assert.equal(isAllowedAdapterHostHeader("127.0.0.1:2026", request), false);
  assert.equal(isAllowedAdapterHostHeader("192.168.1.10:2026", { ...request, allowLan: false }), false);
  assert.equal(isAllowedAdapterHostHeader("0.0.0.0:2026", { ...request, configuredHost: "0.0.0.0" }), false);
  assert.equal(isAllowedAdapterHostHeader(undefined, request), false);
  assert.equal(isAllowedAdapterHostHeader(undefined, { ...request, allowLan: false }), false);
});

test("LAN health requests without Host are rejected even when LAN access is enabled", async () => {
  const req = Readable.from([]);
  Object.assign(req, {
    url: "/_ccdx/health",
    method: "GET",
    headers: {},
    socket: { remoteAddress: "192.168.1.20", localAddress: "192.168.1.10" },
  });
  const response = await invokeAdapterRequest({ env: { CCDX_ALLOW_LAN: "1" } }, req);
  assert.equal(response.status, 403);
});
