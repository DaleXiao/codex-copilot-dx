// Real browser engines against an isolated local, synthetic dashboard.
// Playwright is supplied by the test environment, not a CCDX runtime dependency.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createServiceControl } from "../src/service-control.mjs";
import { createAdapterHandler } from "../src/adapter.mjs";
import { summarizeUsage } from "../src/usage-store.mjs";
import { statusSummary } from "../src/status-summary.mjs";
import { requestApplication } from "../src/request-application.mjs";

const args = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < args.length; index += 2) options.set(args[index], args[index + 1]);
assert.ok(path.isAbsolute(options.get("--playwright") || ""), "Supply --playwright /absolute/path/to/playwright/index.js");
const module = await import(pathToFileURL(options.get("--playwright")).href);
const playwright = module.default || module;
const output = options.get("--output");
if (output) await fs.mkdir(output, { recursive: true });
process.env.CCDX_DISABLE_USAGE = "1";
globalThis.fetch = async () => { throw Error("Real provider calls are forbidden"); };
let models = 0, summaries = 0;
let updateReads = 0, updateState = "checked", latestVersion = "1.2.4";
const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-dashboard-replay-"));
let predictionActive = true, codexSource = "github", m365Enabled = true;
const accountChoices = ["a", "b"].map(letter => ({ id: letter.repeat(64), login: `${letter}@example.test`, tenant: `company-${letter}` }));
let companyAccount = accountChoices[0], accountChecks = 0, accountChanges = 0, refuseAccountChange = false;
let proxyFailure = false;
let modelActivity = 2;
let extraRequests = [];
let flowRequests = [];
let contextReads = 0;
const contextFixture = () => ({ source: "run_context", sessions: [{ id: "0-session-1", application: "codex_app", provider: "github", model: "gpt-test", concurrent: false,
  points: [100, 200, 120].map((input, index) => ({ at: `2026-10-29T11:00:0${index}Z`, order: index * 10, finished: index * 10 + 1,
    input_tokens: input, context_window_tokens: 1000, cached_input_tokens: 60, request_id: `context-${index}`, outcome: "completed" })),
  compactions: [{ at: "2026-10-29T11:00:02Z", order: 20, elapsed_ms: 2400, outcome: "completed" }] }],
  unassigned: [{ id: "0-request-2", application: "claude_app", provider: "m365", model: "external-test", input_tokens: 50, context_window_tokens: null, cached_input_tokens: null, at: "2026-10-29T10:00:00Z" }] });
