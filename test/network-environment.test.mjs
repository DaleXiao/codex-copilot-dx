import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";
import { resolveNetworkRoute, networkPredictionPac, networkProxyFor } from "../src/network-route.mjs";
import { literalAddress } from "../src/network-bypass.mjs";
import { inspectPredictionEnvironment } from "../src/native-prediction-environment.mjs";
import { createClientIntegration } from "../src/client-integration.mjs";
import { createPredictionState, formatPredictionEnvironment } from "../src/native-prediction-state.mjs";
import { formatAdapterStatus } from "../src/cli-status.mjs";
import { predictionStartupCheck } from "../src/startup-ui.mjs";
import { inspectCodexClient } from "../src/codex-client-doctor.mjs";
import { runPredictionCommand, startNativePrediction } from "../src/native-prediction.mjs";

const proxy = "http://proxy.test:8080";
const reported = ["172.16.0.0/12", "10.0.0.0/8", "198.18.0.0/15", "192.168.0.0/16"];
function pac(plan) {
  const context = { Date: { now: () => 0 }, dnsResolve() { assert.fail("CIDRs must not trigger DNS"); }, dnsResolveEx() { assert.fail("CIDRs must not trigger DNS"); } };
  vm.runInNewContext(networkPredictionPac(23456, plan), context);return context.FindProxyForURL;
}

test("reported macOS CIDR exceptions are accepted from either source with identical Node/PAC boundaries", () => {
  const settings = "ExceptionsList : <array> {\n" + reported.map((rule, i) => `${i} : ${rule}`).join("\n") + "\n}";
  const plans = [resolveNetworkRoute({ env: { HTTPS_PROXY: proxy, NO_PROXY: reported.join(",") } }), resolveNetworkRoute({ env: { HTTPS_PROXY: proxy }, systemProxy: settings })];
  const included = ["172.16.0.0", "172.31.255.255", "10.0.0.0", "10.255.255.255", "198.18.0.0", "198.19.255.255", "192.168.0.0", "192.168.255.255"];
  const excluded = ["172.15.255.255", "172.32.0.0", "9.255.255.255", "11.0.0.0", "198.17.255.255", "198.20.0.0", "192.167.255.255", "192.169.0.0", "private-name.test"];
  for (const plan of plans) {
    const find = pac(plan);
    for (const host of [...included, ...excluded]) {
      const url = new URL(`https://${host}/`), direct = included.includes(host);
      assert.equal(networkProxyFor(url, plan) === null, direct, host);
      assert.equal(find(url.href, url.hostname), direct ? "DIRECT" : "PROXY proxy.test:8080", host);
    }
    assert.equal(find("https://chatgpt.com/", "chatgpt.com"), "PROXY 127.0.0.1:23456; PROXY ccdx-0.localhost:23456; PROXY proxy.test:8080");
  }
  assert.equal(networkProxyFor(new URL("https://chatgpt.com"), resolveNetworkRoute({ env: { NO_PROXY: reported.join(",") } })), null);
});

test("IPv6 canonicalization, prefix extremes, ports and legacy domain rules agree in Node and PAC", () => {
  for (const [rule, hosts] of [["2001:db8::123/32", ["2001:db8::1", "2001:db8:ffff::1"]], ["::/0", ["2001:abcd::1", "::ffff:c000:201"]], ["2001:db8::1/128", ["2001:db8::1"]], ["0.0.0.0/0", ["203.0.113.1"]], ["203.0.113.1/32", ["203.0.113.1"]]]) {
    const plan = resolveNetworkRoute({ env: { HTTPS_PROXY: proxy, NO_PROXY: rule } }), find = pac(plan);
    for (const host of hosts) {
      const url = new URL(`https://${host.includes(":") ? `[${host}]` : host}/`);
      assert.equal(networkProxyFor(url, plan), null);assert.equal(find(url.href, url.hostname), "DIRECT");
    }
  }
  const plan = resolveNetworkRoute({ env: { HTTPS_PROXY: proxy, NO_PROXY: "[2001:db8::1]:444,2001:db9::1,.example.test,*.internal.test,host.test:444" } });
  const find = pac(plan);
  for (const [input, direct] of [["https://[2001:0db8:0:0:0:0:0:1]:444", true], ["https://[2001:db8::1]", false], ["https://[2001:db9::1]", true], ["https://a.example.test", true], ["https://example.test", true], ["https://a.internal.test", true], ["https://host.test:444", true], ["https://host.test", false], ["https://[2001:db9::2]", false]]) {
    const url = new URL(input);assert.equal(networkProxyFor(url, plan) === null, direct, input);assert.equal(find(url.href, url.hostname) === "DIRECT", direct, input);
  }
  assert.deepEqual(literalAddress("::ffff:192.0.2.1"), literalAddress("::ffff:c000:201"));
});

