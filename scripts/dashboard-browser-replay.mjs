// Real browser engines against an isolated local, synthetic dashboard.
// Playwright is supplied by the test environment, not a CCDX runtime dependency.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { createServiceControl } from "../src/service-control.mjs";
import { createAdapterHandler } from "../src/adapter.mjs";
import { summarizeUsage } from "../src/usage-store.mjs";

const args = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < args.length; index += 2) options.set(args[index], args[index + 1]);
assert.ok(path.isAbsolute(options.get("--playwright") || ""), "Supply --playwright /absolute/path/to/playwright/index.js");
const module = await import(options.get("--playwright"));
const playwright = module.default || module;
const output = options.get("--output");
if (output) await fs.mkdir(output, { recursive: true });
process.env.CCDX_DISABLE_USAGE = "1";
globalThis.fetch = async () => { throw Error("Real provider calls are forbidden"); };
let models = 0, summaries = 0;
const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-dashboard-replay-"));
let predictionActive = true, codexSource = "github", m365Enabled = true;
const accountChoices = ["a", "b"].map(letter => ({ id: letter.repeat(64), login: `${letter}@example.test`, tenant: `company-${letter}` }));
let companyAccount = accountChoices[0], accountChecks = 0, accountChanges = 0, refuseAccountChange = false;
let m365Preference = { model: "gpt-source", auto_review_model: "gpt-source", auto_review_effort: "low" };
const serviceControl = createServiceControl({ home, env: {}, readImages: () => ({}), readPrediction: () => ({ enabled: true }),
  clientIntegration: { snapshot: () => ({ prediction: { configured: true, bridge: "running", active: predictionActive } }), setPredictionActive(value) { predictionActive = value; }, fix: async () => {} },
  providerRuntime: { snapshot: () => ({ codex_provider: codexSource, github: { preference: { model: "gpt-6.1-sol", reasoningEffort: "low" } }, m365: { preference: m365Preference, state: m365Enabled ? "ready" : "disabled", enabled: m365Enabled, account: { ...companyAccount, selection_source: "manual" } } }),
    async action(input) {
      if (input.action === "switch") { codexSource = input.provider;if (input.provider === "m365") m365Preference = { ...m365Preference, model: input.model, ...(input.auto_review_model ? { auto_review_model: input.auto_review_model, auto_review_effort: input.auto_review_effort } : {}) }; }
      else if (input.action === "auto-review") m365Preference = { ...m365Preference, auto_review_model: input.model, auto_review_effort: input.effort };
      else if (input.action === "account") {
        accountChanges++;
        if (refuseAccountChange) throw Object.assign(Error("Model access denied"), { code: "m365_llm_permission_unavailable", statusCode: 403 });
        companyAccount = accountChoices.find(value => value.id === input.account_id);
      }
      else m365Enabled = input.action === "on";
    } },
});
const records = Array.from({ length: 10 }, (_, index) => ({ ts: new Date(Date.now() - index * 86400000).toISOString(),
  provider: index % 2 ? "m365" : "github", model: index % 2 ? "claude-opus-5.5" : "gpt-6.1-sol",
  usage: { input_tokens: 100 * (index + 1), cached_input_tokens: 50, output_tokens: 20, total_tokens: 120 + 100 * index } }));
