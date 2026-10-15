import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { PREDICTION_PAC_PATH, isPredictionPacUrl } from "../src/prediction-pac.mjs";
import { predictionPac } from "../src/native-prediction-transport.mjs";
import { networkPredictionPac, resolveNetworkRoute } from "../src/network-route.mjs";
import { companyPredictionPac } from "../src/windows-prediction-network.mjs";

test("PAC revision is stable and validates only the exact old/new loopback bindings", () => {
  assert.equal(PREDICTION_PAC_PATH, "/proxy.pac?v=2");
  for (const suffix of ["/proxy.pac", PREDICTION_PAC_PATH]) assert.equal(isPredictionPacUrl(`http://127.0.0.1:12345${suffix}`), true);
  for (const url of [null, "https://127.0.0.1:12345/proxy.pac?v=2", "http://remote.test:12345/proxy.pac?v=2",
    "http://127.0.0.1:12345/proxy.pac?v=3", "http://127.0.0.1:12345/proxy.pac?v=2&other=1",
    "http://127.0.0.1:12345/proxy.pac?v=2#other", "http://127.0.0.1:1/proxy.pac?v=2",
    "http://127.0.0.1:99999/proxy.pac?v=2"]) assert.equal(isPredictionPacUrl(url), false, String(url));
});

test("all routing modes keep the primary endpoint and original fallback, with a fresh secondary retry name", () => {
  const company = "function FindProxyForURL(){return 'PROXY company.test:8080; DIRECT';}";
  const sources = [
    [predictionPac(12345), "DIRECT", "DIRECT"],
    [networkPredictionPac(12345, resolveNetworkRoute({ env: { HTTPS_PROXY: "http://company.test:8080" } })), "PROXY company.test:8080", "DIRECT"],
    [companyPredictionPac(company, 12345), "PROXY company.test:8080; DIRECT", "PROXY company.test:8080; DIRECT"],
  ];
  for (const [source, fallback, webSocketFallback] of sources) {
    let now = 0;
    const context = { Date: { now: () => now } };
    vm.runInNewContext(source, context);
    const route = () => context.FindProxyForURL("https://chatgpt.com/x", "chatgpt.com");
    assert.equal(route(), `PROXY 127.0.0.1:12345; PROXY ccdx-0.localhost:12345; ${fallback}`);
    now = 9999;assert.match(route(), /ccdx-0\.localhost/);
    now = 10000;assert.match(route(), /ccdx-1\.localhost/);
    assert.equal(context.FindProxyForURL("https://unrelated.test/x", "unrelated.test"), fallback);
    assert.equal(context.FindProxyForURL("wss://chatgpt.com/x", "chatgpt.com"), webSocketFallback);
    assert.doesNotMatch(source, /dnsResolve|isResolvable|fetch\(|setInterval|setTimeout/);
  }
});
