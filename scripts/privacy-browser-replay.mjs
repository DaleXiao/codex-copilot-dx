import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createAdapterHandler } from "../src/adapter.mjs";
import { createLocalPrivacy } from "../src/local-privacy.mjs";
import { createServiceControl } from "../src/service-control.mjs";

const options = new Map();for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1]);
const { chromium, webkit } = await import(options.get("--playwright"));
globalThis.fetch = async () => { throw Error("Live provider requests are forbidden"); };
const report = [];
for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]].filter(([name]) => !options.get("--engines") || options.get("--engines").split(",").includes(name))) {
  for (const [palette, language, mode, width] of [["green", "en", "light", 1280], ["mono", "zh", "dark", 420]]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-privacy-browser-"));let stage = "not_downloaded", downloads = 0, calls = 0;
    const model = { snapshot: () => ({ state: stage, download_bytes: 38958270, downloaded_bytes: stage === "ready" ? 38958270 : 0, backend: "CPU" }),
      installed: async () => stage !== "not_downloaded", download: async () => { downloads++;stage = "installed"; }, load: async () => { stage = "ready"; },
      find: async texts => { calls++;return texts.map(() => []); }, stop: () => { stage = "installed"; }, remove: async () => { stage = "not_downloaded"; }, close() {}, busy: () => false };
    const privacy = createLocalPrivacy({ home, env: {}, model }), runtime = { privacy, snapshot: () => null };
    const serviceControl = createServiceControl({ home, env: {}, providerRuntime: runtime });
    const handler = createAdapterHandler({ privacy, env: {}, dashboardOptions: { home, env: {}, serviceControl, authStatusFn: () => ({ profiles: {} }) } });
    const server = http.createServer(handler);await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await engine.launch({ headless: true, ...(options.get("--channel") ? { channel: options.get("--channel") } : {}) });
    const page = await browser.newPage({ viewport: { width, height: 900 } });page.setDefaultTimeout(12000);
    const timer = setTimeout(() => { console.error("Privacy browser watchdog");process.exit(2); }, 120000);
    const errors = [];page.on("pageerror", error => errors.push(error.message));
    try {
      await page.addInitScript(({ palette, language, mode }) => { localStorage.setItem("ccdx.dashboard.palette", palette);localStorage.setItem("ccdx.dashboard.theme", mode);localStorage.setItem("ccdx.dashboard.language", language); }, { palette, language, mode });
      await page.goto(`http://127.0.0.1:${server.address().port}/#system`);
      await page.waitForFunction(() => !document.getElementById("privacy-enabled").disabled);
      assert.equal(await page.locator("#privacy-enabled").isChecked(), false);assert.equal(downloads, 0);assert.equal(calls, 0);
      await page.locator("#privacy-enabled").click();assert.equal(await page.locator("#privacy-dialog").isVisible(), true);assert.equal(downloads, 0);
      await page.locator("#privacy-dialog-cancel").click();assert.equal(downloads, 0);
      await page.locator("#privacy-enabled").click();await page.locator("#privacy-dialog-confirm").click();
      await page.waitForFunction(() => document.getElementById("privacy-enabled").checked);assert.equal(downloads, 1);
      await page.locator(".privacy-preview summary").click();await page.locator("#privacy-text").fill("api_key=local-only-demo");await page.locator("#privacy-preview").click();
      await page.waitForFunction(() => !document.getElementById("privacy-result").hidden);
      assert.match(await page.locator("#privacy-result").textContent(), /\{\{CCDX_/);assert.doesNotMatch(await page.locator("#privacy-result").textContent(), /local-only-demo/);
      await page.locator("#privacy-personal").click();await page.waitForFunction(() => document.getElementById("privacy-personal").checked && !document.getElementById("privacy-personal").disabled);
      await page.locator("#terminal-color-theme").selectOption("orange");
      await page.waitForTimeout(700);assert.equal(await page.locator("#preferences-error").textContent(), "");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);assert.deepEqual(errors, []);
      await page.locator("#privacy-enabled").click();await page.waitForFunction(() => !document.getElementById("privacy-enabled").checked && !document.getElementById("privacy-enabled").disabled);
      await page.locator("#privacy-remove").click();await page.waitForFunction(() => document.getElementById("privacy-remove").hidden);
      report.push({ engine: name, palette, language, mode, width, downloads, local_checks: calls, status: "passed" });console.log(JSON.stringify(report.at(-1)));
    } finally { clearTimeout(timer);await browser.close();handler.cleanup();privacy.close();await new Promise(resolve => server.close(resolve));fs.rmSync(home, { recursive: true, force: true }); }
  }
}
console.log(JSON.stringify({ cases: report.length, provider_calls: 0 }));