const concurrentFlow = () => [
  { request_id: "flow-codex", application: requestApplication({ originator: "Codex Desktop" }), provider: "github", model: "gpt-test", first_output_ms: 100, upstream_attempts: 1, elapsed_ms: 1200 },
  { request_id: "flow-code", application: "claude_code", provider: "m365", model: "claude-test", first_output_ms: 200, upstream_attempts: 1, elapsed_ms: 1000 },
  { request_id: "flow-app", application: "claude_app", provider: "m365", model: "claude-other", first_output_ms: null, upstream_attempts: 2, elapsed_ms: 900 },
];
let signin = null, rejectIdentity = true;
const accountTools = {
  snapshot: () => structuredClone(signin), dispose() {},
  async check() { signin.online = { checked: true, ok: false, reason: rejectIdentity ? "github_token_invalid" : "copilot_access_denied", http_status: rejectIdentity ? 401 : 403,
    stages: { identity: rejectIdentity ? "invalid" : "passed", access: rejectIdentity ? "not_checked" : "unavailable", models: "not_checked" } };signin.checked_at = new Date().toISOString();return this.snapshot(); },
  async start() { signin.operation = { id: "synthetic-operation", state: "authorizing", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_at: new Date(Date.now() + 900000).toISOString() };return this.snapshot(); },
  async cancel() { signin.operation = { id: "synthetic-operation", state: "cancelled", reason: "auth_cancelled" };return this.snapshot(); },
  async logout() { signin.saved = false;signin.online = null;return this.snapshot(); },
};
const localTools = {
  snapshot: () => ({ source: "local_tools" }),
  async check() { return { source: "local_tools", checked_at: new Date().toISOString(), checks: [{ id: "codex-config", kind: "warn", message: "openai_base_url differs from CCDX" }] }; },
  preview: () => ({ revision: "synthetic-revision", managed_keys: ["openai_base_url"], backup: "config.toml.ccdx-doctor.bak", checks: [{ message: "Update CCDX-managed address" }] }),
  repair: () => ({ status: "verified", changed: true, local: { checked_at: new Date().toISOString(), checks: [{ id: "codex-config", kind: "ok", message: "Codex configuration checked" }] } }),
  network: () => ({ summary: "Proxy rules retained. TLS verification required." }),
  report: () => ({ source: "local_tools", checks: [], account: "[hidden]" }),
};
const networkDiagnostic = { source: "system", stage: "proxy_config", cause_code: "proxy_bypass_invalid" };
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
  { id: "github", name: "GitHub Copilot", selection: { codex: true, models_required: false }, enabled: true, state: "ready", clients: [{ id: "codex", name: "Codex App", selected: codexSource === "github", state: "configured" }] },
  { id: "m365", name: "Microsoft 365", selection: { codex: true, models_required: true }, enabled: true,
    state: proxyFailure ? "unavailable" : "ready", ...(proxyFailure ? { reason: "m365_proxy_settings_unsupported", network_diagnostic: networkDiagnostic } : {}), auth: { state: "authorized", account: "synthetic@example.test" },
    clients: [{ id: "codex", name: "Codex App", selected: codexSource === "m365", state: "ready" },
      { id: "claude_app", name: "Claude App", state: "configured", gateway: "running" },
      { id: "claude_code", name: "Claude Code", state: "preserved", gateway: "running" }], requests: { completed: 3, incomplete: 1, failed: 2 } },
  { id: "third", name: "Third source", enabled: false, state: "disabled", clients: [] },
];
const handler = createAdapterHandler({ dashboardOptions: { home, env: {}, serviceControl, accountTools, localTools,
  updateStatusFn: async () => { updateReads++;return { source: "release_status", status: updateState,
    current: { version: "1.2.3", published_at: "2026-10-19T02:36:27Z" }, latest: { version: latestVersion, published_at: "2026-10-19T10:00:00Z" },
    update_available: updateState === "checked" && latestVersion !== "1.2.3", checked_at: "2026-10-19T10:00:00Z" }; },
  providerStateFn: providerState,
  providerAccountsFn: async () => { accountChecks++;return { accounts: accountChoices.map(value => ({ ...value, selected: value.id === companyAccount.id })) }; },
  providerCatalogFn: async ({ provider }) => {
    if (provider === "github") return null;
    if (provider === "third") throw Object.assign(Error("Unavailable"), { code: "m365_disabled", statusCode: 503 });
    if (proxyFailure) throw Object.assign(Error("Bearer NEVER_EXPOSE"), { code: "m365_proxy_settings_unsupported", statusCode: 502, network_diagnostic: { ...networkDiagnostic, raw: "NEVER_EXPOSE" } });
    return { source: "catalog", checkedAt: new Date().toISOString(), advertised: 3, upstreamHost: "Microsoft 365",
      catalogRead: { source: "network", checked_at: new Date().toISOString(), total: 3, claude: 1, gpt: 2, filtered: 0, http_status: 200,
        http_revalidation_requested: true, request_id: "synthetic-catalog-request" }, models: [
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
  if (req.url === "/_ccdx/ui/context") { contextReads++;res.writeHead(200, { "content-type": "application/json" });res.end(JSON.stringify(contextFixture()));return; }
  if (req.url.startsWith("/_ccdx/ui/animation")) {
    res.writeHead(200, { "content-type": "application/json" });
    const frames = !req.url.includes("frames=0");
    res.end(JSON.stringify({ theme: serviceControl.snapshot().theme, source: "settings", disabled_by_environment: false,
      themes: ["comet", "twin"].map(id => ({ id, label: id === "comet" ? "Comet" : "Twin", default: id === "comet",
        ...(frames ? { frames: [{ ansi: "[●··]", delay_ms: 100 }], loop_pause_ms: 100 } : {}) })) }));
    return;
  }
  if (req.url.split("?")[0] === "/_ccdx/status") {
    res.writeHead(200, { "content-type": "application/json" });
    const snapshot = { ok: true, name: "codex-copilot-dx", version: "synthetic", pid: 1, uptime_ms: 1000,
      requests: { total: 1, active: 0 }, model_activity: { active: modelActivity }, models: { models: 1, source: "synthetic" },
      stream_performance: { active_requests: flowRequests, active_total: flowRequests.length, recent_requests: [...extraRequests, { at: "2026-10-21T05:51:08Z", request_id: "synthetic-recent", provider: "github", model: "gpt-test", outcome: "completed",
        context: { payload_bytes: 1048576, images: 0, input_tokens: 150, context_window_tokens: 1000 } },
        { request_id: "synthetic-unknown", model: "<script>not-html</script>", outcome: "completed", context: {} }], by_route: { responses: {
        ttft_ms: { avg: 1250, samples: 3, p50: 1400, p95: 2000, percentiles_estimated: true }, output_tokens_per_second: { avg: 123.4, samples: 2, unit: "token/s" },
      } } },
      response_failures: { recent:[{provider:"m365",code:"synthetic_error",model:"gpt-test",retried:false}] },
      http_errors: { by_category: { inference: 1, capability: 2, protocol: 2, route: 3, other: 0 },
        capability_recent: ["upstream_http", "capability_cache"].map((origin, i) => ({ at: `2026-10-26T01:29:0${i}Z`, request_id: `count-${i}`, route: "messages_count_tokens", provider: "github", model: "count-replay", code: "ccdx_api_count_tokens_unavailable", http_status: 404, origin, upstream_attempts: i ? 0 : 1 })),
        route_recent: [{ at: "2026-10-26T01:29:00Z", request_id: "path-replay", route: "not_found", code: "http_404", http_status: 404, target: "/.well-known/oauth-authorization-server" }] },
      providers: { codex_provider: "github", m365: { state: "ready", account: { login: "synthetic@example.test" }, models: { claude: 10, gpt: 5 },
        claude: { base_url: `http://127.0.0.1:${server.address().port}/anthropic`, gateway: "running", requests: { completed: 3, incomplete: 1, failed: 2 }, clients: { code: "configured", app: "configured" } } } },
      runtime_usage: { records: 4, input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, cache_hit_rate: 0.2, cache_hit_rate_partial: false },
      process: { rss_bytes: 123456, heap_used_bytes: 34567 },
      response_history: { bytes: 0, maxBytes: 67108864 }, client_integrations: { prediction: { configured: false, bridge: "stopped" } } };
    res.end(JSON.stringify(req.url.includes("scope=summary") ? statusSummary(snapshot) : snapshot));
    return;
  }
  handler(req, res);
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const results = [];
try {
  for (const engine of (options.get("--engines") || "chromium,webkit").split(",")) {
    const browser = await playwright[engine].launch({ headless: true, ...(options.get("--channel") ? { channel: options.get("--channel") } : {}), ...(options.get("--executable") ? { executablePath: options.get("--executable") } : {}) });
    try {
      for (const language of (options.get("--languages") || "en,zh").split(","))
        for (const theme of (options.get("--themes") || "dark,light").split(","))
          for (const width of (options.get("--widths") || "420,1280").split(",").map(Number))
            for (const palette of (options.get("--palettes") || "green,klein,pink,mono").split(",")) {
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
        page.on("pageerror", error => { errors.push(error.message);console.error("Page error:", error.message); });
        page.on("response", response => { if (/\.(?:js|css)$/.test(new URL(response.url()).pathname) && response.status() >= 400) errors.push(`Asset ${response.status()}: ${response.url()}`); });
        signin = { source: "account_tools", configured: true, saved: true, login: "synthetic_user", store: "legacy", online: null, checked_at: null, operation: null };
        await page.addInitScript(({ language, theme, palette }) => { localStorage.setItem("ccdx.dashboard.palette", palette); localStorage.setItem("ccdx.dashboard.language", language); localStorage.setItem("ccdx.dashboard.theme", theme); }, { language, theme, palette });
        await page.addInitScript(() => {
          window.clipboardWrites = [];window.clipboardBlocked = false;window.clipboardStartedCode = null;
          window.ClipboardItem = class { constructor(data) { this.data = data; } };
          Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            async write(items) { window.clipboardStartedCode = document.getElementById("github-user-code")?.textContent;
              if (window.clipboardBlocked) throw Error("Synthetic clipboard denial");
              window.clipboardWrites.push(await (await items[0].data["text/plain"]).text()); },
            async writeText(text) { if (window.clipboardBlocked) throw Error("Synthetic clipboard denial");window.clipboardWrites.push(text); },
          } });
          window.atomMotions = [];window.chartMotions = [];
          const animate = Element.prototype.animate;
          Element.prototype.animate = function(frames, options) {
            if (this.id === "status-icon") window.atomMotions.push({ frames, options });
            if (this.matches(".bar-stack, .daily-curve")) window.chartMotions.push({ frames, options });
            return animate.call(this, frames, options);
          };
        });
        await page.clock.install();
        codexSource = "m365";m365Enabled = true;companyAccount = accountChoices[0];accountChecks = 0;accountChanges = 0;refuseAccountChange = false;
        proxyFailure = false;
        modelActivity = 2;
        extraRequests = [];
        flowRequests = [];
        updateReads = 0;updateState = "checked";latestVersion = "1.2.4";
        m365Preference = { model: "gpt-source", auto_review_model: "gpt-source", auto_review_effort: "low" };
        await serviceControl.action({ action: "preferences", revision: serviceControl.snapshot().preferences.revision, values: { terminal_animation: "comet", terminal_color_theme: "green", open_webui: true, nightly_updates: false, auto_save_settings: true } });
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.locator("#page-title").waitFor();
        const fonts = await page.locator("#page-title").evaluate(node => getComputedStyle(node).fontFamily);
        assert.match(fonts, /Microsoft YaHei UI/);assert.match(fonts, /PingFang SC/);
        if (engine === "chromium" && process.platform === "win32" && language === "zh") {
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("DOM.enable");await cdp.send("CSS.enable");
          const { root } = await cdp.send("DOM.getDocument");
          const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#page-title" });
          const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
          assert.ok(fonts.some(font => /Microsoft YaHei/i.test(font.familyName) && font.glyphCount > 0), `Chinese uses a Windows sans-serif face: ${JSON.stringify(fonts)}`);
          await cdp.detach();
        }
        if (palette === "mono") {
          const colors = await page.locator("body").evaluate(node => {
            const css = getComputedStyle(node);return { page: css.backgroundColor, text: css.color, accent: css.getPropertyValue("--accent").trim() };
          });
          assert.equal(colors.page, theme === "light" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)");
          assert.equal(colors.text, theme === "light" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)");
        }
        await page.waitForFunction(() => !document.getElementById("refresh-models").disabled && !document.getElementById("refresh-usage").disabled);
        assert.equal(await page.evaluate(() => atomMotions.length), 1);
        assert.equal(await page.evaluate(() => atomMotions[0].options.duration), 450);
        assert.equal(await page.locator(".sidebar-brand #status-icon").count(), 1);
        assert.equal(await page.locator("h1 #status-icon").count(), 0);
        assert.equal(await page.locator(".sidebar nav a .nav-icon").count(), 8);
        assert.equal(await page.locator("#open-animation").count(), 0);
        assert.match(await page.locator("#source-summary").innerText(), /3/);
        assert.equal(await page.locator("#source-detail span").count(), 3);
        assert.match(await page.locator("#source-detail").innerText(), /GitHub Copilot.*Microsoft 365.*Third source/s);
        assert.doesNotMatch(await page.locator("#source-detail").innerText(), /→|Codex|Claude/);
        assert.equal(await page.locator("#provider-clients tr").count(), 3, "Each app has one row rather than one per source");
        assert.match(await page.locator("#provider-clients tr").first().innerText(), /Codex App.*Microsoft 365/s);
        const brandIcon = await page.locator(".sidebar-brand #status-icon").boundingBox();
        assert.ok(brandIcon && brandIcon.width >= 40 && brandIcon.height >= 40 && brandIcon.x >= 0 && brandIcon.x + brandIcon.width <= width);
        await page.locator("#refresh").click();
        await page.waitForFunction(() => !document.getElementById("refresh").disabled);
        assert.equal(await page.evaluate(() => atomMotions.length), 2);
        await page.locator(".sidebar-brand #status-icon").click();
        assert.equal(await page.evaluate(() => atomMotions.length), 3, "Clicking the logo plays one rotation");
        assert.equal(await page.evaluate(() => location.hash), "#overview", "Logo navigation stays intact");
        await page.locator(".sidebar-brand").focus();
        await page.keyboard.press("Enter");
        assert.equal(await page.evaluate(() => atomMotions.length), 4, "Keyboard activation also plays the logo motion");
        await page.evaluate(() => { for (let index = 0; index < 10; index++) document.querySelector(".sidebar-brand").click(); });
        assert.equal(await page.locator("#status-icon").evaluate(node => node.getAnimations().length), 1, "Rapid clicks replace the current rotation");
        assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
        assert.equal(await page.locator("html").getAttribute("lang"), language === "zh" ? "zh-CN" : "en");
        const nav = async route => { await page.locator(`[data-route="${route}"]`).click();await page.locator(`[data-view="${route}"]`).waitFor({ state: "visible" }); };
        // A force refresh intentionally joins an in-flight poll. Drain its previous
        // fixture response before requesting the newly installed synthetic state.
        const refreshStatus = () => page.evaluate(async () => {
          const key = statusResourceKey();await dashboardRefresh.state(key).pending;
          return dashboardRefresh.refresh(key, { force: true });
        });
        // Long/short modules, status labels and scrolling must not resize the shared shell.
        const layout = await page.locator(".topbar").boundingBox();
        const titleTop = (await page.locator(".intro").boundingBox()).y;
        const languageStyle = await page.locator("#language-toggle").evaluate(node => ({ whiteSpace: getComputedStyle(node).whiteSpace, shrink: getComputedStyle(node).flexShrink, width: node.getBoundingClientRect().width,
          lines: (() => { const range = document.createRange();range.selectNodeContents(node);return range.getClientRects().length; })() }));
        assert.equal(languageStyle.whiteSpace, "nowrap");assert.equal(languageStyle.shrink, "0");assert.ok(languageStyle.width >= 40);assert.equal(languageStyle.lines, 1, "中文 / EN stays on one line");
        const automaticWidth = (await page.locator("#auto-refresh").boundingBox()).width;
        assert.ok(automaticWidth <= (language === "zh" ? 125 : 160), "Auto refresh uses localized content width");
        await page.locator("#auto-refresh").click();
        assert.equal((await page.locator("#auto-refresh").boundingBox()).width, automaticWidth, "On/off does not change button width");
        await page.locator("#auto-refresh").click();
        for (const route of ["codex", "claude", "usage", "requests", "checks", "overview"]) {
          await nav(route);
          const header = await page.locator(".topbar").boundingBox();
          assert.equal(header.height, layout.height, `Header height is stable in ${route}`);
          assert.equal(header.x, layout.x, `Header x is stable in ${route}`);
          assert.equal((await page.locator(".intro").boundingBox()).y, titleTop, `Title y is stable in ${route}`);
          assert.equal(await page.evaluate(() => scrollY), 0, `Navigation returns ${route} to the top`);
        }
        await page.evaluate(() => window.scrollTo(0, 200));
        const beforeRefreshScroll = await page.evaluate(() => scrollY);
        await refreshStatus();
        assert.equal(await page.evaluate(() => scrollY), beforeRefreshScroll, "Status refresh preserves scroll");
        assert.equal((await page.locator(".topbar").boundingBox()).y, Math.max(0, layout.y - beforeRefreshScroll), "Header sticks after reaching the viewport top");
        await nav("overview");
        await page.waitForFunction(() => document.getElementById("model-activity").dataset.state === "active").catch(async error => {
          console.error("Activity diagnostics", { errors, state: await page.locator("#model-activity").getAttribute("data-state"), api: await page.evaluate(() => typeof globalThis.ccdxDashboardActivity), snapshot: await page.evaluate(async () => (await (await fetch("/_ccdx/status")).json()).model_activity) });
          throw error;
        });
        assert.equal(await page.locator("#model-activity .activity-dots i").count(), 5);
        assert.equal(await page.locator(".activity-lamp").evaluate(node => getComputedStyle(node).width), "4px");
        assert.equal(await page.locator(".activity-lamp").evaluate(node => getComputedStyle(node, "::before").content), "none");
        const overviewTop = (await page.locator('[data-view="overview"] .overview').boundingBox()).y;
        if (output && language === "zh" && width === 1280 && palette === "pink") await page.screenshot({ path: path.join(output, `${engine}-pink-${theme}-overview-active.png`), fullPage: true });
        modelActivity = 0;await page.locator("#refresh").click();
        await page.waitForFunction(() => document.getElementById("model-activity").dataset.state === "idle");
        assert.equal((await page.locator('[data-view="overview"] .overview').boundingBox()).y, overviewTop);
        assert.equal(await page.locator(".activity-lamp").evaluate(node => getComputedStyle(node, "::before").animationName), "activity-breathe");
        await page.route("**/_ccdx/status*", route => route.fulfill({ status: 503, contentType: "application/json", body: '{}' }));
        await page.locator("#refresh").click();
        await page.waitForFunction(() => document.getElementById("model-activity").dataset.state === "unknown");
        assert.equal(await page.locator(".activity-lamp").evaluate(node => getComputedStyle(node, "::before").content), "none");
        await page.unroute("**/_ccdx/status*");await page.locator("#refresh").click();
        await page.waitForFunction(() => document.getElementById("model-activity").dataset.state === "idle");
        assert.match(await page.locator("#runtime-usage").innerText(), /100/);
        assert.equal(await page.locator("#runtime-cache-hit").innerText(), "20.0%");
        assert.equal(await page.locator('[data-view]:visible').count(), 1);
        await nav("codex");
        await page.locator("#codex-performance > summary").click();
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
        assert.match(await page.locator("#claude-route").textContent(), /\/anthropic/);
        assert.equal(await page.locator("#claude-clients tr").count(), 2);
        await nav("models");await page.locator("#model-provider-m365").click();
        await page.locator("#m365-source-access").waitFor({ state: "visible" });
        assert.equal(codexSource, "m365", "Opening source management does not switch routing");
        await nav("codex");
        await page.waitForFunction(() => document.getElementById("source-provider").value === "m365" && document.getElementById("source-model").value === "gpt-source");
        assert.equal(await page.locator("#source-review").inputValue(), "gpt-source");
        assert.equal(await page.locator("#legacy-source-controls").isHidden(), true, "Source selection moved to application model bindings");
        for (const selector of ["#source-review", "#source-review-effort", "#save-review"]) assert.equal((await page.locator(selector).boundingBox()).height, 36);
        const childIndent = await page.locator('[data-route="codex"]').evaluate(node => parseFloat(getComputedStyle(node).paddingLeft));assert.ok(childIndent > 12);
        await page.locator("#source-review").selectOption("gpt-second");
        await page.evaluate(() => dashboardRefresh.refresh("auth", { force: true }));await page.locator("#refresh").click();
        await page.waitForFunction(() => !document.getElementById("refresh").disabled && !document.getElementById("save-review").disabled);
        assert.equal(await page.locator("#source-review").inputValue(), "gpt-second", "Refresh keeps the unsaved review choice");
        await page.locator("#save-review").click();await page.waitForFunction(() => !document.getElementById("save-review").disabled);
        assert.equal(m365Preference.auto_review_model, "gpt-second");
        await page.route("**/_ccdx/ui/settings", route => route.request().method() === "POST" && route.request().postDataJSON()?.key === "prediction_enabled"
          ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "synthetic prediction save refused" }) }) : route.continue());
        const predictionBefore = await page.locator("#setting-prediction_enabled").isChecked();
        await page.locator("#setting-prediction_enabled").click();
        await page.waitForFunction(() => document.getElementById("effect-prediction_enabled").textContent.includes("synthetic prediction save refused"));
        assert.equal(await page.locator("#setting-prediction_enabled").isChecked(), predictionBefore, "A failed save restores the confirmed switch");
        for (const id of ["source-control-note", "m365-control-note", "review-control-note", "effect-history", "settings-note"]) {
          assert.doesNotMatch(await page.locator(`#${id}`).textContent(), /synthetic prediction save refused/, "Save errors stay beside the affected control");
        }
        await page.unroute("**/_ccdx/ui/settings");
        await nav("models");
        await page.locator("#model-provider-github").click();
        await page.waitForFunction(() => document.getElementById("github-account-name").textContent === "synthetic_user");
        assert.equal(await page.locator("#m365-source-access").isVisible(), false);
        assert.equal(await page.locator("#github-signin").isVisible(), false, "Saved sign-in alone does not recommend reauth");
        rejectIdentity = false;await page.locator("#github-check").click();
        await page.waitForFunction(() => document.getElementById("github-check-code").textContent === "copilot_access_denied");
        assert.equal(await page.locator("#github-signin").isVisible(), false, "Copilot denial does not recommend reauth");
        rejectIdentity = true;
        await page.locator("#github-check").click();
        await page.waitForFunction(() => document.getElementById("github-check-code").textContent === "github_token_invalid");
        assert.equal(await page.locator("#github-account-state .state-warning .state-icon").count(), 1);
        assert.equal(await page.locator("#connection .state-connected .state-icon").count(), 1);
        assert.equal(await page.locator("#connection .state-icon circle").count(), 0, "Connection uses a link without an outer circle");
        await page.locator("#github-signin").click();
        await page.waitForFunction(() => !document.getElementById("github-login-flow").hidden);
        assert.equal(await page.locator("#github-user-code").innerText(), "ABCD-EFGH");
        await page.waitForFunction(() => window.clipboardWrites.length === 1);
        assert.deepEqual(await page.evaluate(() => window.clipboardWrites), ["ABCD-EFGH"]);
        assert.equal(await page.evaluate(() => window.clipboardStartedCode), "—", "Clipboard preparation starts in the login click before the code arrives");
        assert.equal(await page.locator("#github-copy-code svg").count(), 1);
        await page.locator("#refresh").click();await page.waitForFunction(() => !document.getElementById("refresh").disabled);
        assert.equal(await page.evaluate(() => window.clipboardWrites.length), 1, "Polling or rendering does not overwrite the clipboard repeatedly");
        await page.evaluate(() => { window.clipboardBlocked = true; });await page.locator("#github-copy-code").click();
        await page.waitForFunction(() => document.getElementById("github-copy-state").textContent.includes(document.documentElement.lang === "zh-CN" ? "手动" : "manually"));
        await page.evaluate(() => { window.clipboardBlocked = false; });await page.locator("#github-copy-code").click();
        await page.waitForFunction(() => window.clipboardWrites.length === 2);
        await page.locator("#github-authorize").evaluate(node => node.addEventListener("click", event => event.preventDefault()));
        await page.locator("#github-authorize").click();await page.waitForFunction(() => window.clipboardWrites.length === 3);
        if (output && language === "zh" && width === 1280) await page.locator("#github-account").screenshot({ path: path.join(output, `${engine}-${palette}-${theme}-device-code.png`) });
        await page.locator("#github-cancel").click();
        await page.waitForFunction(() => document.getElementById("github-login-flow").hidden);
        assert.match(await page.locator("#github-account-note").innerText(), language === "zh" ? /取消.*保留/ : /cancelled.*kept/);
        if (output && language === "zh" && width === 1280) await page.screenshot({ path: path.join(output, `${engine}-${palette}-${theme}-signin.png`), fullPage: true });
        await page.locator("#account-authorization > summary").click();
        assert.equal(await page.locator("#provider-auth tr").count(), 3);
        assert.equal(await page.locator("#provider-auth tr:visible").count(), 1);
        assert.doesNotMatch(await page.locator("#provider-auth").innerText(), /synthetic@example.test/);
        assert.equal(await page.locator("#model-providers [role=tab]").count(), 3);
        assert.equal(accountChecks, 0, "Opening the page never enumerates accounts or acquires tokens");
        await page.locator("#model-provider-m365").click();
        await page.waitForFunction(() => !document.getElementById("m365-source-access").hidden);
        await page.waitForFunction(() => document.getElementById("models-note").textContent.includes("GPT 2"));
        assert.match(await page.locator("#models-note").innerText(), /Claude 1/);
        assert.equal(await page.locator("#model-check-details").isVisible(), true);
        await page.locator("#model-check-details > summary").click();assert.match(await page.locator("#model-check-fields").innerText(), /synthetic-catalog-request/);
        assert.doesNotMatch(await page.locator("#model-check-fields").innerText(), /NEVER_EXPOSE/);
        await page.locator("#model-check-details > summary").click();
        assert.equal(await page.locator("#github-account").isVisible(), false);
        assert.equal(await page.locator("#provider-auth tr:visible").count(), 1);
        assert.match(await page.locator("#provider-auth").innerText(), /synthetic@example.test/);
        await page.waitForFunction(() => !document.getElementById("m365-enabled").disabled);
        await page.locator("#m365-account-name").evaluate(node => { node.dataset.original = node.textContent;node.textContent = "long.company.account.with.several.parts@a-long-company-domain.example.test"; });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Company account names wrap within narrow layouts");
        await page.locator("#m365-account-name").evaluate(node => { node.textContent = node.dataset.original; });
        const sourceEnabled = await page.locator("#m365-enabled").isChecked();
        assert.equal(sourceEnabled, true);
        page.once("dialog", dialog => dialog.dismiss());await page.locator("#m365-enabled").click();
        assert.equal(await page.locator("#m365-enabled").isChecked(), true, "Cancelling source disable keeps the confirmed setting");
        await page.route("**/_ccdx/ui/settings", route => route.request().method() === "POST" && route.request().postDataJSON()?.action === "provider"
          ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "synthetic source save refused" }) }) : route.continue());
        page.once("dialog", dialog => dialog.accept());await page.locator("#m365-enabled").click();
        await page.waitForFunction(() => document.getElementById("m365-control-note").textContent.includes("synthetic source save refused"));
        assert.equal(await page.locator("#m365-enabled").isChecked(), true, "A rejected source disable restores its confirmed switch");
        await page.unroute("**/_ccdx/ui/settings");
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
        const modelSummary = page.locator("#live-models-body tr").first().locator("summary");
        await modelSummary.scrollIntoViewIfNeeded();
        const modelSummaryBefore = await modelSummary.boundingBox();
        const catalogScrollBefore = await modelSummary.evaluate(el => ({ page: scrollX, table: el.closest(".table-wrap").scrollLeft }));
        await modelSummary.click();
        await page.clock.fastForward(250);
        const modelSummaryAfter = await modelSummary.boundingBox();
        assert(Math.abs(modelSummaryBefore.x - modelSummaryAfter.x) <= 1, "Model details expand without moving the summary horizontally");
        assert.deepEqual(await modelSummary.evaluate(el => ({ page: scrollX, table: el.closest(".table-wrap").scrollLeft })), catalogScrollBefore);
        assert.match(await page.locator("#live-models-body").innerText(), /low.*high/);
        const contrast = await page.locator("#live-models-body td").first().evaluate(node => {
          const luminance = color => { const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { value /= 255;return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; });return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722; };
          const text = luminance(getComputedStyle(node).color), surface = luminance(getComputedStyle(node.closest(".panel")).backgroundColor);
          return (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05);
        });
        assert.ok(contrast >= 4.5, `Model names must remain readable (${contrast})`);
        assert.equal(await page.locator("#model-providers [aria-selected=true] svg").count(), 0);
        proxyFailure = true;await page.locator("#refresh-models").click();
        await page.waitForFunction(() => document.getElementById("model-check-fields").textContent.includes("proxy_bypass_invalid"));
        await page.locator("#model-check-details > summary").click();
        assert.match(await page.locator("#live-models-body").innerText(), /claude-opus-5.5/, "Failed checks retain the previous catalog");
        assert.match(await page.locator("#model-check-fields").innerText(), language === "zh" ? /代理例外规则无效/ : /Invalid proxy exception rule/);
        assert.doesNotMatch(await page.locator("#model-check-fields").innerText(), /NEVER_EXPOSE/);
        await page.locator("#refresh").click();
        await page.waitForFunction(() => document.getElementById("provider-auth").textContent.includes(document.documentElement.lang === "zh-CN" ? "代理例外规则无效" : "Invalid proxy exception rule"));
        assert.match(await page.locator("#provider-auth tr").nth(1).locator("td").nth(3).getAttribute("title"), /proxy_bypass_invalid.*m365_proxy_settings_unsupported/);
        await page.locator("#language-toggle").click();
        assert.match(await page.locator("#provider-auth").innerText(), language === "zh" ? /Invalid proxy exception rule/ : /代理例外规则无效/);
        assert.match(await page.locator("#model-check-fields").innerText(), language === "zh" ? /Interpret proxy rules/ : /解析代理规则/);
        assert.match(await page.locator("#models-note").innerText(), language === "zh" ? /Showing the list from/ : /当前显示/);
        assert.doesNotMatch(await page.locator("#models-note").innerText(), /m365_proxy_settings_unsupported/);
        await page.locator("#language-toggle").click();
        if (output && language === "zh" && width === 1280) await page.screenshot({ path: path.join(output, `${engine}-${palette}-${theme}-network-diagnostic.png`), fullPage: true });
        proxyFailure = false;await page.locator("#refresh").click();
        // A force read joins existing work. Drain any old synthetic refusal
        // before requiring a new receipt from the changed fixture.
        await page.evaluate(async () => { await Promise.all(["models", "auth"].map(async key => { await dashboardRefresh.state(key).pending;await dashboardRefresh.refresh(key, { force: true }); })); });
        await page.waitForFunction(() => document.getElementById("model-check-fields").textContent.includes("synthetic-catalog-request") && !document.getElementById("refresh").disabled);
        await page.waitForFunction(() => !/代理例外规则无效|Invalid proxy exception rule/.test(document.getElementById("provider-auth").textContent));
        assert.doesNotMatch(await page.locator("#provider-auth").innerText(), /代理例外规则无效|Invalid proxy exception rule/);
        await page.locator("#model-provider-third").click();
        await page.waitForFunction(() => document.getElementById("model-check-fields").textContent.includes("m365_disabled"));
        assert.doesNotMatch(await page.locator("#live-models-body").innerText(), /claude-opus/);
        await page.locator("#model-provider-github").click();
        await page.waitForFunction(() => document.getElementById("live-models-body").textContent.includes("gpt-6.1-sol"));
        const icon = decodeURIComponent(await page.locator("#favicon").getAttribute("href"));
        assert.equal((icon.match(/<ellipse /g) || []).length, 3);
        const iconColors = { green: ["#a6f5a8", "#176b3a"], klein: ["#789aff", "#002fa7"], pink: ["#f3a8c8", "#a83e68"], mono: ["#ffffff", "#000000"] };
        assert.ok(icon.includes(iconColors[palette][theme === "dark" ? 0 : 1]));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "No whole-page horizontal overflow");
        await nav("checks");
        const entries = page.locator('[data-view="checks"] .account-entry');
        assert.equal(await entries.count(), 2);
        const entryBoxes = await entries.evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect();return { height: rect.height, y: rect.y, decoration: getComputedStyle(node).textDecorationLine }; }));
        assert.equal(entryBoxes[0].height, 36);assert.equal(entryBoxes[1].height, 36);assert.equal(entryBoxes[0].y, entryBoxes[1].y);assert.equal(entryBoxes[1].decoration, "none");
        await entries.nth(1).click();await page.waitForFunction(() => !document.getElementById("m365-source-access").hidden);
        assert.equal(accountChecks, 1, "Navigation does not silently enumerate accounts");
        await nav("checks");await page.locator("#check-account-link").click();await page.waitForFunction(() => !document.getElementById("github-account").hidden);
        await nav("checks");await page.locator("#check-local").click();
        await page.waitForFunction(() => document.getElementById("checks-body").children.length > 0);
        assert.equal(await page.locator("#checks-body .state-warning .state-icon").count(), 1);
        await page.locator("#preview-config-repair").click();
        await page.waitForFunction(() => !document.getElementById("config-repair-preview").hidden);
        assert.match(await page.locator("#config-repair-fields").innerText(), /openai_base_url.*config.toml.ccdx-doctor.bak/s);
        await page.locator("#apply-config-repair").click();
        await page.waitForFunction(() => document.getElementById("config-repair-preview").hidden);
        assert.match(await page.locator("#checks-note").innerText(), language === "zh" ? /已修复/ : /repaired/);
        assert.equal(await page.locator("#checks-body .state-warning").count(), 0, "Repair results replace stale pre-repair warnings");
        assert.equal(await page.locator("#checks-body .state-ok .state-icon").count(), 1);
        if (output && language === "zh" && width === 1280) await page.screenshot({ path: path.join(output, `${engine}-${palette}-${theme}-checks.png`), fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Checks stay within the viewport");
        await nav("requests");
        flowRequests = concurrentFlow().slice(0, 1);await refreshStatus();
        assert.equal(await page.locator("#flow-state .state-progress .state-icon circle").count(), 1, "Active requests use circled ellipsis");
        const singlePaths = await page.locator("#flow-wires path").evaluateAll(nodes => nodes.map(node => node.getAttribute("d")));
        assert.equal(singlePaths.length, 2);assert.ok(singlePaths.every(d => !/[QV]/.test(d)), "A single route is straight");
        assert.equal(await page.locator("#flow-network .flow-count:visible").count(), 0);
        assert.match(await page.locator("#flow-apps").innerText(), /Codex App/);
        assert.equal(await page.locator("#flow-hub small").count(), 0, "Total is not repeated under the logo");
        assert.equal(await page.locator(".flow-halo-turn").evaluate(node => getComputedStyle(node).animationPlayState), "running");
        assert.equal(await page.locator(".flow-logo").evaluate(node => getComputedStyle(node).animationName), "none");
        if (await page.locator("#flow-active").getAttribute("open") === null) await page.locator("#flow-active > summary").click();
        await page.locator("#flow-active-body tr").first().waitFor({ state: "visible" });
        await page.evaluate(() => { window.keptFlowRow = document.querySelector("#flow-active-body tr"); });
        flowRequests[0].elapsed_ms += 1000;await refreshStatus();
        if (width === 1280) {
          await page.waitForTimeout(60);
          await page.evaluate(() => { window.keptFlowPaths = [...document.querySelectorAll("#flow-wires path")]; });
          const savedOutput = flowRequests[0].first_output_ms;
          flowRequests[0].first_output_ms = savedOutput === null ? 2 : null;await refreshStatus();
          assert.equal(await page.evaluate(() => keptFlowPaths.every((node, i) => node === document.querySelectorAll("#flow-wires path")[i])), true, "Phase-only changes keep SVG paths");
          flowRequests[0].first_output_ms = savedOutput;await refreshStatus();
        }
        assert.equal(await page.evaluate(() => keptFlowRow === document.querySelector("#flow-active-body tr")), true, "Elapsed time updates keep the original row");

        flowRequests.push({ ...flowRequests[0], request_id: "shared-second", first_output_ms: null });
        await refreshStatus();
        assert.ok((await page.locator("#flow-wires path").evaluateAll(nodes => nodes.map(node => node.getAttribute("d")))).every(d => !/[QV]/.test(d)), "Shared concurrent route stays straight");
        assert.equal(await page.locator("#flow-network .flow-count:visible").count(), 2);
        assert.match(await page.locator("#flow-models .flow-count").innerText(), language === "zh" ? /2 个请求/ : /2 requests/);
        if (output && language === "zh") await page.screenshot({ path: path.join(output, `${engine}-${palette}-${theme}-${width}-shared-flow.png`), fullPage: true });
        flowRequests = concurrentFlow();await refreshStatus();
        assert.equal(await page.locator("#request-flow").getAttribute("data-state"), "active");
        assert.equal(await page.locator("#flow-apps .flow-node").count(), 3);
        assert.equal(await page.locator("#flow-models .flow-node").count(), 3);
        // A shared right edge keeps application paths and their bends aligned.
        const appEdges = await page.locator("#flow-apps .flow-node").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().right));
        assert.ok(Math.max(...appEdges) - Math.min(...appEdges) < 1, "Every app uses the same right edge");
        const notes = await page.locator("#flow-apps .flow-note").evaluateAll(nodes => nodes.map(node => ({ right: node.getBoundingClientRect().right, align: getComputedStyle(node).textAlign })));
        assert.ok(notes.every(node => node.align === "right") && Math.max(...notes.map(node => node.right)) - Math.min(...notes.map(node => node.right)) < 1, "Application statuses share a right-aligned edge");
        const starts = await page.locator("#flow-models .flow-choice").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().left));
        assert.ok(Math.max(...starts) - Math.min(...starts) < 1, "Every model uses the same left edge");
        assert.equal(await page.locator("#flow-wires circle").count(), 0, "Flow uses dashed paths instead of moving dots");
        assert.equal(await page.locator("#flow-wires .flow-streaming").count(), 4);
        assert.equal(await page.locator("#flow-active-wires .flow-streaming").count(), 4);
        assert.equal(await page.locator("#flow-active-wires").isVisible(), true);
        await page.emulateMedia({ reducedMotion: "reduce" });
        assert.equal(await page.locator("#flow-active-wires .flow-streaming").evaluateAll(nodes => nodes.every(node => getComputedStyle(node).animationName === "none")), true);
        await page.emulateMedia({ reducedMotion: "no-preference" });
        assert.equal(await page.locator("#flow-active-wires .flow-streaming").evaluateAll(nodes => nodes.every(node => getComputedStyle(node).animationName === "flow-dash")), true);
        assert.equal(await page.locator("#flow-wires .flow-split").evaluateAll(nodes => nodes.every(node => getComputedStyle(node).animationName === "none" && getComputedStyle(node).visibility === "hidden")), true);
        assert.equal(await page.locator("#flow-wires .flow-waiting").count(), 2);
        assert.ok((await page.locator("#flow-wires path").evaluateAll(nodes => nodes.map(node => node.getAttribute("d")))).some(d => d.includes("Q")), "Connections have rounded turns");
        flowRequests.push({ ...flowRequests[0], request_id: "multi-app-count" });await refreshStatus();
        const countedEdges = await page.locator("#flow-apps .flow-node").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().right));
        assert.ok(Math.max(...countedEdges) - Math.min(...countedEdges) < 1, "Mixed singleton and counted apps retain fixed anchors");
        flowRequests = concurrentFlow();await refreshStatus();
        await page.locator("#flow-apps .flow-choice").first().click();
        assert.equal(await page.locator("#flow-active-body tr").count(), 1);
        const selectedName = page.locator('.flow-choice[aria-pressed="true"]');
        assert.equal(await selectedName.locator(".flow-count").count(), 0);
        assert.equal(await page.locator("#flow-apps .flow-count:visible").count(), 0, "Known singleton counts are hidden");
        assert.match(await page.locator("#flow-state").innerText(), /3/);
        await page.locator("#flow-clear").click();
        assert.equal(await page.locator("#flow-active-body tr").count(), 3);
        assert.match(await page.locator("#flow-active-body").innerText(), language === "zh" ? /正在重试/ : /Retrying/);
        assert.equal(await page.locator("#flow-active-body tr").last().locator("td").first().evaluate(node => getComputedStyle(node).borderBottomWidth), "0px");
        // A status refresh can replace this table between locator resolution and evaluation.
        await page.waitForFunction(() => {
          const node = document.querySelector("#source-requests .tool-details");
          return node?.isConnected && getComputedStyle(node).borderTopWidth === "0px";
        });
        assert.equal(await page.locator("#main-content").evaluate(node => getComputedStyle(node).outlineStyle), "none");
        if (output && language === "zh") await page.screenshot({ path: path.join(output, `${engine}-${palette}-${theme}-${width}-flow.png`), fullPage: true });
        await page.locator("#auto-refresh").click();
        await page.clock.fastForward(6001);
        assert.equal(await page.locator("#request-flow").getAttribute("data-state"), "unknown");
        assert.equal(await page.locator(".flow-streaming").count(), 0, "Stale snapshots stop activity");
        await page.locator("#auto-refresh").click();
        flowRequests = [];await refreshStatus();
        assert.equal(await page.locator("#request-flow").getAttribute("data-state"), "idle");
        assert.equal(await page.locator("#flow-state").evaluate(node => getComputedStyle(node, "::before").animationName), "flow-breathe");
        assert.equal(await page.locator(".flow-halo-turn").evaluate(node => getComputedStyle(node).animationPlayState), "paused");

        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Flow remains inside the viewport");
        assert.equal(await page.locator("#request-context").getAttribute("open"), "");
        assert.equal(await page.locator("#context-body tr").count(), 2);
        assert.equal(await page.locator("#context-body script").count(), 0);
        assert.match(await page.locator("#context-body").innerText(), /<script>not-html<\/script>/);
        const metadata = page.locator('#context-body .request-details[data-request-key="synthetic-recent"]');
        await metadata.locator("summary").scrollIntoViewIfNeeded();
        const metadataBefore = await metadata.locator("summary").boundingBox();
        const requestColumnsBefore = await page.locator("#context-body").evaluate(body => [...body.closest("table").tHead.rows[0].cells].map(cell => ({ x: cell.getBoundingClientRect().x, width: cell.getBoundingClientRect().width })));
        await metadata.locator("summary").click();
        await page.clock.fastForward(250);
        const metadataAfter = await metadata.locator("summary").boundingBox();
        assert(Math.abs(metadataBefore.x - metadataAfter.x) <= 1, "Request metadata expands without moving the trigger horizontally");
        assert.deepEqual(await page.locator("#context-body").evaluate(body => [...body.closest("table").tHead.rows[0].cells].map(cell => ({ x: cell.getBoundingClientRect().x, width: cell.getBoundingClientRect().width }))), requestColumnsBefore, "Opening request metadata must not redistribute table columns");
        assert.match(await metadata.innerText(), /1\.00 MiB.*0.*1,000.*15\.0%/s);
        await refreshStatus();
        assert.equal(await metadata.getAttribute("open"), "", "Unchanged reads keep request details open");
        extraRequests = [{ at: "2026-10-21T06:51:08Z", request_id: "synthetic-new", provider: "github", model: "gpt-new", outcome: "completed", context: {} }];
        await refreshStatus();
        assert.equal(await metadata.getAttribute("open"), "", "A new request keeps retained request details open");
        assert.equal(await page.locator("#recent-failures").isVisible(), true);
        assert.match(await page.locator("#recent-failures li summary").innerText(), /Microsoft 365/);
        await page.locator("#failure-kind").selectOption("capability");
        assert.equal(await page.locator("#failures > li").count(), 1);
        assert.match(await page.locator("#failures").innerText(), language === "zh" ? /出现 2 次/ : /2 occurrences/);
        await page.locator("#failure-kind").selectOption("connection");
        assert.equal(await page.locator("#failures > li").count(), 1);
        await page.locator("#failures details > summary").click();
        assert.match(await page.locator("#failures").innerText(), /oauth-authorization-server/);
        await page.locator("#failure-kind").selectOption("issues");
        await page.locator("#language-toggle").click();
        assert.match(await page.locator("#recent-failures li summary").innerText(), language === "zh" ? /not retried/ : /未重试/);
        await page.locator("#language-toggle").click();
        assert.equal(await page.locator("#model-usage").isVisible(), false);
        await nav("usage");
        const beforeContext = contextReads;
        assert.equal(await page.locator("#usage-tokens-pane").isVisible(), true);
        await page.locator("#usage-context-tab").click();
        await page.waitForFunction(() => document.getElementById("context-latest-input").textContent === "120");
        assert.equal(contextReads, beforeContext + 1);
        assert.equal(await page.locator("#context-sessions tr").count(), 2);
        assert.equal(await page.locator("#context-history-chart svg").count(), 1);
        assert.equal(await page.locator("#context-share").textContent(), "12.0%");
        assert.equal(await page.locator("#context-reuse").textContent(), "50.0%");
        assert.match(await page.locator("#context-compactions").textContent(), /2.4 s/);
        if (output && language === "zh" && width === 1280) await page.screenshot({ path: path.join(output, `${engine}-${palette}-${theme}-context.png`), fullPage: true });
        await page.locator("#context-sessions button").last().click();
        assert.equal(await page.locator("#context-share").textContent(), "—");
        assert.equal(await page.locator("#context-reuse").textContent(), "—");
        assert.equal(await page.locator("#context-history-chart svg").count(), 0, "Unidentified requests do not create conversation curves");
        await page.route("**/_ccdx/ui/context", route => route.fulfill({ status: 503, body: '{}' }));
        await page.locator("#refresh").click();
        await page.waitForFunction(() => !document.getElementById("refresh").disabled);
        assert.equal(await page.locator("#context-sessions tr").count(), 2, "Failed reads retain observed metadata");
        await page.unroute("**/_ccdx/ui/context");
        await page.locator("#usage-tokens-tab").click();
        assert.equal(await page.locator("#usage-tokens-pane").isVisible(), true);
        await page.locator("#usage-analytics > summary").click();
        await page.waitForFunction(() => document.querySelectorAll(".calendar-day").length === 365);
        await page.waitForFunction(() => !document.getElementById("refresh-usage").disabled);
        await page.locator("#usage-provider").selectOption("m365");
        await page.waitForFunction(() => !document.getElementById("refresh-usage").disabled && !document.getElementById("usage-body").textContent.includes("gpt-6.1-sol"));
        assert.match(await page.locator("#usage-body").innerText(), /claude-opus-5\.5/);
        await page.locator("#usage-provider").selectOption("");
        await page.waitForFunction(() => !document.getElementById("refresh-usage").disabled && document.getElementById("usage-body").textContent.includes("gpt-6.1-sol"));
        assert.equal(await page.locator("#analytics-view").inputValue(), "bars");
        await page.locator("#daily-bars").scrollIntoViewIfNeeded();
        await page.waitForFunction(() => chartMotions.some(motion => motion.frames[0].transform === "scaleY(0)"));
        const readsBeforeView = summaries;
        await page.locator("#analytics-view").selectOption("line");
        await page.waitForFunction(() => document.querySelectorAll("#daily-bars .daily-curve").length === 2);
        await page.waitForFunction(() => chartMotions.some(motion => motion.frames[0].strokeDashoffset === 1 && motion.options.duration === 600));
        const boxes = await page.locator("#daily-bars .daily-curve").evaluateAll(paths => paths.map(path => { const box = path.getBBox();return { min: box.y, max: box.y + box.height }; }));
        assert.ok(boxes.every(box => box.min >= 3 && box.max <= 129), "Curves stay inside the data range and plot");
        await page.locator("#daily-bars .daily-bar:not(:disabled)").last().click();
        const selectedDay = await page.locator("#usage-state").innerText();
        assert.match(selectedDay, /^\d{4}-\d{2}-\d{2}$/);
        await page.locator("#analytics-view").selectOption("bars");
        assert.equal(await page.locator("#usage-state").innerText(), selectedDay);
        await page.locator("#analytics-view").selectOption("line");
        assert.equal(await page.locator("#usage-state").innerText(), selectedDay);
        assert.equal(summaries, readsBeforeView, "Switching charts/days does not scan usage again");
        await page.locator("#clear-usage-day").click();
        if (output && language === "zh") { await page.clock.fastForward(700);await page.locator("#usage-analytics").screenshot({ path: path.join(output, `${engine}-${palette}-${theme}-${width}-curves.png`) }); }
        await page.locator("#analytics-range").selectOption("90");
        await page.evaluate(() => { window.savedCalendar = document.querySelector(".calendar-day"); window.savedModelRow = document.querySelector("#live-models-body tr"); });
        assert.equal(updateReads, 0, "Other views do not check releases");
        await nav("system");
        assert.equal(await page.locator("#daily-bars .daily-curve").evaluateAll(paths => paths.every(path => path.getAnimations().length === 0)), true, "Leaving Usage cancels chart motion");
        await page.waitForFunction(() => document.getElementById("update-latest-version").textContent === "v1.2.4" && !document.getElementById("check-updates").disabled);
        assert.equal(await page.locator("#update-current-version").innerText(), "v1.2.3");
        assert.match(await page.locator("#update-current-date").innerText(), /2026-10-19/);
        assert.equal(await page.locator(".terminal-animation-toggle").evaluate(node => getComputedStyle(node).borderBottomWidth), "0px");
        assert.equal(await page.locator("#animation-settings").evaluate(node => getComputedStyle(node).borderTopWidth), "0px");
        await page.locator(".update-install > summary").click();
        assert.match(await page.locator("#install-command").innerText(), /v1\.2\.4\/install\.sh/);
        const selectedPlatform = await page.locator('[data-install-platform="macos"]').evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
        const otherPlatform = await page.locator('[data-install-platform="windows"]').evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
        assert.notEqual(selectedPlatform.background, otherPlatform.background, "Selected platform must have an actual visible fill");
        assert.equal(await page.locator('[data-install-platform="macos"] svg').count(), 0, "Selection does not displace centered text with an icon");
        await page.locator("#nightly-update").waitFor({ state: "visible" });
        await page.waitForFunction(() => !document.getElementById("nightly-update").disabled);
        assert.equal(await page.locator("#nightly-update").isChecked(), false);
        assert.match(await page.locator("#nightly-risk").innerText(), language === "zh" ? /重启.*会话/ : /restart.*conversation/);
        const settlePreferences = async () => { await page.clock.runFor(400);await page.waitForFunction(() => !ccdxSettingsPreferences.busy); };
        await page.locator("#nightly-update").click();
        await page.locator("#preferences-dialog-confirm").click();await settlePreferences();
        await page.waitForFunction(() => !document.getElementById("nightly-update").disabled);
        assert.equal(await page.locator("#nightly-rules").isVisible(), true);
        assert.match(await page.locator("#nightly-state").innerText(), language === "zh" ? /下次启动/ : /next time/);
        await page.locator("#nightly-update").uncheck();await settlePreferences();
        await page.waitForFunction(() => !document.getElementById("nightly-update").disabled);
        assert.equal(await page.locator("#nightly-rules").isVisible(), false);
        await page.locator("#web-color-theme").focus();
        assert.deepEqual(await page.locator("#web-color-theme").evaluate(node => ({ radius: getComputedStyle(node).borderRadius, shadow: getComputedStyle(node).boxShadow, appearance: getComputedStyle(node).appearance })),
          { radius: "0px", shadow: "none", appearance: "none" });
        await page.locator('[data-install-platform="windows"]').click();
        assert.match(await page.locator("#install-command").innerText(), /v1\.2\.4\/install\.ps1/);
        assert.doesNotMatch(await page.locator("#install-command").innerText(), /Bypass|allow-remote|ExecutionPolicy/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Full Windows command wraps within the page");
        latestVersion = "1.2.3";await page.locator("#check-updates").click();
        await page.waitForFunction(() => !document.getElementById("check-updates").disabled && document.getElementById("update-latest-row").hidden);
        assert.match(await page.locator("#update-state").innerText(), language === "zh" ? /已是最新/ : /up to date/);
        updateState = "unavailable";await page.locator("#check-updates").click();
        await page.waitForFunction(() => !document.getElementById("check-updates").disabled && document.getElementById("update-state").textContent.includes(document.documentElement.lang === "zh-CN" ? "最新版本未知" : "Latest version unknown"));
        assert.equal(await page.locator("#update-command-row").isVisible(), true);
        updateState = "checked";latestVersion = "1.2.4";
        await page.locator("#check-updates").click();await page.waitForFunction(() => !document.getElementById("check-updates").disabled);
        await page.locator(".update-install > summary").click();
        await page.waitForFunction(() => !document.getElementById("terminal-color-theme").disabled);
        assert.equal(await page.locator("#web-color-theme").inputValue(), palette);
        const terminalPalette = palette === "pink" ? "pink" : "klein";
        await page.locator("#terminal-color-theme").selectOption(terminalPalette);await settlePreferences();
        await page.waitForFunction(() => !document.getElementById("terminal-color-theme").disabled);
        assert.equal(await page.locator("html").getAttribute("data-palette"), palette);
        assert.equal(await page.locator("#terminal-color-sample").getAttribute("data-terminal-palette"), terminalPalette);
        await page.locator("#web-color-theme").selectOption(palette === "green" ? "klein" : "green");await settlePreferences();
        assert.equal(await page.locator("#terminal-color-theme").inputValue(), terminalPalette);
        await page.locator("#web-color-theme").selectOption(palette);await settlePreferences();
        await page.route("**/_ccdx/ui/settings", async route => {
          if (route.request().method() === "POST") return route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({error:"synthetic save refused"})});
          return route.continue();
        });
        await page.locator("#terminal-color-theme").selectOption("green");await settlePreferences();
        assert.equal(await page.locator("#preferences-retry").isVisible(), true);
        assert.equal(await page.locator("#terminal-color-theme").inputValue(), "green", "Failed preferences retain the draft");
        assert.equal(serviceControl.snapshot().color_theme, terminalPalette);
        await page.unroute("**/_ccdx/ui/settings");
        await page.locator("#preferences-retry").click();await settlePreferences();
        assert.equal(serviceControl.snapshot().color_theme, "green");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.locator("#animation-settings > summary").click();
        await page.waitForFunction(() => document.querySelectorAll(".theme-option").length === 2);
        await page.locator(".theme-option").nth(1).click();
        await page.locator("#refresh").click();
        await page.waitForFunction(() => !document.getElementById("refresh").disabled);
        assert.equal(await page.locator(".theme-option").nth(1).getAttribute("aria-pressed"), "true");
        assert.equal(await page.locator("#save-animation").isHidden(), true);
        await settlePreferences();assert.equal(serviceControl.snapshot().theme, "twin");
        await page.waitForFunction(() => !document.getElementById("setting-open_webui").disabled);
        const openBefore = await page.locator("#setting-open_webui").isChecked();
        await page.locator("#setting-open_webui").setChecked(!openBefore);await settlePreferences();
        await page.waitForFunction(() => !document.getElementById("setting-open_webui").disabled);
        assert.match(await page.locator("#effect-open_webui").innerText(), language === "zh" ? /重启 CCDX 后生效/ : /Next CCDX start/);
        await page.locator("#setting-open_webui").setChecked(openBefore);await settlePreferences();
        await page.waitForFunction(() => !document.getElementById("setting-open_webui").disabled);
        const previousPreferences = serviceControl.snapshot().preferences.values;
        const protectedSettings = { image: serviceControl.snapshot().saved.image_enabled, prediction: serviceControl.snapshot().saved.prediction_enabled, source: codexSource };
        assert.equal(await page.locator("#preferences-auto").isChecked(), true);
        assert.equal(await page.locator("#settings-preferences").evaluate(node => node.previousElementSibling.id), "version-updates");
        await page.locator("#preferences-auto").uncheck();await settlePreferences();
        assert.equal(serviceControl.snapshot().preferences.values.auto_save_settings, false);
        await page.locator("#terminal-color-theme").selectOption("pink");
        await page.locator("#setting-open_webui").setChecked(!previousPreferences.open_webui);
        await page.locator("#refresh").click();await page.waitForFunction(() => !document.getElementById("refresh").disabled);
        assert.equal(await page.locator("#terminal-color-theme").inputValue(), "pink", "Polling retains manual drafts");
        assert.equal(serviceControl.snapshot().color_theme, previousPreferences.terminal_color_theme, "Manual changes are not persisted early");
        await page.locator("#preferences-save").click();await settlePreferences();
        assert.equal(serviceControl.snapshot().color_theme, "pink");
        const savedBeforeReset = serviceControl.snapshot().preferences.values;
        await page.locator("#preferences-reset").click();await page.locator("#preferences-dialog").waitFor({state:"visible"});
        assert.match(await page.locator("#preferences-dialog-scope").innerText(), language === "zh" ? /账号与密钥/ : /Accounts and keys/);
        await page.locator("#preferences-dialog-confirm").click();await settlePreferences();
        assert.equal(serviceControl.snapshot().preferences.values.terminal_color_theme, "green");
        assert.equal(serviceControl.snapshot().preferences.values.terminal_animation, "comet");
        assert.equal(await page.locator("html").getAttribute("data-palette"), "green");
        assert.equal(await page.locator("#preferences-backup").isVisible(), true);
        assert.deepEqual({image:serviceControl.snapshot().saved.image_enabled,prediction:serviceControl.snapshot().saved.prediction_enabled,source:codexSource}, protectedSettings);
        await page.locator("#preferences-restore").click();await page.locator("#preferences-dialog-confirm").click();await settlePreferences();
        assert.deepEqual(serviceControl.snapshot().preferences.values, savedBeforeReset);
        assert.equal(await page.locator("html").getAttribute("data-palette"), palette);
        await page.locator("#terminal-color-theme").selectOption(previousPreferences.terminal_color_theme);
        await page.locator("#setting-open_webui").setChecked(previousPreferences.open_webui);
        await page.locator("#preferences-auto").click();
        await page.locator("#preferences-dialog").waitFor({state:"visible"});
        await page.locator("#preferences-dialog-confirm").click();await settlePreferences();
        assert.equal(serviceControl.snapshot().preferences.values.auto_save_settings, true);
        if (language === "en" && theme === "light" && width === 1280 && palette === "green") {
          const beforeBlockedBackup = serviceControl.snapshot().preferences.values;
          await page.evaluate(() => { window.realPreferenceStorage = Storage.prototype.setItem;Storage.prototype.setItem = function(key, value) { if (key === "ccdx.dashboard.preferences-backup") throw Error("storage fixture denied");return window.realPreferenceStorage.call(this, key, value); }; });
          await page.locator("#preferences-reset").click();await page.locator("#preferences-dialog-confirm").click();
          await page.waitForFunction(() => document.getElementById("preferences-error").textContent.includes("backup"));
          assert.deepEqual(serviceControl.snapshot().preferences.values, beforeBlockedBackup, "A browser backup failure makes no server reset");
          await page.evaluate(() => { Storage.prototype.setItem = window.realPreferenceStorage; });
          await page.locator("#terminal-color-theme").selectOption("pink");await settlePreferences();
          await page.locator("#terminal-color-theme").selectOption(previousPreferences.terminal_color_theme);await settlePreferences();
          let releaseRead, readStarted, intercepted = false;
          const staleGate = new Promise(resolve => { releaseRead = resolve; }), staleStarted = new Promise(resolve => { readStarted = resolve; });
          await page.route("**/_ccdx/ui/settings", async route => {
            if (route.request().method() === "GET" && !intercepted) {
              intercepted = true;const stale = serviceControl.snapshot();stale.terminal = { ...stale.terminal, last_notice: "stale-read-applied" };readStarted();await staleGate;return route.fulfill({json:stale});
            }
            return route.continue();
          });
          await page.locator("#refresh").click();await staleStarted;
          await page.locator("#setting-open_webui").setChecked(!previousPreferences.open_webui);await settlePreferences();
          releaseRead();await page.waitForFunction(() => document.getElementById("process-notice").textContent === "stale-read-applied");
          assert.equal(await page.locator("#setting-open_webui").isChecked(), !previousPreferences.open_webui, "A late read cannot undo a saved preference");
          await page.unroute("**/_ccdx/ui/settings");
          await page.locator("#setting-open_webui").setChecked(previousPreferences.open_webui);await settlePreferences();
        }
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
        const chartMotionCount = await page.evaluate(() => chartMotions.length);
        await page.locator(".sidebar-brand #status-icon").click();
        assert.equal(await page.evaluate(() => atomMotions.length), motionCount, "Reduced motion also suppresses logo click rotations");
        await nav("usage");
        await page.locator("#analytics-view").selectOption("bars");
        await page.locator("#analytics-view").selectOption("line");
        assert.equal(await page.evaluate(() => chartMotions.length), chartMotionCount, "Reduced motion keeps both charts static");
        await page.locator("#refresh").click();
        await page.waitForFunction(() => !document.getElementById("refresh").disabled);
        assert.equal(await page.evaluate(() => atomMotions.length), motionCount, "Reduced motion suppresses new atom rotations");
        await nav("overview");
        assert.equal(await page.locator(".activity-lamp").evaluate(node => getComputedStyle(node, "::before").animationName), "none", "Reduced motion keeps the idle halo static");
        modelActivity = 2;await page.locator("#refresh").click();
        await page.waitForFunction(() => document.getElementById("model-activity").dataset.state === "active");
        assert.equal(await page.locator(".activity-dots i").first().evaluate(node => getComputedStyle(node).animationName), "none");
        assert.equal(await page.locator(".activity-dots i").first().evaluate(node => getComputedStyle(node).opacity), "1");
        await page.clock.fastForward(6001);
        assert.equal(await page.locator("#model-activity").getAttribute("data-state"), "unknown", "Manual snapshots expire without extra network work");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (palette === "green" && language === "en" && theme === "light" && width === 1280) {
          const brokenUsage = await fs.readFile(new URL("../src/dashboard/usage.js", import.meta.url), "utf8");
          await page.route("**/usage.js*", route => route.fulfill({ status: 200, contentType: "text/javascript", body: brokenUsage + "\nwindow.workingUsageCreate=ccdxDashboardUsage.create;ccdxDashboardUsage.create=()=>{throw Error('synthetic optional-view failure')};" }));
          await page.reload();await nav("usage");
          if (await page.locator("#usage-analytics").getAttribute("open") === null) await page.locator("#usage-analytics > summary").click();
          await page.locator("#usage-analytics .view-error").waitFor();
          await nav("system");await page.waitForFunction(() => !document.getElementById("nightly-update").disabled);
          assert.equal(await page.locator("#nightly-update").isVisible(), true, "Optional chart failure does not break settings");
          await page.evaluate(() => { ccdxDashboardUsage.create = window.workingUsageCreate; });
          await nav("usage");await page.locator("#usage-analytics .view-error button").click();
          await page.locator("#usage-analytics .view-error").waitFor({ state: "hidden" });
        }
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
