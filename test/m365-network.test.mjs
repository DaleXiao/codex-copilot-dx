import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createM365Network, requestFetch } from "../src/providers/m365-network.mjs";

const target = "https://df.loki.delve.office.com/api/v1/llmapi/models";
test("M365 uses the Windows system worker only when explicit environment routing does not apply", async () => {
  let starts = 0, closes = 0;
  const startWindowsNetwork = async options => {
    starts++;assert.equal(options.target, "m365");assert.equal(options.timeoutMs, 120000);
    assert.equal(options.env.GITHUB_TOKEN, undefined);assert.equal(options.env.NODE_OPTIONS, undefined);
    return { requestImpl() {}, healthy: () => true, close() { closes++; } };
  };
  const system = await createM365Network({ platform: "win32", env: { GITHUB_TOKEN: "never-forward", NODE_OPTIONS: "never-run" }, startWindowsNetwork });
  assert.equal(system.snapshot().type, "winhttp");system.close();assert.equal(closes, 1);
  for (const env of [{ HTTPS_PROXY: "http://proxy.example.test:8080" }, { NO_PROXY: "df.loki.delve.office.com" }]) {
    const explicit = await createM365Network({ platform: "win32", env, startWindowsNetwork });explicit.close();
  }
  assert.equal(starts, 1);
});

test("M365 preserves macOS proxies and fails closed for unsupported PAC without affecting another transport", async () => {
  let probes = 0;
  const configured = await createM365Network({ platform: "darwin", env: {}, execFileImpl: async (command, args) => {
    probes++;assert.equal(command, "/usr/sbin/scutil");assert.deepEqual(args, ["--proxy"]);
    return { stdout: "HTTPSEnable : 1\nHTTPSProxy : proxy.example.test\nHTTPSPort : 8080\n" };
  } });
  assert.equal(configured.snapshot().source, "system HTTPS");configured.close();
  for (const env of [{ HTTPS_PROXY: "http://proxy.example.test:8080" }, { NO_PROXY: "*" }]) {
    const direct = await createM365Network({ platform: "darwin", env, execFileImpl() { assert.fail("Explicit route must win"); } });direct.close();
  }
  assert.equal(probes, 1);
  await assert.rejects(createM365Network({ platform: "darwin", env: {}, execFileImpl: async () => ({ stdout: "ProxyAutoConfigEnable : 1" }) }), { code: "m365_proxy_settings_unsupported" });
});

test("M365 transport rejects other targets before forwarding a credential", async () => {
  const send = requestFetch(() => assert.fail("No request should be opened"));
  for (const value of ["http://df.loki.delve.office.com/api/v1/llmapi/models", "https://example.test/api/v1/llmapi/models",
    "https://user:pass@df.loki.delve.office.com/api/v1/llmapi/models", "https://df.loki.delve.office.com/private",
    target + "#fragment", "https://df.loki.delve.office.com:444/api/v1/llmapi/models"]) {
    await assert.rejects(send(value, { headers: { Authorization: "Bearer secret" } }), { code: "m365_target_invalid" });
  }
  await assert.rejects(send(target, { method: "DELETE" }), { code: "m365_target_invalid" });
});

test("M365 transport retains native streaming and does not follow redirect responses", async () => {
  let opened = 0, saved;
  const send = requestFetch((options, callback) => {
    opened++;saved = options;
    const request = new EventEmitter();request.destroy = () => {};
    request.end = () => queueMicrotask(() => {
      const response = new PassThrough();response.statusCode = 302;response.headers = { location: "https://outside.example.test", "content-type": "text/plain" };
      callback(response);response.write("first");response.end(" second");
    });return request;
  });
  const response = await send(target, { headers: { authorization: "Bearer test" } });
  assert.equal(response.status, 302);assert.equal(await response.text(), "first second");assert.equal(opened, 1);
  assert.equal(saved.rejectUnauthorized, true);assert.equal(saved.headers["accept-encoding"], "identity");
});

test("M365 cancellation closes an in-flight connection and an already-aborted call starts nothing", async () => {
  let destroyed = 0;
  const send = requestFetch(() => {
    const request = new EventEmitter();request.end = () => {};
    request.destroy = error => { destroyed++;queueMicrotask(() => request.emit("error", error)); };return request;
  });
  const controller = new AbortController();
  const pending = send(target, { signal: controller.signal });controller.abort();
  await assert.rejects(pending, { name: "AbortError" });assert.equal(destroyed, 1);
  await assert.rejects(send(target, { signal: controller.signal }), { name: "AbortError" });assert.equal(destroyed, 1);
});
