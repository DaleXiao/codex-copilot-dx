// Real browser engines against an isolated local, synthetic dashboard.
// Playwright is supplied by the test environment, not a CCDX runtime dependency.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
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
const records = Array.from({ length: 10 }, (_, index) => ({ ts: new Date(Date.now() - index * 86400000).toISOString(),
  provider: index % 2 ? "m365" : "github", model: index % 2 ? "claude-opus-5.5" : "gpt-6.1-sol",
  usage: { input_tokens: 100 * (index + 1), cached_input_tokens: 50, output_tokens: 20, total_tokens: 120 + 100 * index } }));
const providerState = () => [
  { id: "github", name: "GitHub Copilot", enabled: true, state: "ready", clients: [{ id: "codex", name: "Codex App", selected: true, state: "configured" }] },
  { id: "m365", name: "Microsoft 365", enabled: true, state: "ready", auth: { state: "authorized", account: "synthetic@example.test" },
    clients: [{ id: "claude_app", name: "Claude App", state: "configured", gateway: "running" }], requests: { completed: 3, incomplete: 1, failed: 2 } },
  { id: "third", name: "Third source", enabled: false, state: "disabled", clients: [] },
];
const handler = createAdapterHandler({ dashboardOptions: {
  providerStateFn: providerState,
  providerCatalogFn: async ({ provider }) => {
    if (provider === "github") return null;
    if (provider === "third") throw Object.assign(Error("Unavailable"), { code: "m365_disabled", statusCode: 503 });
    return { source: "catalog", checkedAt: new Date().toISOString(), advertised: 1, upstreamHost: "Microsoft 365", models: [
      { id: "claude-opus-5.5", vendor: "Anthropic", endpoints: ["messages"], clients: ["claude_app", "claude_code"], reasoning_efforts: ["low", "high"], selectable: true },
    ] };
  },
  liveModelsFn: async () => { models++; return { models: [{ id: "gpt-6.1-sol", vendor: "OpenAI", endpoints: ["responses"], preview: false }], advertised: 1, upstreamHost: "synthetic.local" }; },
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
      http_errors: { by_category: { inference: 1, protocol: 2, route: 3, other: 0 } },
      providers: { codex_provider: "github", m365: { state: "ready", account: { login: "synthetic@example.test" }, models: { claude: 10, gpt: 5 },
        claude: { gateway: "running", requests: { completed: 3, incomplete: 1, failed: 2 }, clients: { code: "configured", app: "configured" } } } },
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
      for (const language of ["en", "zh"]) for (const theme of ["dark", "light"]) for (const width of [420, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "no-preference" });
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.addInitScript(({ language, theme }) => { localStorage.setItem("ccdx.dashboard.language", language); localStorage.setItem("ccdx.dashboard.theme", theme); }, { language, theme });
        await page.addInitScript(() => {
          window.atomMotions = [];
          const animate = Element.prototype.animate;
          Element.prototype.animate = function(frames, options) {
            if (this.id === "status-icon") window.atomMotions.push({ frames, options });
            return animate.call(this, frames, options);
          };
        });
        await page.clock.install();
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.waitForFunction(() => !document.getElementById("refresh-models").disabled && !document.getElementById("refresh-usage").disabled);
        assert.equal(await page.evaluate(() => atomMotions.length), 1);
        assert.equal(await page.evaluate(() => atomMotions[0].options.duration), 450);
        assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
        assert.equal(await page.locator("html").getAttribute("lang"), language === "zh" ? "zh-CN" : "en");
        assert.match(await page.locator("#ttft").innerText(), /1250\.0 ms/);
        assert.match(await page.locator("#tpot").innerText(), /123\.4 token\/s/);
        await page.locator("#account-authorization > summary").click();
        assert.equal(await page.locator("#provider-auth tr").count(), 3);
        assert.match(await page.locator("#provider-auth").innerText(), /synthetic@example.test/);
        assert.match(await page.locator("#provider-requests").innerText(), language === "zh" ? /完成3.*未完成1.*失败2/ : /3 done.*1 incomplete.*2 failed/);
        assert.equal(await page.locator("#model-providers [role=tab]").count(), 3);
        await page.locator("#model-provider-m365").click();
        await page.waitForFunction(() => document.getElementById("live-models-body").textContent.includes("claude-opus-5.5"));
        assert.match(await page.locator("#live-models-body").innerText(), /low.*high/);
        await page.locator("#model-provider-third").click();
        await page.waitForFunction(() => document.getElementById("models-note").textContent.includes("m365_disabled"));
        assert.doesNotMatch(await page.locator("#live-models-body").innerText(), /claude-opus/);
        await page.locator("#model-provider-github").click();
        await page.waitForFunction(() => document.getElementById("live-models-body").textContent.includes("gpt-6.1-sol"));
        assert.match(await page.locator("#source-detail").innerText(), /Codex App.*GitHub Copilot/);
        assert.doesNotMatch(await page.locator("#http-error-breakdown").innerText(), /undefined|NaN/);
        const icon = decodeURIComponent(await page.locator("#favicon").getAttribute("href"));
        assert.equal((icon.match(/<ellipse /g) || []).length, 3);
        assert.ok(icon.includes(theme === "dark" ? "#a6f5a8" : "#176b3a"));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "No whole-page horizontal overflow");
        await page.locator("#usage-analytics > summary").click();
        await page.waitForFunction(() => document.querySelectorAll(".calendar-day").length === 365);
        await page.waitForFunction(() => !document.getElementById("refresh-usage").disabled);
        assert.equal(await page.evaluate(() => dashboardRefresh.state("usage").error?.message || null), null, "Analytics read/apply must succeed");
        await page.locator("#usage-provider").selectOption("m365");
        await page.waitForFunction(() => !document.getElementById("refresh-usage").disabled && !document.getElementById("usage-body").textContent.includes("gpt-6.1-sol"));
        assert.match(await page.locator("#usage-body").innerText(), /claude-opus-5\.5/);
        await page.locator("#usage-provider").selectOption("");
        await page.waitForFunction(() => !document.getElementById("refresh-usage").disabled && document.getElementById("usage-body").textContent.includes("gpt-6.1-sol"));
        await page.locator("#animation-settings > summary").click();
        await page.locator(".theme-option").nth(1).click();
        await page.locator("#analytics-range").selectOption("90");
        await page.evaluate(() => { window.savedCalendar = document.querySelector(".calendar-day"); window.savedModelRow = document.querySelector("#live-models-body tr"); });
        await page.locator("#refresh").click();
        await page.waitForFunction(() => !document.getElementById("refresh-models").disabled && !document.getElementById("refresh-usage").disabled);
        assert.equal(await page.evaluate(() => atomMotions.length), 2);
        assert.equal(await page.evaluate(() => window.savedCalendar === document.querySelector(".calendar-day") && window.savedModelRow === document.querySelector("#live-models-body tr")), true);
        assert.equal(await page.locator("#analytics-range").inputValue(), "90");
        assert.equal(await page.locator(".theme-option").nth(1).getAttribute("aria-pressed"), "true");
        assert.equal(await page.locator("#save-animation").isEnabled(), true);
        const before = models;
        await page.clock.fastForward(1800000);
        await page.waitForFunction(() => !document.getElementById("refresh-models").disabled);
        assert.equal(models, before + 1);
        assert.equal(await page.evaluate(() => atomMotions.length), 2, "Background polling must not animate the atom");
        await page.waitForFunction(() => !document.getElementById("refresh-usage").disabled);
        for (const key of ["status", "auth", "models", "usage", "animation"]) assert.equal(await page.evaluate(key => dashboardRefresh.state(key).error?.message || null, key), null, `${key}: refresh must succeed`);
        await page.locator("#auto-refresh").click();
        await page.clock.fastForward(1800000);
        assert.equal(models, before + 1);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.locator("#refresh").click();
        await page.waitForFunction(() => !document.getElementById("refresh").disabled);
        assert.equal(await page.evaluate(() => atomMotions.length), 2, "Reduced motion suppresses new atom rotations");
        assert.equal(errors.length, 0, errors.join("\n"));
        if (output && ((width === 1280 && language === "en" && theme === "dark") || (width === 420 && language === "zh" && theme === "light"))) await page.screenshot({ path: path.join(output, `${engine}-${language}-${theme}-${width}.png`), fullPage: true });
        results.push({ engine, language, theme, width, passed: true });
        await page.close();
      }
    } finally { await browser.close(); }
  }
  console.log(JSON.stringify({ cases: results, model_lookups: models, usage_reads: summaries, real_provider_calls: 0 }));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
