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
for (const [engine, type] of [["chromium", chromium], ["webkit", webkit]].filter(([name]) => !options.get("--engines") || options.get("--engines").split(",").includes(name))) {
  const browser = await type.launch({ headless: true });
  try {
    for (const palette of (options.get("--palettes") || "green,klein,pink").split(",")) for (const mode of (options.get("--modes") || "light,dark").split(",")) {
      const width = mode === "light" ? 360 : 1280, language = palette === "klein" ? "en" : "zh";
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-connections-browser-")), env = { CCDX_M365: "0" }, values = new Map();
      fs.mkdirSync(path.join(root, ".codex"));fs.writeFileSync(path.join(root, ".codex/config.toml"), '[features]\nmemories=true\n[memories]\nextract_model="response-replay"\n');
      let runtime, handler;const githubRegistry = { models: { data: [] } };
      const server = http.createServer((req, res) => handler(req, res));
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      // Binding edits are explicit; periodic refresh behavior has its own replay.
      await context.addInitScript(({ palette, mode, language }) => { localStorage.setItem("ccdx.dashboard.palette", palette);localStorage.setItem("ccdx.dashboard.theme", mode);localStorage.setItem("ccdx.dashboard.language", language);localStorage.setItem("ccdx.dashboard.autoRefresh", "off"); }, { palette, mode, language });
      const page = await context.newPage(), errors = [];page.on("pageerror", error => errors.push(error.message));page.setDefaultTimeout(10000);
      const sampleName = 'API <img src=x onerror="alert(1)">';
      console.log("Connections case:", JSON.stringify({ engine, palette, mode, language, width }));
      const watchdog = setTimeout(() => { console.error("Connection browser case exceeded 120 seconds");process.exit(124); }, 120000);watchdog.unref();
      try {
        runtime = createProviderRuntime({ home: root, env, corePort: server.address().port, githubClient: { runtimeStatus: () => ({ token_cached: false }) }, githubRegistry,
          secretStore: { get: async id => values.get(id), set: async (id, key) => { values.set(id, key); }, remove: async id => { values.delete(id); }, close() {} },
          inspectDesktop: async () => false, configureClaude: input => ({ [input.client === "claude_app" ? "app" : "code"]: "configured" }), restoreClaude: () => ({ preserved: 0 }),
          createApi: options => createApiProvider({ ...options, networkFactory: async () => ({ close() {}, fetch: async (_url, init) => {
            assert.equal(init.method, "GET");discoveries++;return Response.json({ data: ["claude-replay", "response-replay", ...Array.from({ length: 6 }, (_, i) => "unselected-" + i)].map(id => ({ id, publisher: "Example Maker", vendor: "example", owned_by: "gateway", ...(id === "claude-replay" ? { type: "model", max_input_tokens: 128000, max_tokens: 16000, capabilities: { thinking: { supported: true }, effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true } } } } : {}) })) });
          } }) }) });
        const serviceControl = createServiceControl({ home: root, env, providerRuntime: runtime });
        handler = createAdapterHandler({ providerRuntime: runtime, dashboardOptions: { home: root, env, serviceControl,
          authStatusFn: () => ({ profiles: { codex: { configured: false, valid: false } } }),
          liveModelsFn: async () => ({ models: [], advertised: 0, upstreamHost: "synthetic" }),
          updateStatusFn: async () => ({ source: "release_status", status: "unavailable", current: { version: "synthetic" } }) } });
        await page.goto(base + "/#models");await page.locator("#connection-source-list .connection-row").waitFor();assert.equal(await page.locator("html").getAttribute("data-palette"), palette);
        await page.locator("#connection-add").focus();await page.keyboard.press("Enter");assert.equal(await page.locator("#connection-name").evaluate(node => node === document.activeElement), true, "Add API focuses its first field");
        await page.locator("#connection-name").fill(sampleName);await page.locator("#connection-base").fill("https://api.example.test/v1");await page.locator("#connection-base").blur();
        await page.locator("#connection-key").fill("synthetic-key-no-network");
        for (const id of ["codex", "claude_app", "claude_code"]) await page.locator(`#connection-allowed-clients input[value="${id}"]`).check();
        const fits = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No horizontal page overflow");
        await fits();await page.locator('#connection-api-form button[type="submit"]').click();await page.locator("#connection-editor").waitFor({ state: "hidden" });
        const id = runtime.connections().providers.find(p => !p.builtin).id;
        assert.equal(runtime.connections().providers.find(p => p.id === id).models.length, 0);
        await page.locator('[data-route="claude"]').click();await page.locator("#connection-bindings").waitFor();
        assert.match(await page.locator("#connection-bindings").innerText(), /暂无|No models/);
        await page.locator('[data-route="models"]').click();
        await page.locator("#connection-source-list .connection-row").filter({ hasText: sampleName }).locator("button").click();
        await page.locator("#connection-discover").click();
        await page.waitForFunction(() => document.querySelectorAll("#connection-models tr").length === 8);
        assert.equal(await page.locator("#connection-manual-model").getAttribute("open"), null, "Manual IDs remain an optional collapsed entry");
        const unconfigured = page.locator("#connection-models tr").filter({ hasText: "unselected-0" });
        await unconfigured.locator('input[name="selected-model"]').check();await page.locator('#connection-api-form button[type="submit"]').click();
        assert.equal(runtime.connections().providers.find(p => p.id === id).models.length, 0, "A selected model without APIs cannot overwrite saved data");
        assert.match(await page.locator("#connection-note").innerText(), /unselected-0/);await unconfigured.locator('input[name="selected-model"]').uncheck();
        await page.locator("#connection-models tr").filter({ hasText: "claude-replay" }).locator('input[name="selected-model"]').check();
        for (const [model, protocol] of [["claude-replay", "messages"], ["claude-replay", "responses"], ["response-replay", "responses"]]) {
          await page.locator("#connection-models tr").filter({ hasText: model }).locator(`input[value="${protocol}"]`).check();
        }
        assert.equal(await page.locator('#connection-models input[name="selected-model"]:checked').count(), 2, "Checking an API selects its model");
        assert.equal(await page.locator("#connection-model-id").inputValue(), "", "Catalog selection does not require typing an ID");
        const modelRow = page.locator("#connection-models tr").filter({ hasText: "claude-replay" });
        await modelRow.locator("button").first().click();
        assert.match(await page.locator('#connection-model-detail > table').innerText(), /128K/);
        assert.match(await page.locator('#connection-model-detail .model-identity').innerText(), /Example Maker/);
        await page.locator('#connection-model-detail > select').selectOption("responses");
        assert.doesNotMatch(await page.locator('#connection-model-detail > table').innerText(), /128K|low \/ medium/);
        await page.locator('#connection-model-detail > select').selectOption("messages");
        if (options.get("--output")) await page.locator('#connection-model-detail').screenshot({ path: path.join(options.get("--output"), `${engine}-${palette}-${mode}-capabilities.png`) });
        assert.equal(await page.locator('#connection-model-detail > details').getAttribute('open'), null);
        await page.locator('#connection-model-detail > details > summary').click();await page.locator('#connection-model-detail select[data-capability="tools"]').selectOption("false");
        await page.locator('#connection-model-detail > details > button').click();

        assert.equal(await page.locator('#connection-models tr').first().locator('input[value="chat"]').isDisabled(), true);
        if (options.get("--output")) { fs.mkdirSync(options.get("--output"), { recursive: true });await page.locator("#connection-editor").screenshot({ path: path.join(options.get("--output"), `${engine}-${palette}-${mode}-model-selection.png`) }); }
        await page.locator('#connection-api-form button[type="submit"]').click();
        try { await page.locator("#connection-editor").waitFor({ state: "hidden" }); }
        catch (error) { console.error("Model save message:", await page.locator("#connection-note").innerText());throw error; }
        assert.deepEqual(runtime.connections().providers.find(p => p.id === id).models.map(m => m.id), ["claude-replay", "response-replay"]);

        assert.equal(fs.readFileSync(accessSettingsPath({ home: root, env }), "utf8").includes("synthetic-key-no-network"), false);
        assert.equal(await page.locator("#connection-key").inputValue(), "");assert.equal(await page.locator("#connection-source-list img").count(), 0);
        for (const [route, model, idClient] of [["claude", "claude-replay", "claude_app"], ["codex", "response-replay", "codex"]]) {
          await page.locator(`[data-route="${route}"]`).click();
          await page.locator("#connection-bindings tr").filter({ hasText: model }).locator('input[name="binding-model"]').check();
          assert.equal(await page.locator('#connection-bindings input[name="binding-model"]:checked').evaluate(node => node === document.activeElement), true, "Model selection retains keyboard focus");
          const savedBinding = page.waitForResponse(response => response.url().endsWith("/_ccdx/ui/connections") && response.request().method() === "POST");
          await page.locator('#connection-client-form button[type="submit"]').click();assert.equal((await savedBinding).status(), 200);
          assert.equal(runtime.connections().clients.find(c => c.id === idClient).deployments[0].model, model);
          const beforePreview = fs.readFileSync(accessSettingsPath({ home: root, env }), "utf8");
          await page.locator("#connection-sync-preview").click();await page.locator("#connection-sync-result").waitFor({ state: "visible" });assert.match(await page.locator("#connection-sync-result").innerText(), new RegExp(model));await page.locator('#connection-client-form button[type="submit"]:enabled').waitFor();await fits();
          assert.equal(fs.readFileSync(accessSettingsPath({ home: root, env }), "utf8"), beforePreview, "Sync preview never writes configuration");
          if (options.get("--output")) await page.screenshot({ path: path.join(options.get("--output"), `${engine}-${palette}-${mode}-${route}-bindings.png`), fullPage: true });
        }
        await page.locator('[data-route="codex"]').click();
        await page.waitForFunction(() => document.getElementById("connection-memory-name").textContent === "response-replay");
        for (const [enabled, expected] of [[true, language === "zh" ? "由 Codex 选择" : "Chosen by Codex"],
          [false, language === "zh" ? "记忆生成已关闭" : "Memory generation is off"], [null, language === "zh" ? "未检测到" : "Not detected"]]) {
          await page.evaluate(enabled => globalThis.ccdxConnections.updateMemory({ clients: [{ id: "codex", memory_model: { model: null, basis: "unknown", enabled } }] }), enabled);
          assert.equal(await page.locator("#connection-memory-name").innerText(), expected);
          assert.equal(await page.locator("#connection-memory-state").isVisible(), false, "An unknown model must not claim a selected-model state");
          assert.equal(await page.locator("#connection-memory-warning").isVisible(), false, "Model closure is not inferred without model evidence");
          assert.equal((await page.locator("#connection-memory-basis").innerText()).length > 0, enabled === true);
        }
        await page.evaluate(() => globalThis.ccdxConnections.updateMemory({ clients: [{ id: "codex", memory_model: { model: "response-replay", basis: "configured", enabled: true } }] }));
        const memoryBox = page.locator('#connection-bindings tr').filter({ hasText: "response-replay" }).locator('input[name="binding-model"]');
        await memoryBox.click();await page.locator('#connection-memory-confirm').waitFor({ state: "visible" });
        assert.match(await page.locator('#connection-memory-confirm').innerText(), language === "zh" ? /可能无法生成新记忆/ : /may prevent new memory/);
        await page.locator('#connection-memory-keep').click();assert.equal(await memoryBox.isChecked(), true);
        await memoryBox.click();await page.locator('#connection-memory-close').click();assert.equal(await memoryBox.isChecked(), false);
        assert.match(await page.locator('#connection-memory-state').innerText(), language === "zh" ? /待保存/ : /after saving/);
        await page.locator('#connection-client-form button[type="submit"]').click();
        await page.waitForFunction(() => document.getElementById("connection-memory-state").textContent.includes(document.documentElement.lang.startsWith("zh") ? "未选入" : "Not selected"));
        assert.equal(await page.locator('#connection-memory-warning').isVisible(), true);
        await memoryBox.check();await page.locator('#connection-client-form button[type="submit"]').click();
        await page.waitForFunction(() => document.getElementById("connection-memory-warning").hidden);
        await page.locator('[data-route="claude"]').click();
        await page.locator("#claude-model-management #connection-bindings tr").filter({ hasText: "claude-replay" }).locator('input[name="binding-model"]').uncheck();
        await page.locator('[data-claude-client="claude_code"]').click();
        await page.locator('#connection-bindings input[name="binding-model"]').first().check();
        await page.locator('[data-claude-client="claude_app"]').click();assert.equal(await page.locator('#connection-bindings input:checked').count(), 0, "App draft survives a Code edit");
        await page.evaluate(() => globalThis.ccdxConnections.load());assert.equal(await page.locator('#connection-bindings input:checked').count(), 0, "Refresh preserves the active draft");
        await page.locator('[data-route="codex"]').click();await page.locator('#codex-model-management #connection-bindings').waitFor();await page.locator('[data-route="claude"]').click();await page.locator('#claude-model-management #connection-bindings').waitFor();assert.equal(await page.locator('#connection-bindings input:checked').count(), 0, "Navigation preserves the draft");
        await page.locator('#connection-client-cancel').click();assert.equal(await page.locator('#connection-bindings input:checked').count(), 1);
        await page.locator('[data-claude-client="claude_code"]').click();assert.equal(await page.locator('#connection-bindings input:checked').count(), 1, "Discard affects only the active client");
        await page.locator('#connection-client-cancel').click();await page.locator('[data-claude-client="claude_app"]').click();
        githubRegistry.models = { data: ["gpt-retained", "gpt-temporarily-missing"].map(id => ({ id, supported_endpoints: ["/responses"] })) };
        const codexClient = runtime.connections().clients.find(c => c.id === "codex");
        await runtime.manageConnections({ operation: "client", id: "codex", enabled: true, allowed: codexClient.allowed,
          deployments: githubRegistry.models.data.map(model => ({ source: "github", model: model.id })) });
        githubRegistry.models = { data: [githubRegistry.models.data[0]] };
        await page.waitForLoadState("networkidle");await page.goto(base + "/?binding-replay=missing#codex");await page.locator("#connection-bindings tr").filter({ hasText: "gpt-retained" }).locator('input[name="binding-model"]:checked').waitFor();
        const beforeMissing = fs.readFileSync(accessSettingsPath({ home: root, env }), "utf8");
        const failedSave = page.waitForResponse(response => response.url().endsWith("/_ccdx/ui/connections") && response.request().method() === "POST");
        await page.locator('#connection-client-form button[type="submit"]').click();assert.equal((await failedSave).status(), 400);
        assert.equal(fs.readFileSync(accessSettingsPath({ home: root, env }), "utf8"), beforeMissing, "A missing catalog entry cannot silently remove a saved selection");
        assert.equal(runtime.connections().clients.find(c => c.id === "codex").deployments.length, 2);
        const missingRow = page.locator("#connection-bindings tr").filter({ hasText: "gpt-temporarily-missing" });
        assert.match(await missingRow.innerText(), /Unavailable|暂不可用/);await missingRow.locator('input[name="binding-model"]').click();
        const correctedSave = page.waitForResponse(response => response.url().endsWith("/_ccdx/ui/connections") && response.request().method() === "POST");
        await page.locator('#connection-client-form button[type="submit"]').click();assert.equal((await correctedSave).status(), 200);
        assert.deepEqual(runtime.connections().clients.find(c => c.id === "codex").deployments, [{ source: "github", model: "gpt-retained" }]);
        await runtime.manageConnections({ operation: "client", id: "codex", enabled: true, allowed: codexClient.allowed, deployments: [{ source: id, model: "response-replay" }] });
        githubRegistry.models = { data: [] };
        await page.waitForLoadState("networkidle");await page.goto(base + "/?binding-replay=restored#models");await page.locator("#connection-source-list .connection-row").filter({ hasText: sampleName }).waitFor();
        await page.locator("#connection-source-list .connection-row").filter({ hasText: sampleName }).locator('input[role="switch"]').click();
        await page.locator("#connection-memory-confirm").waitFor({ state: "visible" });
        assert.equal(runtime.connections().providers.find(p => p.id === id).enabled, true, "Source stays on before confirmation");
        await page.locator("#connection-memory-close").click();
        await page.locator("#connection-disable-editor").waitFor({ state: "visible" });await fits();
        await page.locator('#connection-disable-form button[type="submit"]').click();await page.locator("#connection-disable-editor").waitFor({ state: "hidden" });
        assert.equal(runtime.selection().codex, null);assert.equal(runtime.dashboardProviders().some(p => p.id === id), false);
        assert.equal(await page.locator("#connection-sources #connection-disabled-sources").count(), 1);
        assert.equal(await page.locator("#connection-clients #connection-disabled-source-list").count(), 0);
        await page.locator("#connection-disabled-sources > summary").click();
        await page.locator("#connection-disabled-source-list .connection-row").filter({ hasText: sampleName }).locator("button").click();await page.locator("#connection-source-list .connection-row").filter({ hasText: sampleName }).waitFor();
        assert.equal(await page.locator("#connection-disabled-source-list .connection-row").filter({ hasText: sampleName }).count(), 0);
        assert.equal(await page.locator("#connection-disabled-sources").isHidden(), !runtime.connections().providers.some(p => !p.enabled));
        assert.equal(runtime.selection().codex, null);assert.equal(values.size, 1);
        await page.locator('[data-route="claude"]').click();
        await page.locator("#connection-client-list .connection-row").filter({ hasText: "Claude App" }).locator('input[role="switch"]').click();
        await page.locator("#connection-client-editor").waitFor({ state: "hidden" });
        assert.equal(runtime.connections().clients.find(c => c.id === "claude_app").enabled, false);await fits();
        assert.equal(await page.locator("#connection-clients #connection-disabled-clients").count(), 1);
        await page.locator("#connection-disabled-clients > summary").click();
        assert.equal(await page.locator("#connection-disabled-client-list .connection-row").count(), 1);
        await page.locator("#connection-disabled-client-list .connection-row").filter({ hasText: "Claude App" }).locator("button").click();
        await page.locator("#connection-client-list .connection-row").filter({ hasText: "Claude App" }).waitFor();
        assert.equal(runtime.connections().clients.find(c => c.id === "claude_app").source, null);
        await page.locator("#connection-disabled-clients").waitFor({ state: "hidden" });
        if (options.get("--output")) { fs.mkdirSync(options.get("--output"), { recursive: true });await page.screenshot({ path: path.join(options.get("--output"), `${engine}-${palette}-${mode}.png`), fullPage: true }); }
        assert.deepEqual(errors, []);report.push({ engine, palette, mode, language, width, saved: true, assigned: true, disabled: true, restored: true });
      } catch (error) { console.error("Browser details:", errors, await page.locator("#connection-client-note").textContent());throw error; } finally { await context.close();handler?.dispose?.();server.closeAllConnections();await new Promise(resolve => server.close(resolve));await runtime?.close();fs.rmSync(root, { recursive: true, force: true });clearTimeout(watchdog); }
    }
  } finally { await browser.close(); }
}
assert.equal(discoveries, report.length, "One automatic catalog read per case; explicit reads and model saves reuse its cache");
console.log(JSON.stringify({ cases: report.length, results: report, live_provider_calls: 0, automatic_catalog_requests: discoveries, inference_requests: 0 }));
