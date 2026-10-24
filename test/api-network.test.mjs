import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createApiNetwork } from "../src/providers/api-network.mjs";
import { privateHelperEnvironment } from "../src/private-helper-environment.mjs";
import { apiTargetAllowed } from "../src/api-target.mjs";

function transport(calls) {
  return (options, reply) => {
    calls.push(options);const request = new EventEmitter();request.destroy = () => {};
    request.end = body => { calls.at(-1).body = body;queueMicrotask(() => { const response = new PassThrough();response.statusCode = 200;response.headers = { "content-type": "application/json" };reply(response);response.end('{"ok":true}'); }); };
    return request;
  };
}
test("catalog cursors preserve transport bounds and reach the request path", async t => {
  const targets = ["https://api.test:8443/v1/models", "https://api.test:8443/v1/messages"], calls = [];
  const network = await createApiNetwork({ targets, env: {}, platform: "linux", requestImpl: transport(calls) });t.after(() => network.close());
  const url = targets[0] + "?after_id=vendor%2Fmodel%2B1";
  assert.equal((await network.fetch(url)).status, 200);assert.equal(calls[0].path, "/v1/models?after_id=vendor%2Fmodel%2B1");
  for (const raw of [targets[0] + "?after_id=..", targets[0] + "?after_id=a&after_id=b", targets[0] + "?after_id=a&key=x", targets[1] + "?after_id=a", "https://other.test/v1/models?after_id=a", targets[0] + "?after_id=a#x"]) assert.equal(apiTargetAllowed(raw, targets), false);
  assert.equal(apiTargetAllowed(url, targets, "POST"), false);
});
test("API transport pins HTTPS targets and port, uses strict TLS and streams the response", async t => {
  const calls = [], network = await createApiNetwork({ targets: ["https://api.test:8443/v1/messages"], env: {}, platform: "linux", requestImpl: transport(calls) });t.after(() => network.close());
  const result = await network.fetch("https://api.test:8443/v1/messages", { method: "POST", headers: { Authorization: "Bearer synthetic" }, body: "{}" });assert.equal((await result.json()).ok, true);
  assert.equal(calls[0].port, 8443);assert.equal(calls[0].rejectUnauthorized, true);assert.equal(calls[0].headers["accept-encoding"], "identity");
  for (const url of ["http://api.test:8443/v1/messages", "https://other.test:8443/v1/messages", "https://api.test/v1/messages", "https://api.test:8443/v1/messages?key=bad", "https://api.test:8443/other"]) await assert.rejects(network.fetch(url), { code: "ccdx_api_url_invalid" });
  assert.equal(calls.length, 1);network.close();await assert.rejects(network.fetch("https://api.test:8443/v1/messages"), { code: "ccdx_api_url_invalid" });
});
test("Mac proxy exceptions keep the previous short-CIDR fix and unsupported PAC never falls back direct", async t => {
  const calls = [], network = await createApiNetwork({ targets: ["https://api.test/messages"], env: {}, platform: "darwin", requestImpl: transport(calls), exec: async () => ({ stdout: '<dictionary> {\n ExceptionsList : <array> {\n 0 : 169.254/16\n }\n}' }) });t.after(() => network.close());
  assert.equal((await network.fetch("https://api.test/messages")).status, 200);
  await assert.rejects(createApiNetwork({ targets: ["https://api.test/messages"], env: {}, platform: "darwin", exec: async () => ({ stdout: 'ProxyAutoConfigEnable : 1' }) }), { code: "proxy_dynamic_unsupported" });
});
test("private helper environments retain enterprise routing and omit unrelated keys and Node hooks", () => {
  const value = privateHelperEnvironment({ HOME: "/kept", HTTPS_PROXY: "http://company.test:8080", NODE_EXTRA_CA_CERTS: "/company.pem", DBUS_SESSION_BUS_ADDRESS: "unix:test",
    GH_TOKEN: "never-export", ANTHROPIC_API_KEY: "never-export", CCDX_COMPANY_API_KEY: "never-export", NODE_OPTIONS: "--require bad" });
  assert.deepEqual(Object.keys(value).sort(), ["DBUS_SESSION_BUS_ADDRESS", "HOME", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"].sort());
});

test("a pre-response DNS failure retains bounded diagnostics and retires the failed transport", async () => {
  const socket = new EventEmitter();socket.connecting = true;
  const cause = Object.assign(new Error("private hostname and credential must not reach the diagnostic"), { code: "ENOTFOUND" });
  const network = await createApiNetwork({ targets: ["https://api.test/messages"], env: {}, platform: "linux", requestImpl: () => {
    const req = new EventEmitter();req.reusedSocket = false;req.destroy = () => {};
    req.end = () => queueMicrotask(() => { req.emit("socket", socket);socket.emit("lookup", cause);req.emit("error", cause); });return req;
  } });
  try {
    await assert.rejects(network.fetch("https://api.test/messages", { method: "POST", body: "{}" }), error => {
      assert.deepEqual(error.transport, { code: "ENOTFOUND", phase: "dns", reused_socket: false });
      assert.equal(error.cause, cause);assert.equal(JSON.stringify(error.transport).includes("credential"), false);return true;
    });
    assert.equal(network.healthy(), false);
    assert.equal(socket.listenerCount("lookup") + socket.listenerCount("connect") + socket.listenerCount("secureConnect"), 0);
    await network.retire();await network.retire();
  } finally { network.close(); }
});

test("retiring a failed transport lets an unrelated active response drain", async () => {
  let calls = 0, held;
  const network = await createApiNetwork({ targets: ["https://api.test/messages"], env: {}, platform: "linux", requestImpl: (_options, reply) => {
    const req = new EventEmitter();req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      if (++calls === 2) { req.emit("error", Object.assign(new Error("reset"), { code: "ECONNRESET" }));return; }
      held = new PassThrough();held.statusCode = 200;held.headers = {};reply(held);held.write("first");
    });return req;
  } });
  try {
    const active = await network.fetch("https://api.test/messages");
    await assert.rejects(network.fetch("https://api.test/messages"));assert.equal(network.healthy(), false);
    let drained = false;const retiring = network.retire().then(() => { drained = true; });
    await Promise.resolve();assert.equal(drained, false);assert.equal(held.destroyed, false);
    await assert.rejects(network.fetch("https://api.test/messages"), { code: "ccdx_api_url_invalid" });
    held.end(" last");assert.equal(await active.text(), "first last");await retiring;assert.equal(drained, true);
  } finally { held?.destroy();network.close(); }
});

test("an HTTP denial and deliberate response cancellation do not poison the transport", async () => {
  let response;
  const network = await createApiNetwork({ targets: ["https://api.test/messages"], env: {}, platform: "linux", requestImpl: (_options, reply) => {
    const req = new EventEmitter();req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      response = new PassThrough();response.statusCode = 403;response.headers = {};reply(response);response.write("denied");
    });return req;
  } });
  try {
    const denied = await network.fetch("https://api.test/messages");assert.equal(denied.status, 403);
    await denied.body.cancel();assert.equal(network.healthy(), true);
  } finally { response?.destroy();network.close(); }
});