test("invalid CIDRs and selected routes fail specifically, while unused lower-priority static proxies cannot block explicit routes", () => {
  for (const rule of ["10.0.0.0/33", "10.0.0.0/-1", "10.0.0.0/1/2", "999.0.0.0/8", "10.0.0.0/x", "2001:db8::/129", "2001:::1/64", "[2001:db8::]/32", "2001::]/32", "https://secret@internal.test/", "[127.0.0.1]:443", "[::1]:99999", "bad:port"]) {
    assert.throws(() => resolveNetworkRoute({ env: { NO_PROXY: rule } }), error => error.code === "proxy_bypass_invalid" && !error.message.includes("secret"));
  }
  assert.doesNotThrow(() => resolveNetworkRoute({ env: { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: "invalid-unused" }, systemProxy: "HTTPEnable : 1\nHTTPPort : invalid" }));
  assert.throws(() => resolveNetworkRoute({ env: { HTTPS_PROXY: "invalid-selected" } }), /HTTPS_PROXY/);
  assert.throws(() => resolveNetworkRoute({ env: {}, systemProxy: "ProxyAutoConfigEnable : 1" }), /PAC/);
});

test("environment discovery is readonly, bounded, redacted and stable across probes; TLS content changes require service reload", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-environment-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ca = path.join(root, "extra.pem");fs.writeFileSync(ca, rootCertificates[0]);
  const env = { HTTPS_PROXY: "http://alice:secret@proxy.test:8080", NODE_EXTRA_CA_CERTS: ca, NODE_OPTIONS: "--title=private-value" };
  let calls = 0;const options = { env, platform: "darwin", exec(command, args, opts) { calls++;assert.equal(command, "/usr/sbin/scutil");assert.equal(opts.timeout, 2000);return "<dictionary> {}"; } };
  const first = inspectPredictionEnvironment(options), second = inspectPredictionEnvironment(options);
  assert.equal(first.networkKey, second.networkKey);assert.equal(first.trustKey, second.trustKey);assert.equal(calls, 2);
  assert.equal(first.summary.tls.extra_ca, "configured");
  for (const secret of ["alice", "secret", "private-value", root, proxy]) assert.ok(!JSON.stringify(first.summary).includes(secret));
  fs.writeFileSync(ca, rootCertificates[1]);const changed = inspectPredictionEnvironment(options);
  assert.equal(first.networkKey, changed.networkKey);assert.notEqual(first.trustKey, changed.trustKey);
  fs.writeFileSync(ca, "invalid");assert.equal(inspectPredictionEnvironment(options).summary.tls.extra_ca, "unreadable_or_invalid");
  fs.unlinkSync(ca);assert.equal(inspectPredictionEnvironment(options).summary.tls.extra_ca, "unreadable_or_invalid");
});

test("Windows discovery retains static CIDRs, native automatic routes and explicit-conflict protection", () => {
  const inspect = (settings, env = {}) => inspectPredictionEnvironment({ platform: "win32", env, exec: () => JSON.stringify(settings) });
  const staticRoute = inspect({ autoDetect: false, pac: null, proxy: "https=proxy.test:8080", bypass: reported.join(";") });
  assert.equal(staticRoute.summary.network.cidr_rules, 4);assert.equal(staticRoute.network.networkRoute.https.url.hostname, "proxy.test");
  const automatic = inspect({ autoDetect: true, pac: "https://company.test/proxy.pac", proxy: null, bypass: null });
  assert.equal(automatic.summary.network.type, "auto");assert.equal(automatic.network.settings.autoDetect, true);
  assert.throws(() => inspect({ autoDetect: true, pac: null, proxy: null, bypass: null }, { HTTPS_PROXY: proxy }), /existing routes were preserved/);
});