const providerState = () => [
  { id: "github", name: "GitHub Copilot", selection: { codex: true, models_required: false }, enabled: true, state: "ready", clients: [{ id: "codex", name: "Codex App", selected: true, state: "configured" }] },
  { id: "m365", name: "Microsoft 365", selection: { codex: true, models_required: true }, enabled: true, state: "ready", auth: { state: "authorized", account: "synthetic@example.test" },
    clients: [{ id: "claude_app", name: "Claude App", state: "configured", gateway: "running" }], requests: { completed: 3, incomplete: 1, failed: 2 } },
  { id: "third", name: "Third source", enabled: false, state: "disabled", clients: [] },
];
const handler = createAdapterHandler({ dashboardOptions: { home, env: {}, serviceControl,
  providerStateFn: providerState,
  providerAccountsFn: async () => { accountChecks++;return { accounts: accountChoices.map(value => ({ ...value, selected: value.id === companyAccount.id })) }; },
  providerCatalogFn: async ({ provider }) => {
    if (provider === "github") return null;
    if (provider === "third") throw Object.assign(Error("Unavailable"), { code: "m365_disabled", statusCode: 503 });
    return { source: "catalog", checkedAt: new Date().toISOString(), advertised: 1, upstreamHost: "Microsoft 365", models: [
      { id: "claude-opus-5.5", vendor: "Anthropic", endpoints: ["messages"], clients: ["claude_app", "claude_code"], reasoning_efforts: ["low", "high"], selectable: true },
          { id: "gpt-source", vendor: "OpenAI", endpoints: ["responses"], clients: ["codex"], reasoning_efforts: ["low"], auto_review_efforts: ["low"], selectable: true },
      { id: "gpt-second", vendor: "OpenAI", endpoints: ["responses"], clients: ["codex"], reasoning_efforts: ["low"], auto_review_efforts: ["low"], selectable: true },
    ] };
  },
  liveModelsFn: async () => { models++; return { models: [{ id: "gpt-6.1-sol", vendor: "OpenAI", endpoints: ["responses"], clients: ["codex"], auto_review_efforts: ["low", "high"], preview: false }], advertised: 1, upstreamHost: "synthetic.local" }; },
  authStatusFn: () => ({ profiles: { codex: { configured: true, valid: true, login: "synthetic_user" } } }),
  usageSummaryFn: async options => { summaries++; const selected = records.filter(record => !options?.provider || record.provider === options.provider);
    for (const record of selected) options?.onRecord?.(record, summarizeUsage([record])); return summarizeUsage(selected, { provider: options?.provider }); },
} });
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/_ccdx/ui/animation")) {
    res.writeHead(200, { "content-type": "application/json" });
    const frames = !req.url.includes("frames=0");
    res.end(JSON.stringify({ theme: "comet", source: "default", disabled_by_environment: false,
      themes: ["comet", "twin"].map(id => ({ id, label: id === "comet" ? "Comet" : "Twin", default: id === "comet",
        ...(frames ? { frames: [{ ansi: "[●··]", delay_ms: 100 }], loop_pause_ms: 100 } : {}) })) }));
    return;
  }
  if (req.url === "/_ccdx/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: "codex-copilot-dx", version: "synthetic", pid: 1, uptime_ms: 1000,
      requests: { total: 1, active: 0 }, models: { models: 1, source: "synthetic" },
      stream_performance: { by_route: { responses: {
        ttft_ms: { avg: 1250, samples: 3 }, output_tokens_per_second: { avg: 123.4, samples: 2, unit: "token/s" },
      } } },
      response_failures: { recent:[{provider:"m365",code:"synthetic_error",model:"gpt-test",retried:false}] },
      http_errors: { by_category: { inference: 1, protocol: 2, route: 3, other: 0 } },
      providers: { codex_provider: "github", m365: { state: "ready", account: { login: "synthetic@example.test" }, models: { claude: 10, gpt: 5 },
        claude: { base_url: `http://127.0.0.1:${server.address().port}/anthropic`, gateway: "running", requests: { completed: 3, incomplete: 1, failed: 2 }, clients: { code: "configured", app: "configured" } } } },
      runtime_usage: { records: 4, input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 },
      process: { rss_bytes: 123456, heap_used_bytes: 34567 },
      response_history: { bytes: 0, maxBytes: 67108864 }, client_integrations: { prediction: { configured: false, bridge: "stopped" } } }));
    return;
  }
  handler(req, res);
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const results = [];
try {
  for (const engine of (options.get("--engines") || "chromium,webkit").split(",")) {
    const browser = await playwright[engine].launch({ headless: true, ...(options.get("--executable") ? { executablePath: options.get("--executable") } : {}) });
    try {
      for (const language of ["en", "zh"]) for (const theme of ["dark", "light"]) for (const width of [420, 1280]) for (const palette of ["green", "klein"]) {
        const caseName = JSON.stringify({ engine, language, theme, palette, width });
        console.log(`Browser case: ${caseName}`);
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "no-preference" });
        // Node's clock remains live when page.clock virtualizes browser timers.
        const watchdog = setTimeout(() => {
          console.error(`Browser case exceeded 120 seconds: ${caseName}`);
          void page.close().catch(() => {});
        }, 120000);
        watchdog.unref();
        page.setDefaultTimeout(15000);
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.addInitScript(({ language, theme, palette }) => { localStorage.setItem("ccdx.dashboard.palette", palette); localStorage.setItem("ccdx.dashboard.language", language); localStorage.setItem("ccdx.dashboard.theme", theme); }, { language, theme, palette });
        await page.addInitScript(() => {
          window.atomMotions = [];
          const animate = Element.prototype.animate;
          Element.prototype.animate = function(frames, options) {
            if (this.id === "status-icon") window.atomMotions.push({ frames, options });
            return animate.call(this, frames, options);
          };
        });
        await page.clock.install();
        codexSource = "m365";m365Enabled = true;companyAccount = accountChoices[0];accountChecks = 0;accountChanges = 0;refuseAccountChange = false;
        m365Preference = { model: "gpt-source", auto_review_model: "gpt-source", auto_review_effort: "low" };
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.waitForFunction(() => !document.getElementById("refresh-models").disabled && !document.getElementById("refresh-usage").disabled);
        assert.equal(await page.evaluate(() => atomMotions.length), 1);
        assert.equal(await page.evaluate(() => atomMotions[0].options.duration), 450);
        assert.equal(await page.locator(".sidebar-brand #status-icon").count(), 1);
        assert.equal(await page.locator("h1 #status-icon").count(), 0);
        const brandIcon = await page.locator(".sidebar-brand #status-icon").boundingBox();
        assert.ok(brandIcon && brandIcon.width >= 40 && brandIcon.height >= 40 && brandIcon.x >= 0 && brandIcon.x + brandIcon.width <= width);
        await page.locator("#refresh").click();
        await page.waitForFunction(() => !document.getElementById("refresh").disabled);
        assert.equal(await page.evaluate(() => atomMotions.length), 2);
        assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
        assert.equal(await page.locator("html").getAttribute("lang"), language === "zh" ? "zh-CN" : "en");
        const nav = async route => { await page.locator(`[data-route="${route}"]`).click();await page.locator(`[data-view="${route}"]`).waitFor({ state: "visible" }); };
        assert.match(await page.locator("#runtime-usage").innerText(), /100/);
        assert.equal(await page.locator('[data-view]:visible').count(), 1);
        await nav("codex");
        assert.match(await page.locator("#ttft").innerText(), /1250\.0 ms/);
        assert.match(await page.locator("#tpot").innerText(), /123\.4 token\/s/);
        await page.locator("#additional-capabilities > summary").click();
        await page.locator("#setting-image_enabled").waitFor({ state: "visible" });
        await page.waitForFunction(() => !document.getElementById("setting-image_enabled").disabled);
        const imageBefore = await page.locator("#setting-image_enabled").isChecked();
        await page.locator("#setting-image_enabled").setChecked(!imageBefore);
        await page.waitForFunction(value => !document.getElementById("setting-image_enabled").disabled && document.getElementById("setting-image_enabled").checked === value, !imageBefore);
        await page.locator("#setting-image_enabled").setChecked(imageBefore);
        await page.waitForFunction(() => !document.getElementById("setting-image_enabled").disabled);
        if (output && width === 1280 && language === "zh") { await page.evaluate(() => window.scrollTo(0, 0));await page.screenshot({ path: path.join(output, `${engine}-${palette}-${theme}-codex.png`), fullPage: true }); }
        await nav("claude");
        assert.match(await page.locator("#claude-route").innerText(), /\/anthropic/);
        await nav("codex");
        await page.waitForFunction(() => document.getElementById("source-provider").value === "m365" && document.getElementById("source-model").value === "gpt-source");
        assert.equal(await page.locator("#source-review").inputValue(), "gpt-source");
        for (const selector of ["#source-model", "#source-review", "#source-review-effort", "#apply-source", "#save-review"]) {
          const box = await page.locator(selector).boundingBox();assert.equal(box.height, 36, `${selector} height`);
        }
        const childIndent = await page.locator('[data-route="codex"]').evaluate(node => parseFloat(getComputedStyle(node).paddingLeft));
        assert.ok(childIndent > 12);
        await page.locator("#source-model").selectOption("gpt-second");
        await page.evaluate(() => dashboardRefresh.refresh("auth", { force: true }));
        await page.locator("#refresh").click();
        await page.waitForFunction(() => !document.getElementById("refresh").disabled && !document.getElementById("apply-source").disabled);
        assert.equal(await page.locator("#source-model").inputValue(), "gpt-second", "Settings/auth refresh keeps the unsaved model choice");
        await page.locator("#source-review").selectOption("gpt-second");
        await page.locator("#apply-source").click();
        await page.waitForFunction(() => !document.getElementById("save-review").disabled);
        assert.equal(m365Preference.auto_review_model, "gpt-source", "Saving a conversation model does not save a pending review change");
        assert.equal(await page.locator("#source-review").inputValue(), "gpt-second");
        await page.locator("#save-review").click();
        await page.waitForFunction(() => !document.getElementById("save-review").disabled);
        assert.equal(m365Preference.auto_review_model, "gpt-second");
        await page.locator("#source-provider").selectOption("github");
        await page.route("**/_ccdx/ui/models/live?provider=m365", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "synthetic catalog unavailable" }) }));
        await page.locator("#source-provider").selectOption("m365");
        await page.waitForFunction(() => document.getElementById("review-control-note").textContent.includes("synthetic catalog unavailable"));
        assert.equal(await page.locator("#apply-source").isEnabled(), false);
        await page.locator("#source-provider").selectOption("github");
        assert.equal(await page.locator("#apply-source").isEnabled(), true);
        await page.unroute("**/_ccdx/ui/models/live?provider=m365");
        await page.locator("#apply-source").click();
        await page.waitForFunction(() => document.getElementById("source-control-note").textContent.includes("GitHub Copilot") && !document.getElementById("apply-source").disabled);
        await nav("models");
        await page.locator("#account-authorization > summary").click();
        assert.equal(await page.locator("#provider-auth tr").count(), 3);
        assert.match(await page.locator("#provider-auth").innerText(), /synthetic@example.test/);
        assert.equal(await page.locator("#model-providers [role=tab]").count(), 3);
        assert.equal(accountChecks, 0, "Opening the page never enumerates accounts or acquires tokens");
        await page.locator("#m365-accounts-refresh").click();
        await page.waitForFunction(() => !document.getElementById("m365-account-form").hidden && !document.getElementById("m365-accounts-refresh").disabled);
        assert.equal(accountChecks, 1);assert.equal(accountChanges, 0);
        await page.locator("#m365-account-choice").selectOption(accountChoices[1].id);
        for (const selector of ["#m365-account-choice", "#m365-account-apply"]) assert.equal((await page.locator(selector).boundingBox()).height, 36);
        refuseAccountChange = true;page.once("dialog", dialog => dialog.accept());
        await page.locator("#m365-account-apply").click();
        await page.waitForFunction(() => !document.getElementById("m365-account-apply").disabled);
        assert.equal(companyAccount.id, accountChoices[0].id);assert.equal(accountChanges, 1);
        assert.match(await page.locator("#m365-account-note").innerText(), language === "zh" ? /账号未更换/ : /Account not changed/);
        refuseAccountChange = false;page.once("dialog", dialog => dialog.accept());
        await page.locator("#m365-account-apply").click();
        await page.waitForFunction(() => document.getElementById("m365-account-current").textContent.includes("b@example.test") && !document.getElementById("m365-account-apply").disabled);
        assert.equal(accountChanges, 2);assert.equal(accountChecks, 1);
        if (output && language === "zh" && width === 1280) await page.screenshot({ path: path.join(output, `${engine}-${palette}-${theme}-accounts.png`), fullPage: true });
        await page.locator("#model-provider-m365").click();
        await page.waitForFunction(() => document.getElementById("live-models-body").textContent.includes("claude-opus-5.5"));
        assert.match(await page.locator("#live-models-body").innerText(), /low.*high/);
        await page.locator("#model-provider-third").click();
        await page.waitForFunction(() => document.getElementById("model-check-fields").textContent.includes("m365_disabled"));
        assert.doesNotMatch(await page.locator("#live-models-body").innerText(), /claude-opus/);
        await page.locator("#model-provider-github").click();
        await page.waitForFunction(() => document.getElementById("live-models-body").textContent.includes("gpt-6.1-sol"));
        const icon = decodeURIComponent(await page.locator("#favicon").getAttribute("href"));
        assert.equal((icon.match(/<ellipse /g) || []).length, 3);
        assert.ok(icon.includes(palette === "klein" ? theme === "dark" ? "#789aff" : "#002fa7" : theme === "dark" ? "#a6f5a8" : "#176b3a"));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "No whole-page horizontal overflow");
        await nav("requests");
        assert.equal(await page.locator("#recent-failures").isVisible(), true);
        assert.match(await page.locator("#recent-failures li summary").innerText(), /Microsoft 365/);
        await page.locator("#language-toggle").click();
        assert.match(await page.locator("#recent-failures li summary").innerText(), language === "zh" ? /not retried/ : /未重试/);
        await page.locator("#language-toggle").click();
        assert.equal(await page.locator("#model-usage").isVisible(), false);
        await nav("usage");
        await page.locator("#usage-analytics > summary").click();
        await page.waitForFunction(() => document.querySelectorAll(".calendar-day").length === 365);
        await page.waitForFunction(() => !document.getElementById("refresh-usage").disabled);
        await page.locator("#usage-provider").selectOption("m365");
        await page.waitForFunction(() => !document.getElementById("refresh-usage").disabled && !document.getElementById("usage-body").textContent.includes("gpt-6.1-sol"));
        assert.match(await page.locator("#usage-body").innerText(), /claude-opus-5\.5/);
        await page.locator("#usage-provider").selectOption("");
        await page.waitForFunction(() => !document.getElementById("refresh-usage").disabled && document.getElementById("usage-body").textContent.includes("gpt-6.1-sol"));
        await page.locator("#analytics-range").selectOption("90");
        await page.evaluate(() => { window.savedCalendar = document.querySelector(".calendar-day"); window.savedModelRow = document.querySelector("#live-models-body tr"); });
        await nav("system");
        await page.waitForFunction(() => !document.getElementById("terminal-color-theme").disabled);
        assert.equal(await page.locator("#web-color-theme").inputValue(), palette);
        await page.locator("#terminal-color-theme").selectOption("klein");
        await page.waitForFunction(() => !document.getElementById("terminal-color-theme").disabled);
        assert.equal(await page.locator("html").getAttribute("data-palette"), palette);
        assert.equal(await page.locator("#terminal-color-sample").getAttribute("data-terminal-palette"), "klein");
        await page.locator("#web-color-theme").selectOption(palette === "green" ? "klein" : "green");
        assert.equal(await page.locator("#terminal-color-theme").inputValue(), "klein");
        await page.locator("#web-color-theme").selectOption(palette);
        await page.route("**/_ccdx/ui/settings", async route => {
          if (route.request().method() === "POST") return route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({error:"synthetic save refused"})});
          return route.continue();
        });
        await page.locator("#terminal-color-theme").selectOption("green");
        await page.waitForFunction(() => document.getElementById("terminal-color-note").textContent.includes("synthetic save refused"));
        assert.equal(await page.locator("#terminal-color-theme").inputValue(), "klein");
        await page.unroute("**/_ccdx/ui/settings");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.locator("#animation-settings > summary").click();
        await page.waitForFunction(() => document.querySelectorAll(".theme-option").length === 2);
        await page.locator(".theme-option").nth(1).click();
        await page.locator("#refresh").click();
        await page.waitForFunction(() => !document.getElementById("refresh").disabled);
        assert.equal(await page.locator(".theme-option").nth(1).getAttribute("aria-pressed"), "true");
        assert.equal(await page.locator("#save-animation").isEnabled(), true);
        await page.waitForFunction(() => !document.getElementById("setting-open_webui").disabled);
        const openBefore = await page.locator("#setting-open_webui").isChecked();
        await page.locator("#setting-open_webui").setChecked(!openBefore);
        await page.waitForFunction(() => !document.getElementById("setting-open_webui").disabled);
        assert.match(await page.locator("#effect-open_webui").innerText(), language === "zh" ? /重启 CCDX 后生效/ : /Next CCDX start/);
        await page.locator("#setting-open_webui").setChecked(openBefore);
        await page.waitForFunction(() => !document.getElementById("setting-open_webui").disabled);
        assert.equal(await page.evaluate(() => window.savedCalendar === document.querySelector(".calendar-day") && window.savedModelRow === document.querySelector("#live-models-body tr")), true);
        assert.equal(await page.locator("#analytics-range").inputValue(), "90");
        if (output && language === "zh") { await page.evaluate(() => window.scrollTo(0, 0));await page.screenshot({ path: path.join(output, `${engine}-${palette}-${theme}-${width}-settings.png`), fullPage: true }); }
        const before = models;
        await page.clock.fastForward(1800000);
        assert.equal(models, before, "A hidden catalog is not polled");
        const motionCount = await page.evaluate(() => atomMotions.length);
        await page.locator("#auto-refresh").click();
        await page.clock.fastForward(1800000);
        assert.equal(models, before);
        assert.equal(await page.evaluate(() => atomMotions.length), motionCount);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.locator("#refresh").click();
        await page.waitForFunction(() => !document.getElementById("refresh").disabled);
        assert.equal(await page.evaluate(() => atomMotions.length), motionCount, "Reduced motion suppresses new atom rotations");
        await nav("overview");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(errors.length, 0, errors.join("\n"));
        if (output && language === "zh") await page.screenshot({ path: path.join(output, `${engine}-${palette}-${theme}-${width}-overview.png`), fullPage: true });
        results.push({ engine, language, theme, palette, width, passed: true });
        clearTimeout(watchdog);
        await page.close();
      }
    } finally { await browser.close(); }
  }
  console.log(JSON.stringify({ cases: results, model_lookups: models, usage_reads: summaries, real_provider_calls: 0 }));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve));await fs.rm(home, { recursive: true, force: true }); }
