import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { resolveNetworkRoute, networkProxyFor, networkPredictionPac, networkRouteSnapshot } from "../src/network-route.mjs";

test("static proxy selection respects scheme, environment priority and system settings", () => {
  assert.doesNotThrow(() => resolveNetworkRoute({ env: { NO_PROXY: "10.0.0.0/8" } }));
  const systemProxy = "HTTPEnable : 1\nHTTPProxy : system.test\nHTTPPort : 8080\nHTTPSEnable : 1\nHTTPSProxy : secure.test\nHTTPSPort : 8081\n";
  const plan = resolveNetworkRoute({ env: { https_proxy: "http://preferred.test:3128", HTTPS_PROXY: "http://ignored.test:8080" }, systemProxy });
  assert.equal(plan.https.source, "https_proxy"); assert.equal(plan.https.url.hostname, "preferred.test");
  assert.equal(plan.http.source, "system HTTP");
  assert.equal(resolveNetworkRoute({ env: { HTTP_PROXY: "http://only-http.test:8080" } }).https, null);
  assert.equal(resolveNetworkRoute({ env: { ALL_PROXY: "socks5://socks.test:1080" } }).https.url.protocol, "socks5:");
  assert.equal(resolveNetworkRoute({ env: {}, systemProxy }).https.url.hostname, "secure.test");
});

test("NO_PROXY, system exceptions, local hosts and port-specific rules are preserved", () => {
  const plan = resolveNetworkRoute({ env: { HTTPS_PROXY: "http://proxy.test:8080", NO_PROXY: ".example.test,port.test:444,*.internal.test" },
    systemProxy: "ExceptionsList : <array> {\n0 : system-exception.test\n}\nExcludeSimpleHostnames : 1" });
  for (const url of ["https://localhost", "https://127.0.0.1", "https://host", "https://a.example.test", "https://port.test:444", "https://a.internal.test", "https://system-exception.test"]) assert.equal(networkProxyFor(new URL(url), plan), null, url);
  for (const url of ["https://chatgpt.com", "https://port.test", "https://example.test.evil.test"]) assert.equal(networkProxyFor(new URL(url), plan)?.url.hostname, "proxy.test", url);
});

test("prediction PAC retains original proxy paths and never embeds proxy credentials", () => {
  const plan = resolveNetworkRoute({ env: { HTTPS_PROXY: "http://alice:secret@proxy.test:8080", HTTP_PROXY: "socks5://socks.test:1080", NO_PROXY: ".direct.test" } });
  const pac = networkPredictionPac(12345, plan);
  assert.ok(!pac.includes("alice") && !pac.includes("secret"));
  const context = { shExpMatch: (s, rule) => new RegExp(`^${rule.replaceAll(".", "\\.").replaceAll("*", ".*")}$`).test(s), dnsDomainIs: (s, suffix) => s.endsWith(suffix) };
  context.Date = { now: () => 0 };
  vm.runInNewContext(pac, context);
  assert.equal(context.FindProxyForURL("https://chatgpt.com/", "chatgpt.com"), "PROXY 127.0.0.1:12345; PROXY ccdx-0.localhost:12345; PROXY proxy.test:8080");
  assert.equal(context.FindProxyForURL("https://other.test/", "other.test"), "PROXY proxy.test:8080");
  assert.equal(context.FindProxyForURL("http://other.test/", "other.test"), "SOCKS5 socks.test:1080");
  assert.equal(context.FindProxyForURL("https://a.direct.test/", "a.direct.test"), "DIRECT");
  assert.equal(context.FindProxyForURL("https://127.0.0.1:2026/", "127.0.0.1"), "DIRECT");
  assert.deepEqual(networkRouteSnapshot(plan), { source: "HTTPS_PROXY", type: "http", bypass_rules: 1, proxy_credentials: true });
});

test("dynamic PAC/WPAD and custom API routes fail with specific causes without mutation", () => {
  for (const key of ["ProxyAutoConfigEnable", "ProxyAutoDiscoveryEnable"]) assert.throws(() => resolveNetworkRoute({ env: {}, systemProxy: `${key} : 1` }), new RegExp(key));
  assert.doesNotThrow(() => resolveNetworkRoute({ env: { CODEX_API_BASE_URL: "https://chatgpt.com/backend-api/" } }));
  assert.throws(() => resolveNetworkRoute({ env: { CODEX_API_BASE_URL: "https://custom.test" } }), /CODEX_API_BASE_URL/);
  for (const value of ["ftp://proxy.test", "http://proxy.test/path", "invalid", "http://proxy.test?x=1"]) assert.throws(() => resolveNetworkRoute({ env: { HTTPS_PROXY: value } }), /HTTPS_PROXY/);
});

test("empty or bypass-all configuration preserves direct routing", () => {
  const direct = resolveNetworkRoute({ env: {} });
  assert.equal(networkProxyFor(new URL("https://chatgpt.com"), direct), null);
  const bypass = resolveNetworkRoute({ env: { HTTPS_PROXY: "https://proxy.test:443", NO_PROXY: "*" } });
  assert.equal(networkProxyFor(new URL("https://chatgpt.com"), bypass), null);
});
