import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createM365Network, requestFetch } from "../src/providers/m365-network.mjs";
import { m365NetworkDiagnostic, m365NetworkMessage, m365ProxyFailure } from "../src/providers/m365-network-diagnostic.mjs";

const target = "https://loki.delve.office.com/api/v1/llmapi/models";
test("reported macOS exceptions work without any proxy-enable flags or a real HTTP request", async () => {
  const stdout = "<dictionary> {\n  ExceptionsList : <array> {\n    0 : *.local\n    1 : 169.254/16\n  }\n  FTPPassive : 1\n}\n";
  for (const proxy of ["", "HTTPSEnable : 1\nHTTPSProxy : proxy.example.test\nHTTPSPort : 8080\n"]) {
    const network = await createM365Network({ platform: "darwin", env: {}, execFileImpl: async () => ({ stdout: stdout + proxy }),
      requestImpl() { assert.fail("Parsing must not send a probe"); } });
    assert.equal(network.snapshot().type, proxy ? "http" : "direct");assert.equal(network.snapshot().bypass_rules, 2);network.close();
  }
});

test("M365 proxy diagnostics retain compatible categories and only fixed causes, never raw settings or nested secrets", async () => {
  for (const [stdout, code] of [["ProxyAutoConfigEnable : 1", "proxy_dynamic_unsupported"],
    ["ProxyAutoDiscoveryEnable : 1", "proxy_dynamic_unsupported"],
    ["HTTPSEnable : 1\nHTTPSProxy : proxy.example.test\nHTTPSPort : 0", "proxy_system_invalid"],
    ["ExceptionsList : <array> {\n0 : 169.254/33\n}", "proxy_bypass_invalid"]]) {
    await assert.rejects(createM365Network({ platform: "darwin", env: {}, execFileImpl: async () => ({ stdout }) }), error => {
      assert.equal(error.code, "m365_proxy_settings_unsupported");
      assert.deepEqual(error.network_diagnostic, { source: "system", stage: "proxy_config", cause_code: code });
      assert.match(error.cause.message, /Existing settings kept/);return true;
    });
  }
  await assert.rejects(createM365Network({ platform: "darwin", env: {}, execFileImpl: async () => { throw Error("Bearer NEVER_EXPOSE"); } }), error => {
    assert.equal(error.code, "m365_proxy_discovery_failed");assert.equal(error.network_diagnostic.stage, "proxy_discovery");
    assert.doesNotMatch(JSON.stringify(error), /NEVER_EXPOSE/);return true;
  });
  await assert.rejects(createM365Network({ platform: "darwin", env: { HTTPS_PROXY: "https://private:NEVER_EXPOSE@example.test/path" } }), error => {
    assert.equal(error.code, "m365_network_error");assert.equal(error.network_diagnostic.source, "environment");
    assert.equal(error.network_diagnostic.cause_code, "proxy_address_unsupported");assert.doesNotMatch(JSON.stringify(error), /NEVER_EXPOSE|example.test/);return true;
  });
  const diagnostic = { source: "system", cause_code: "proxy_bypass_invalid", stage: "private-stage", secret: "NEVER_EXPOSE" };
  assert.deepEqual(m365NetworkDiagnostic(diagnostic), { source: "system", stage: "proxy_config", cause_code: "proxy_bypass_invalid" });
  for (const value of [null, { ...diagnostic, source: "private-source" }, { ...diagnostic, cause_code: "toString" }]) assert.equal(m365NetworkDiagnostic(value), null);
  const unknown = m365ProxyFailure({ code: "private-cause", message: "NEVER_EXPOSE" }, "system");
  assert.equal(unknown.network_diagnostic.cause_code, "proxy_settings_unsupported");assert.doesNotMatch(JSON.stringify(unknown), /NEVER_EXPOSE|private-cause/);
  assert.match(m365NetworkMessage(diagnostic), /Invalid proxy exception/);
});
test("M365 uses the Windows system worker only when explicit environment routing does not apply", async () => {
  let starts = 0, closes = 0;
  const startWindowsNetwork = async options => {
    starts++;assert.equal(options.target, "m365");assert.equal(options.timeoutMs, 120000);
    assert.equal(options.env.GITHUB_TOKEN, undefined);assert.equal(options.env.NODE_OPTIONS, undefined);
    return { requestImpl() {}, healthy: () => true, close() { closes++; } };
  };
  const system = await createM365Network({ platform: "win32", env: { GITHUB_TOKEN: "never-forward", NODE_OPTIONS: "never-run" }, startWindowsNetwork });
  assert.equal(system.snapshot().type, "winhttp");system.close();assert.equal(closes, 1);
  for (const env of [{ HTTPS_PROXY: "http://proxy.example.test:8080" }, { NO_PROXY: "loki.delve.office.com" }]) {
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
  for (const value of ["http://loki.delve.office.com/api/v1/llmapi/models", "https://example.test/api/v1/llmapi/models",
    "https://user:pass@loki.delve.office.com/api/v1/llmapi/models", "https://loki.delve.office.com/private",
    target + "#fragment", "https://loki.delve.office.com:444/api/v1/llmapi/models"]) {
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

test('Node and native Windows M365 target policy name the same fixed production host', async () => {
  const { M365_API_HOST, M365_API_BASE } = await import('../src/providers/m365-endpoint.mjs');
  const fs = await import('node:fs');
  const native = fs.readFileSync(new URL('../src/windows-prediction-network.cs', import.meta.url), 'utf8');
  assert.equal(M365_API_BASE, `https://${M365_API_HOST}/api/v1/llmapi`);
  assert.ok(native.includes(`uri.Host!="${M365_API_HOST}"`));assert.ok(!native.includes('df.loki.delve.office.com'));
  const fetch = requestFetch(() => assert.fail('No request to the old environment'));
  await assert.rejects(fetch('https://df.loki.delve.office.com/api/v1/llmapi/models'));
});
