import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createProviderRuntime } from "../src/provider-runtime.mjs";
import { createApiProvider } from "../src/providers/api.mjs";
import { createAdapterHandler } from "../src/adapter.mjs";
import { createServiceControl } from "../src/service-control.mjs";
import { accessSettingsPath } from "../src/access-settings.mjs";

const options = new Map();for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1]);
const module = await import(options.get("--playwright")), { chromium, webkit } = module.default || module;
process.env.CCDX_DISABLE_USAGE = "1";globalThis.fetch = async () => { throw new Error("Live provider calls are forbidden"); };
const report = [];let discoveries = 0;
for (const [engine, type] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await type.launch({ headless: true });
  try {
    for (const palette of ["green", "klein", "pink"]) for (const mode of ["light", "dark"]) {
      const width = mode === "light" ? 360 : 1280, language = palette === "klein" ? "en" : "zh";
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-connections-browser-")), env = { CCDX_M365: "0" }, values = new Map();
      let runtime, handler;
      const server = http.createServer((req, res) => handler(req, res));
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      await context.addInitScript(({ palette, mode, language }) => { localStorage.setItem("ccdx.dashboard.colorTheme", palette);localStorage.setItem("ccdx.dashboard.theme", mode);localStorage.setItem("ccdx.dashboard.language", language); }, { palette, mode, language });
      const page = await context.newPage(), errors = [];page.on("pageerror", error => errors.push(error.message));page.setDefaultTimeout(10000);
      const sampleName = 'API <img src=x onerror="alert(1)">';
      console.log("Connections case:", JSON.stringify({ engine, palette, mode, language, width }));
      try {
        runtime = createProviderRuntime({ home: root, env, corePort: server.address().port, githubClient: { runtimeStatus: () => ({ token_cached: false }) }, githubRegistry: { models: { data: [] } },
          secretStore: { get: async id => values.get(id), set: async (id, key) => { values.set(id, key); }, remove: async id => { values.delete(id); }, close() {} },
          inspectDesktop: async () => false, configureClaude: input => ({ [input.client === "claude_app" ? "app" : "code"]: "configured" }), restoreClaude: () => ({ preserved: 0 }),
          createApi: options => createApiProvider({ ...options, networkFactory: async () => ({ close() {}, fetch: async (_url, init) => {
            assert.equal(init.method, "GET");discoveries++;return Response.json({ data: [{ id: "catalog-only" }] });
          } }) }) });
        const serviceControl = createServiceControl({ home: root, env, providerRuntime: runtime });
        handler = createAdapterHandler({ providerRuntime: runtime, dashboardOptions: { home: root, env, serviceControl,
          authStatusFn: () => ({ profiles: { codex: { configured: false, valid: false } } }),
          liveModelsFn: async () => ({ models: [], advertised: 0, upstreamHost: "synthetic" }),
          updateStatusFn: async () => ({ source: "release_status", status: "unavailable", current: { version: "synthetic" } }) } });
        await page.goto(base + "/#system");await page.locator("#connection-source-list .connection-row").waitFor();
        await page.locator("#connection-add").click();
        await page.locator("#connection-name").fill(sampleName);await page.locator("#connection-base").fill("https://api.example.test/v1");await page.locator("#connection-base").blur();
        await page.locator("#connection-key").fill("synthetic-key-no-network");
        for (const id of ["codex", "claude_app", "claude_code"]) await page.locator(`#connection-allowed-clients input[value="${id}"]`).check();
        for (const [id, protocol] of [["claude-replay", "messages"], ["response-replay", "responses"]]) {
          await page.locator("#connection-model-id").fill(id);await page.locator("#connection-model-add").click();
          await page.locator("#connection-models tr").filter({ hasText: id }).locator(`input[value="${protocol}"]`).check();
        }
        const fits = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No horizontal page overflow");
        await fits();await page.locator('#connection-api-form button[type="submit"]').click();await page.locator("#connection-editor").waitFor({ state: "hidden" });
        const id = runtime.connections().providers.find(p => !p.builtin).id;
        assert.equal(fs.readFileSync(accessSettingsPath({ home: root, env }), "utf8").includes("synthetic-key-no-network"), false);
        assert.equal(await page.locator("#connection-key").inputValue(), "");assert.equal(await page.locator("#connection-source-list img").count(), 0);
        for (const name of ["Claude App", "Codex App"]) {
          await page.locator("#connection-client-list .connection-row").filter({ hasText: name }).locator("button").click();
          await page.locator("#connection-current").selectOption(id);await page.locator('#connection-client-form button[type="submit"]').click();await page.locator("#connection-client-editor").waitFor({ state: "hidden" });
        }
        assert.equal(runtime.selection().codex, id);assert.equal(runtime.connections().clients.find(c => c.id === "claude_app").source, id);
        await page.locator("#connection-source-list .connection-row").filter({ hasText: sampleName }).locator('input[role="switch"]').click();
        await page.locator("#connection-disable-editor").waitFor({ state: "visible" });await fits();
        await page.locator('#connection-disable-form button[type="submit"]').click();await page.locator("#connection-disable-editor").waitFor({ state: "hidden" });
        assert.equal(runtime.selection().codex, null);assert.equal(runtime.dashboardProviders().some(p => p.id === id), false);
        await page.locator("#connection-disabled > summary").click();
        await page.locator("#connection-disabled-list .connection-row").filter({ hasText: sampleName }).locator("button").click();await page.locator("#connection-source-list .connection-row").filter({ hasText: sampleName }).waitFor();
        assert.equal(runtime.selection().codex, null);assert.equal(values.size, 1);
        await page.locator("#connection-client-list .connection-row").filter({ hasText: "Claude App" }).locator('input[role="switch"]').click();
        await page.locator("#connection-client-list .connection-row").filter({ hasText: "Claude App" }).waitFor({ state: "hidden" });
        assert.equal(runtime.connections().clients.find(c => c.id === "claude_app").enabled, false);await fits();
        if (options.get("--output")) { fs.mkdirSync(options.get("--output"), { recursive: true });await page.screenshot({ path: path.join(options.get("--output"), `${engine}-${palette}-${mode}.png`), fullPage: true }); }
        assert.deepEqual(errors, []);report.push({ engine, palette, mode, language, width, saved: true, assigned: true, disabled: true, restored: true });
      } finally { await context.close();handler?.dispose?.();server.closeAllConnections();await new Promise(resolve => server.close(resolve));await runtime?.close();fs.rmSync(root, { recursive: true, force: true }); }
    }
  } finally { await browser.close(); }
}
assert.equal(discoveries, 0, "Saving and assigning must not probe the upstream");
console.log(JSON.stringify({ cases: report.length, results: report, live_provider_calls: 0, implicit_catalog_requests: discoveries }));