test("explicit repair checks the environment once, keeps healthy unchanged bridges, and retains restart warnings until the App really changes", async t => {
  let starts = 0, checks = 0, changed = false, trustChanged = false, invalid = false, pid = 101, route = "verified";
  const summary = { status: "adapted", network: { source: "system", type: "http", bypass_rules: 4, cidr_rules: 4 }, tls: { extra_ca: "not_set" } };
  const client = createClientIntegration({ startPrediction: async ({ state, expectedPort }) => {
    starts++;if (expectedPort) assert.equal(expectedPort, 23456);state.configure(true);state.running({});state.environment(summary);
    return { pacUrl: "http://127.0.0.1:23456/proxy.pac", healthy: () => true, enabled: () => true, appCurrent: () => true,
      inspectEnvironment() { checks++;if (invalid) throw new Error("unknown proxy policy");return { changed, requiresServiceRestart: trustChanged, next: { summary } }; },
      inspectRoute: async () => route, routeProcessId: () => pid, close: async () => state.stopped() };
  } });t.after(() => client.close());
  await client.start();assert.equal(checks, 0);
  assert.equal((await client.fix()).status, "ready");assert.equal(checks, 1);assert.equal(starts, 1);
  changed = true;assert.equal((await client.fix()).status, "needs_app_relaunch");assert.equal(starts, 2);
  changed = false;assert.equal((await client.fix()).status, "needs_app_relaunch");assert.equal(starts, 2);
  pid = 102;assert.equal((await client.fix()).status, "ready");
  trustChanged = true;assert.equal((await client.fix()).status, "needs_service_restart");assert.equal(starts, 2);
  trustChanged = false;invalid = true;assert.equal((await client.fix()).status, "environment_preserved");assert.equal(starts, 2);assert.equal(client.snapshot().prediction.bridge, "running");
  invalid = false;changed = true;route = "closed";assert.equal((await client.fix()).status, "ready");assert.equal(starts, 3);
});

test("startup, status, doctor and fix use the same sanitized environment summary without probing system policy", async t => {
  const state = createPredictionState();state.configure(true);state.running({});
  state.environment({ status: "adapted", network: { source: "system HTTPS", type: "http", bypass_rules: 4, cidr_rules: 4 }, tls: { extra_ca: "not_set" } });
  const prediction = state.snapshot(), summary = formatPredictionEnvironment(prediction.environment);
  assert.ok(predictionStartupCheck(prediction).includes(summary));
  assert.ok(formatAdapterStatus({ data: { client_integrations: { prediction } } }).includes(summary));
  const checks = await inspectCodexClient({ platform: "linux", running: { ok: true }, readStatus: async () => ({ data: { client_integrations: { prediction } } }), execFileFn() { assert.fail("no policy probe"); } });
  assert.ok(checks.some(check => check.message === summary));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-environment-cli-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lines = [];await runPredictionCommand({ home: root, env: {}, action: "status", output: text => lines.push(text), runtimeSnapshot: async () => ({ client_integrations: { prediction } }) });
  assert.ok(lines.includes(summary));assert.equal(fs.readdirSync(root).length, 0);
  assert.doesNotMatch(formatPredictionEnvironment({ status: "\x1b[31mbad", network: { source: "secret\n", type: "bad", bypass_rules: -1 }, tls: {} }), /secret|\x1b/);
});

test("disabled predictions create no environment probes, trust reads or files on any platform", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-environment-off-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const platform of ["win32", "darwin", "linux"]) {
    assert.equal(await startNativePrediction({ home: root, env: {}, platform, exec() { assert.fail("disabled policy probe"); }, readFile() { assert.fail("disabled trust probe"); } }), null);
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test("an actual bounded supervisor recovery retains changed-network warnings and refuses a fake hot trust reload", async t => {
  for (const changedTrust of [false, true]) {
    let generation = 0, network = 1, trust = 1, pid = 100;
    const summary = { status: "adapted", network: { source: "direct", type: "direct", bypass_rules: 0, cidr_rules: 0 }, tls: { extra_ca: "configured" } };
    const client = createClientIntegration({ startPrediction: async ({ state }) => {
      const current = ++generation, savedNetwork = network, savedTrust = trust;state.configure(true);state.running({});state.environment(summary);
      return { pacUrl: "http://127.0.0.1:23456/proxy.pac", enabled: () => true, healthy: () => current > 1, appCurrent: () => true,
        inspectEnvironment: () => ({ changed: savedNetwork !== network, requiresServiceRestart: savedTrust !== trust, next: { summary } }),
        inspectRoute: async () => "verified", routeProcessId: () => pid, close: async () => state.stopped() };
    } });t.after(() => client.close());
    const bridge = await client.start();if (changedTrust) trust++;else network++;
    await bridge.check();
    if (changedTrust) {
      assert.equal(generation, 1);assert.equal(client.snapshot().prediction.environment.status, "needs_service_restart");
      assert.equal((await client.fix()).status, "needs_service_restart");
    } else {
      assert.equal(generation, 2);assert.equal((await client.fix()).status, "needs_app_relaunch");
      pid++;assert.equal((await client.fix()).status, "ready");
    }
  }
});
