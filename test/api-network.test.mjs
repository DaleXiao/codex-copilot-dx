import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createApiNetwork } from "../src/providers/api-network.mjs";
import { privateHelperEnvironment } from "../src/private-helper-environment.mjs";

function transport(calls) {
  return (options, reply) => {
    calls.push(options);const request = new EventEmitter();request.destroy = () => {};
    request.end = body => { calls.at(-1).body = body;queueMicrotask(() => { const response = new PassThrough();response.statusCode = 200;response.headers = { "content-type": "application/json" };reply(response);response.end('{"ok":true}'); }); };
    return request;
  };
}
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
