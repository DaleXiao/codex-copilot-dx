// Test-only Chromium proxy-engine replay. No App account/profile/provider calls.
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { predictionProxyExpression, PREDICTION_PAC_PATH } from "../src/prediction-pac.mjs";

const args = process.argv.slice(2), options = new Map();
for (let i = 0; i < args.length; i += 2) options.set(args[i], args[i + 1]);
assert.ok(path.isAbsolute(options.get("--playwright") || ""), "Supply --playwright /absolute/path/to/playwright/index.js");
const module = await import(pathToFileURL(options.get("--playwright")).href);
const { chromium } = module.default || module;
const listen = (server, port = 0) => new Promise((resolve, reject) => {
  const failed = error => reject(error);
  server.once("error", failed);
  server.listen(port, "127.0.0.1", () => { server.off("error", failed);resolve(server.address().port); });
});
const close = server => new Promise(resolve => { server.closeAllConnections();server.close(resolve); });
const reply = (res, body) => {
  res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", Connection: "close" });
  res.end(body);
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const mode of ["legacy", "recovery", "company-fallback"]) {
  const proxy = http.createServer((_req, res) => reply(res, "BRIDGE"));
  const proxyPort = await listen(proxy);await close(proxy);
  const fallback = http.createServer((_req, res) => reply(res, "FALLBACK"));
  const fallbackPort = await listen(fallback);
  const original = mode === "company-fallback" ? `PROXY 127.0.0.1:${fallbackPort}` : "DIRECT";
  let pacReads = 0;
  const control = http.createServer((req, res) => {
    if (req.url === PREDICTION_PAC_PATH) {
      pacReads++;
      res.writeHead(200, { "Content-Type": "application/x-ns-proxy-autoconfig", "Cache-Control": "no-store" });
      const local = mode === "legacy" ? `'PROXY 127.0.0.1:${proxyPort}'` : predictionProxyExpression(proxyPort);
      // A synthetic HTTP target exercises the real proxy engine without public
      // TLS traffic. Separate unit/TLS tests enforce the production host filter.
      res.end(`function FindProxyForURL(url,host){if(host==='ccdx-target.test')return ${local}+'; ${original}';return 'DIRECT';}`);
    } else reply(res, req.url === "/" ? "<title>isolated proxy recovery</title>" : "FALLBACK");
  });
  const controlPort = await listen(control);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: "chromium",
      ...(options.get("--executable") ? { executablePath: options.get("--executable") } : {}),
      args: [`--proxy-pac-url=http://127.0.0.1:${controlPort}${PREDICTION_PAC_PATH}`,
        "--host-resolver-rules=MAP ccdx-target.test 127.0.0.1", "--disable-background-networking", "--disable-features=HttpsUpgrades"],
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${controlPort}/`);
    const request = () => page.evaluate(async url => (await fetch(url, { signal: AbortSignal.timeout(2500) })).text(),
      `http://ccdx-target.test:${controlPort}/route?${Date.now()}`);
    const rounds = [];
    for (let round = 0; round < (mode === "legacy" ? 1 : 2); round++) {
      assert.equal(await request(), "FALLBACK", "the still-running browser must first reach the failure/fallback state");
      assert.ok(pacReads > 0, "the browser must load the real PAC; direct-only headless-shell is not a valid proxy-engine test");
      await listen(proxy, proxyPort);
      const started = Date.now(), deadline = started + (mode === "legacy" ? 2000 : 15000);
      let route;
      do {
        route = await request();
        if (route === "BRIDGE") break;
        await pause(250);
      } while (Date.now() < deadline);
      assert.equal(route, mode === "legacy" ? "FALLBACK" : "BRIDGE");
      if (mode !== "legacy") {
        for (let i = 0; i < 5; i++) assert.equal(await request(), "BRIDGE");
      }
      rounds.push({ round: round + 1, route, recovery_ms: Date.now() - started });
      await close(proxy);
    }
    console.log(JSON.stringify({ mode, platform: process.platform, browser: browser.version(), same_browser_process: true, pacReads, rounds }));
  } finally { await browser?.close();await close(proxy);await close(control);await close(fallback); }
}
