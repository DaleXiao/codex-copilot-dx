import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { createUsageAnalytics } from "../src/usage-analytics.mjs";
import { summarizeUsage } from "../src/usage.mjs";

const script = readFileSync(new URL("../src/dashboard/ui.js", import.meta.url), "utf8");
const viewScripts = ["status", "usage"].map(name => readFileSync(new URL(`../src/dashboard/${name}.js`, import.meta.url), "utf8")).join("\n");
const refreshScript = readFileSync(new URL("../src/dashboard/refresh.js", import.meta.url), "utf8");
const languageScript = readFileSync(new URL("../src/dashboard/language.js", import.meta.url), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

class Node {
  constructor(tag = "div") { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.listeners = {}; this.attributes = {}; this.open = false; this.value = ""; this.textContent = ""; }
  append(...nodes) { for (const node of nodes) node.parent = this;this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  hasAttribute(key) { return Object.hasOwn(this.attributes, key); }
  addEventListener(event, fn) { this.listeners[event] = fn; }
  querySelectorAll(selector) { return this.children.flatMap((node) => [...(selector === "details[open]" && node.tag === "details" && node.open ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector() { return new Node("summary"); }
  scrollIntoView() {}
  focus() {}
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
}

function harness({ fetchFn, clipboard = async () => {}, reduced = false, language = false, savedLanguage = "en", savedAutomatic = "on" } = {}) {
  const nodes = new Map();
  const motions = [];
  const ready = [];
  const listeners = new Map();
  const on = (event, fn) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); };
  const document = { documentElement: { dataset: {} }, visibilityState: "visible", getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); }, createElement: (tag) => new Node(tag), createDocumentFragment: () => new Node(), addEventListener(event, fn) { if (event === "DOMContentLoaded") ready.push(fn); else on(event, fn); },
    querySelectorAll() {
      const found = new Set();
      const visit = (node) => { if (Object.keys(node.attributes).some((key) => key.startsWith("data-i18n"))) found.add(node); node.children.forEach(visit); };
      nodes.forEach(visit);
      return [...found];
    },
  };
  document.getElementById("analytics-range").value = "30";
  const logo = document.getElementById("status-icon");
  logo.animate = (frames, options) => { const motion = { frames, options, cancelled: false, cancel() { this.cancelled = true; } };motions.push(motion); };
  logo.getAnimations = () => motions.filter(motion => !motion.cancelled);
  document.getElementById("analytics-metric").value = "requests";
  for (const id of ["client-features", "upstream-models", "model-usage", "recent-failures"]) document.getElementById(id).open = true;
  const records = [{ ts: "2026-10-01T00:00:00Z", model: "test", usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, total_tokens: 110 } }];
  const collector = createUsageAnalytics({ now: Date.parse("2026-10-01T12:00:00Z") });
  records.forEach((row) => collector.record(row, summarizeUsage([row])));
  const usage = { source: "local_usage_log", total: { model: "TOTAL", requests: 1, input_tokens: 100, output_tokens: 10, total_tokens: 110 }, rows: [], model_count: 1 };
  const themes = { theme: "comet", themes: [["comet", "Comet"], ["twin", "Twin"]].map(([id, label], index) => ({ id, label, default: index === 0, frames: [{ ansi: "x", delay_ms: 50 }], loop_pause_ms: 50 })) };
  const requests = [];
  const timers = new Set();
  const scheduled = new Map();
  let now = Date.now();
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  let observer;
  const context = createContext({
    document, window: { matchMedia: () => ({ matches: reduced, addEventListener() {} }), addEventListener: on }, navigator: { clipboard: { writeText: clipboard } },
    Date: ClockDate, performance: { now: () => 0 }, AbortSignal, AbortController, Intl, URLSearchParams, encodeURIComponent, setTimeout(fn, ms) { scheduled.set(fn, ms); if (ms < 1800000) timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); scheduled.delete(fn); },
    localStorage: { getItem: key => key === "ccdx.dashboard.autoRefresh" ? savedAutomatic : savedLanguage, setItem() {} },
    IntersectionObserver: class { constructor(fn) { observer = fn; } observe() {} },
    fetch: async (url, options) => {
      requests.push(url);
      if (fetchFn) { const response = await fetchFn(url, options); if (response) return response; }
      const data = url === "/_ccdx/status" ? { ok: true, name: "codex-copilot-dx" }
        : url === "/_ccdx/ui/providers" ? { source: "provider_status", providers: [{ id: "github", name: "GitHub Copilot", enabled: true, state: "unknown", auth: { state: "saved", account: "octocat" }, clients: [{ id: "codex", name: "Codex App", selected: true, state: "configured" }] }] }
        : url.includes("/models/") ? { source: "live", models: [] }
        : url.includes("/usage") ? { ...usage, ...(url.includes("analytics=1") ? { analytics: collector.snapshot() } : {}) }
        : url.includes("frames=0") ? { ...themes, themes: themes.themes.map(({ id, label }) => ({ id, label })) } : themes;
      return { ok: true, json: async () => data };
    },
  });
  if (language) runInContext(languageScript, context);
  runInContext(refreshScript, context);
  const api = runInContext(`${viewScripts}\n${script}\n({ renderFailures, renderProviders, loadAuth, loadAnimation, loadUsage, renderAnalytics, selectUsageDay, dashboardRefresh, get timer() { return previewTimer; }, get selection() { return selectedAnimation; } });`, context);
  ready.forEach((fn) => fn());
  return { api, nodes, requests, timers, scheduled, motions,
    advance(ms) { now += ms; },
    event(name) { listeners.get(name)?.forEach(fn => fn()); },
    hidden(value) { document.visibilityState = value ? "hidden" : "visible"; listeners.get("visibilitychange")?.forEach(fn => fn()); },
    visible(value) { observer([{ isIntersecting: value }]); } };
}

test("atom rotates once on load/manual refresh, not background refresh; reduced motion stays still", async () => {
  const h = harness();await flush();
  assert.equal(h.motions.length, 1);assert.equal(h.motions[0].options.duration, 450);
  assert.equal(h.motions[0].frames.at(-1).transform, "rotate(360deg)");
  await h.api.dashboardRefresh.refreshVisible({ force: true });
  assert.equal(h.motions.length, 1);
  h.nodes.get("refresh").listeners.click();await flush();
  assert.equal(h.motions.length, 2);assert.equal(h.motions[0].cancelled, true);
  const reduced = harness({ reduced: true });await flush();
  reduced.nodes.get("refresh").listeners.click();await flush();
  assert.equal(reduced.motions.length, 0);
});

test("source selection refreshes usage and its analytics without touching other resources", async () => {
  const h = harness();await flush();
  const before = h.requests.length;
  const selector = h.nodes.get("usage-provider");selector.value = "m365";selector.listeners.change();await flush();
  assert.equal(h.requests.length, before + 1);assert.match(h.requests.at(-1), /provider=m365/);
  const analytics = h.nodes.get("usage-analytics");analytics.open = true;analytics.listeners.toggle();await flush();
  assert.match(h.requests.at(-1), /analytics=1/);assert.match(h.requests.at(-1), /provider=m365/);
  const calls = h.requests.length;h.nodes.get("analytics-range").listeners.change();assert.equal(h.requests.length, calls);
});

test("language switch preserves unsaved animation, chart nodes/selection and expanded failures without fetching", async () => {
  let copied;
  const h = harness({ language: true, clipboard: async (value) => { copied = value; } });
  await flush();
  h.nodes.get("animation-settings").open = true;
  h.nodes.get("animation-settings").listeners.toggle();
  h.nodes.get("usage-analytics").open = true;
  h.nodes.get("usage-analytics").listeners.toggle();
  await flush();
  h.nodes.get("animation-options").children[1].listeners.click();
  h.visible(true);
  h.nodes.get("analytics-model").value = "test";
  h.nodes.get("analytics-model").listeners.change();
  h.nodes.get("daily-bars").children.at(-1).listeners.click();
  h.api.renderFailures([{ at: "time", model: "test", code: "response.failed", message: "<script>raw source</script>", retried: true }]);
  const failure = h.nodes.get("failures").children[0].children[0];
  failure.open = true;
  const calendar = [...h.nodes.get("activity-calendar").children];
  const requests = h.requests.length;
  const timer = h.api.timer;
  h.nodes.get("language-toggle").listeners.click();
  assert.equal(h.api.selection, "twin");
  assert.equal(h.nodes.get("save-animation").disabled, false);
  assert.match(h.nodes.get("animation-state").textContent, /待保存/);
  assert.equal(h.nodes.get("analytics-model").value, "test");
  assert.equal(h.nodes.get("usage-state").textContent, "2026-10-01");
  assert.equal(h.nodes.get("usage-body").children[0].children[0].textContent, "总用量");
  assert.deepEqual(h.nodes.get("activity-calendar").children, calendar);
  assert.equal(failure.open, true);
  assert.strictEqual(h.api.timer, timer);
  assert.equal(h.requests.length, requests);
  assert.equal(h.nodes.get("provider-auth").children[0].children[2].textContent, "本机已保存");
  assert.match(h.nodes.get("daily-bars").children.at(-1).attributes.title, /已计入输入用量/);
  await failure.children.at(-1).listeners.click();
  assert.match(copied, /message: <script>raw source<\/script>/);
  assert.match(copied, /retry: attempted \(outcome not recorded here\)/);
  h.nodes.get("language-toggle").listeners.click();
  assert.match(h.nodes.get("animation-state").textContent, /UNSAVED/);
  assert.equal(h.nodes.get("usage-body").children[0].children[0].textContent, "TOTAL");
  assert.equal(h.requests.length, requests);
});

test("saved Chinese applies to asynchronous data, counts and later refresh results", async () => {
  const h = harness({ language: true, savedLanguage: "zh" });
  await flush();
  assert.equal(h.nodes.get("connection").textContent, "本机正常");
  assert.equal(h.nodes.get("provider-auth").children[0].children[2].textContent, "本机已保存");
  assert.equal(h.nodes.get("usage-body").children[0].children[0].textContent, "总用量");
  assert.equal(h.nodes.get("usage-body").children[0].children[2].textContent, "100");
  h.nodes.get("refresh").listeners.click();
  await flush();
  assert.equal(h.nodes.get("connection").textContent, "本机正常");
});

test("bilingual animation names preserve numbering, default marker and unsaved choices", async () => {
  const h = harness({ language: true });
  await flush();
  const panel = h.nodes.get("animation-settings");
  panel.open = true;
  panel.listeners.toggle();
  await flush();
  const options = h.nodes.get("animation-options").children;
  const caption = options[0].children[0];
  const marker = caption.children[1];
  assert.equal(caption.children[0].textContent, "01 Comet");
  assert.equal(marker.textContent, "DEFAULT");
  options[1].listeners.click();
  const requests = h.requests.length;
  h.nodes.get("language-toggle").listeners.click();
  assert.equal(caption.children[0].textContent, "01 彗星");
  assert.strictEqual(caption.children[1], marker);
  assert.equal(marker.textContent, "默认");
  assert.equal(options[1].children[0].children[0].textContent, "02 双星");
  assert.equal(h.api.selection, "twin");
  assert.equal(options[1].attributes["aria-pressed"], "true");
  assert.equal(h.nodes.get("animation-state").textContent, "已保存：彗星 / 待保存");
  assert.equal(h.nodes.get("save-animation").disabled, false);
  h.nodes.get("language-toggle").listeners.click();
  assert.equal(caption.children[0].textContent, "01 Comet");
  assert.equal(marker.textContent, "DEFAULT");
  assert.equal(h.nodes.get("animation-state").textContent, "SAVED COMET / UNSAVED");
  assert.equal(h.requests.length, requests);
});

test("English copy and Chinese failures keep raw values, missing states and diagnostic clipboard intact", async () => {
  let copied;
  const h = harness({ language: true, clipboard: async (value) => { copied = value; } });
  await flush();
  assert.equal(h.nodes.get("usage-state").textContent, "LOCAL RECORDS");
  assert.equal(h.nodes.get("connection").textContent, "LOCAL OK");
  h.api.renderFailures([{ at: "time", model: "Comet", code: "response.failed", message: "DEFAULT {input}", retried: false }, {}]);
  h.nodes.get("language-toggle").listeners.click();
  const rows = h.nodes.get("failures").children;
  assert.ok(rows.some((row) => /模型未知/.test(row.children[0].children[0].textContent)));
  const literal = rows.find((row) => /Comet/.test(row.children[0].children[0].textContent)).children[0];
  assert.match(literal.children[0].textContent, /Comet \/ response.failed/);
  await literal.children.at(-1).listeners.click();
  assert.match(copied, /model: Comet/);
  assert.match(copied, /message: DEFAULT \{input\}/);
  assert.match(copied, /retry: not attempted/);
  assert.equal(literal.children.at(-1).textContent, "已复制");
});

test("model HTTP errors localize only the known CCDX message and retain status codes", async () => {
  let message = "Live model lookup failed (HTTP 403). Run ccdx models for details.";
  const h = harness({ language: true, savedLanguage: "zh", fetchFn: (url) => url.includes("/models/")
    ? { ok: false, json: async () => ({ error: message }) } : undefined });
  await flush();
  assert.equal(h.nodes.get("models-state").textContent, "查询失败");
  assert.match(h.nodes.get("models-note").textContent, /模型查询失败：HTTP 403/);
  assert.match(h.nodes.get("models-note").textContent, /ccdx models/);
  const requests = h.requests.length;
  h.nodes.get("language-toggle").listeners.click();
  assert.match(h.nodes.get("models-note").textContent, /Model check failed: HTTP 403/);
  assert.equal(h.requests.length, requests);
  message = "Provider raw failure {status}: response.failed";
  h.nodes.get("refresh-models").listeners.click();
  await flush();
  assert.equal(h.nodes.get("models-note").textContent, message);
});

test("provider authorization renders saved evidence independently of service availability", async () => {
  const h = harness();await flush();
  assert.equal(h.nodes.get("provider-auth").children[0].children[1].textContent, "octocat");
  assert.equal(h.nodes.get("provider-auth").children[0].children[2].textContent, "Saved locally");
  for (const state of ["unconfigured", "unavailable", "authorized", "saved"]) {
    h.api.renderProviders({ providers: [{ id: "example", name: "Example", enabled: true, state: "unavailable",
      auth: { state, account: "literal<script>" }, clients: [] }] });
    const row = h.nodes.get("provider-auth").children[0];
    assert.equal(row.children[1].textContent, "literal<script>");
    assert.equal(row.children[3].textContent, "Unavailable");
    assert.notEqual(row.children[2].textContent, "Ready");
  }
  assert.equal(h.requests.filter(url => url === "/_ccdx/ui/providers").length, 1);
  h.nodes.get("refresh").listeners.click();await flush();
  assert.equal(h.requests.filter(url => url === "/_ccdx/ui/providers").length, 2);
});

test("auth failure and slow auth do not block normal dashboard refresh or cause retry loops", async () => {
  let release;
  const h = harness({ fetchFn: (url) => url === "/_ccdx/ui/providers" ? new Promise((resolve) => { release = resolve; }) : undefined });
  await flush();
  assert.equal(h.nodes.get("connection").textContent, "LOCAL OK");
  assert.equal(h.nodes.get("refresh").disabled, false);
  h.nodes.get("refresh").listeners.click();
  await flush();
  assert.equal(h.requests.filter((url) => url === "/_ccdx/ui/providers").length, 1);
  release({ ok: false, json: async () => ({ error: "secret-error" }) });
  await flush();
  assert.equal(h.nodes.get("auth-account").textContent, "UNAVAILABLE");
  assert.equal(h.nodes.get("connection").textContent, "LOCAL OK");
  assert.equal(h.requests.filter((url) => url === "/_ccdx/ui/providers").length, 1);
});

test("animation is lazy, stops while collapsed, and keeps unsaved choices on reopen", async () => {
  const h = harness();
  await flush();
  assert.ok(h.requests.includes("/_ccdx/ui/animation?frames=0"));
  assert.equal(h.requests.includes("/_ccdx/ui/animation"), false);
  assert.equal(h.timers.size, 0);
  const panel = h.nodes.get("animation-settings");
  panel.open = true;
  panel.listeners.toggle();
  await flush();
  h.visible(true);
  assert.equal(h.timers.size, 1);
  h.nodes.get("animation-options").children[1].listeners.click();
  assert.equal(h.api.selection, "twin");
  assert.match(h.nodes.get("animation-state").textContent, /UNSAVED/);
  panel.open = false;
  panel.listeners.toggle();
  assert.equal(h.timers.size, 0);
  panel.open = true;
  panel.listeners.toggle();
  await flush();
  assert.equal(h.api.selection, "twin");
  assert.equal(h.requests.filter((url) => url === "/_ccdx/ui/animation").length, 1);
});

test("analytics loads only on opening; client filters and day selection do not read logs again", async () => {
  const h = harness();
  await flush();
  assert.equal(h.requests.filter((url) => url.includes("analytics=1")).length, 0);
  const panel = h.nodes.get("usage-analytics");
  panel.open = true;
  panel.listeners.toggle();
  await flush();
  assert.equal(h.nodes.get("daily-bars").children.length, 30);
  assert.equal(h.nodes.get("activity-calendar").children.filter((node) => node.tag === "button").length, 365);
  const monthColumns = h.nodes.get("calendar-months").children.map((node) => Number.parseInt(node.style.gridColumn, 10));
  assert.ok(monthColumns.every((column, index) => index === 0 || column - monthColumns[index - 1] >= 4));
  assert.ok(monthColumns.at(-1) + 3 <= 53);
  const calls = h.requests.length;
  h.nodes.get("analytics-range").value = "90";
  h.nodes.get("analytics-range").listeners.change();
  assert.equal(h.nodes.get("daily-bars").children.length, 90);
  const button = h.nodes.get("daily-bars").children.at(-1);
  assert.equal(button.children[0].style.height, `${10 / 110 * 100}%`);
  assert.equal(button.children[1].style.height, `${100 / 110 * 100}%`);
  button.listeners.click();
  assert.equal(h.nodes.get("usage-state").textContent, "2026-10-01");
  assert.equal(h.nodes.get("clear-usage-day").hidden, false);
  h.nodes.get("analytics-model").value = "missing-model";
  h.nodes.get("analytics-model").listeners.change();
  assert.equal(h.nodes.get("usage-body").children[0].children[0].textContent, "No usage records.");
  h.nodes.get("analytics-model").value = "test";
  h.nodes.get("analytics-model").listeners.change();
  assert.equal(h.nodes.get("usage-body").children.length, 2);
  h.nodes.get("clear-usage-day").listeners.click();
  assert.equal(h.nodes.get("usage-state").textContent, "LOCAL LOG");
  assert.equal(h.requests.length, calls);
  panel.open = false;
  panel.listeners.toggle();
  panel.open = true;
  panel.listeners.toggle();
  await flush();
  assert.equal(h.requests.length, calls);
});

test("reduced motion suppresses animation timers even with open and visible settings", async () => {
  const h = harness({ reduced: true });
  await flush();
  h.nodes.get("animation-settings").open = true;
  h.nodes.get("animation-settings").listeners.toggle();
  await flush();
  h.visible(true);
  assert.equal(h.timers.size, 0);
});

test("usage opening during initial load follows up once and an analytics error does not loop", async () => {
  let release;
  const h = harness({ fetchFn: (url) => url === "/_ccdx/ui/usage" ? new Promise((resolve) => { release = resolve; }) : url.includes("analytics=1") ? { ok: false, json: async () => ({ error: "failed" }) } : undefined });
  await flush();
  h.nodes.get("usage-analytics").open = true;
  h.nodes.get("usage-analytics").listeners.toggle();
  release({ ok: true, json: async () => ({ source: "local_usage_log", total: { requests: 0 }, rows: [], model_count: 0 }) });
  await flush();
  await flush();
  assert.equal(h.requests.filter((url) => url.includes("analytics=1")).length, 1);
  assert.match(h.nodes.get("analytics-note").textContent, /unavailable/);
});

test("opening during metadata load follows up once; failed frame requests never auto-loop", async () => {
  let release;
  const h = harness({ fetchFn: (url) => url.includes("frames=0") ? new Promise((resolve) => { release = resolve; }) : url === "/_ccdx/ui/animation" ? { ok: false, json: async () => ({ error: "failed" }) } : undefined });
  await flush();
  h.nodes.get("animation-settings").open = true;
  h.nodes.get("animation-settings").listeners.toggle();
  release({ ok: true, json: async () => ({ theme: "comet", themes: [] }) });
  await flush();
  await flush();
  assert.equal(h.requests.filter((url) => url === "/_ccdx/ui/animation").length, 1);
  assert.equal(h.nodes.get("animation-state").textContent, "UNAVAILABLE");
  assert.equal(h.timers.size, 0);
});

test("failure details are text-only, preserve expansion and copy only existing diagnostic fields", async () => {
  let copied;
  const h = harness({ clipboard: async (value) => { copied = value; } });
  await flush();
  const failures = Array.from({ length: 11 }, (_, index) => ({ at: `time${index}`, model: "test", code: "failure", message: "<script>alert(1)</script>", response_id: `response${index}`, upstream_request_id: "request", retried: true, token: "excluded", prompt: "excluded" }));
  h.api.renderFailures(failures);
  const list = h.nodes.get("failures");
  assert.equal(list.children.length, 10);
  const details = list.children[0].children[0];
  details.open = true;
  assert.match(details.children[0].textContent, /retry attempted/);
  await details.children.at(-1).listeners.click();
  assert.match(copied, /<script>alert\(1\)<\/script>/);
  assert.match(copied, /outcome not recorded here/);
  assert.doesNotMatch(copied, /excluded/);
  h.api.renderFailures(failures);
  assert.equal(list.children[0].children[0].open, true);
});

test("background, auto-off and collapsed groups do not poll; a visible stale page catches up once", async () => {
  const h = harness(); await flush();
  const initial = h.requests.length;
  h.hidden(true); h.advance(1800000 * 3);
  assert.equal(h.scheduled.size, 0);
  assert.equal(h.requests.length, initial);
  h.nodes.get("upstream-models").open = false;
  h.nodes.get("model-usage").open = false;
  h.hidden(false); await flush();
  assert.equal(h.requests.length, initial + 2);
  h.hidden(false); await flush();
  assert.equal(h.requests.length, initial + 2);
  h.nodes.get("auto-refresh").listeners.click();
  assert.equal(h.nodes.get("auto-refresh").attributes["aria-pressed"], "false");
  h.hidden(true); h.advance(1800000); h.hidden(false); await flush();
  assert.equal(h.requests.length, initial + 2);
  h.nodes.get("request-context").open = true;
  h.nodes.get("request-context").listeners.toggle(); await flush();
  assert.equal(h.requests.length, initial + 3);
  h.event("pagehide");
  assert.equal(h.scheduled.size, 0);
});

test("unchanged refresh keeps model, usage and chart nodes, filters, selected day and unsaved animation", async () => {
  const h = harness(); await flush();
  h.nodes.get("usage-analytics").open = true;
  h.nodes.get("usage-analytics").listeners.toggle();
  h.nodes.get("animation-settings").open = true;
  h.nodes.get("animation-settings").listeners.toggle(); await flush();
  h.nodes.get("animation-options").children[1].listeners.click();
  h.nodes.get("analytics-range").value = "90";
  h.nodes.get("analytics-model").value = "test";
  h.nodes.get("analytics-metric").value = "tokens";
  h.api.selectUsageDay("2026-10-01");
  const calendar = [...h.nodes.get("activity-calendar").children];
  const usage = [...h.nodes.get("usage-body").children];
  const models = [...h.nodes.get("live-models-body").children];
  h.nodes.get("refresh").listeners.click(); await flush();
  assert.equal(h.nodes.get("usage-state").textContent, "2026-10-01");
  assert.equal(h.nodes.get("analytics-model").value, "test");
  assert.equal(h.nodes.get("analytics-range").value, "90");
  assert.deepEqual(h.nodes.get("activity-calendar").children, calendar);
  assert.deepEqual(h.nodes.get("usage-body").children, usage);
  assert.deepEqual(h.nodes.get("live-models-body").children, models);
  assert.equal(h.api.selection, "twin");
  assert.equal(h.nodes.get("save-animation").disabled, false);
  assert.equal(h.requests.filter(url => url === "/_ccdx/ui/animation").length, 1);
});

test("failed refresh preserves prior rows and account without marking them as fresh", async () => {
  let failed = false;
  const h = harness({ fetchFn: url => failed && (url.includes("/usage") || url.includes("/models/") || url.includes("/providers"))
    ? { ok: false, json: async () => ({ error: "offline" }) } : undefined }); await flush();
  const rows = [...h.nodes.get("usage-body").children];
  const models = [...h.nodes.get("live-models-body").children];
  const time = h.api.dashboardRefresh.state("usage").updatedAt;
  failed = true; h.advance(30001);
  h.nodes.get("refresh").listeners.click(); await flush();
  assert.deepEqual(h.nodes.get("usage-body").children, rows);
  assert.deepEqual(h.nodes.get("live-models-body").children, models);
  assert.equal(h.api.dashboardRefresh.state("usage").updatedAt, time);
  assert.match(h.nodes.get("auth-account").textContent, /Update failed/);
  assert.equal(h.nodes.get("models-state").textContent, "LIVE LOOKUP FAILED");
  assert.equal(h.nodes.get("connection").textContent, "LOCAL OK");
});

test("saved auto-off stays off and sparse heatmap levels follow actual relative values", async () => {
  const h = harness({ savedAutomatic: "off" }); await flush();
  assert.equal(h.scheduled.size, 0);
  assert.equal(h.nodes.get("auto-refresh").attributes["aria-pressed"], "false");
  h.nodes.get("usage-analytics").open = true;
  h.nodes.get("usage-analytics").listeners.toggle(); await flush();
  const levels = h.nodes.get("activity-calendar").children.filter(node => node.tag === "button").map(node => node.dataset.level);
  assert.equal(levels.at(-1), "4");
  assert.ok(levels.slice(0, -1).every(level => level === "0"));
});

test("failure timelines correlate recovered events and include transport failures without extra requests", async () => {
  let copied;
  const h = harness({ language: true, savedLanguage: "zh", clipboard: async (value) => { copied = value; } });
  await flush();
  const requestCount = h.requests.length;
  const requests = [{ request_id: "local-1", at: "2026-10-05T00:00:00Z", model: "gpt-6-astra",
    outcome: "completed", origin: "upstream_response", phase: "upstream_stream", failed: false,
    http_status: 200, upstream_attempts: 2, timings_ms: { upstream_start: 10, first_output: 50, finished: 100, token: "excluded" } },
  { request_id: "local-2", at: "2026-10-05T00:01:00Z", model: "gpt-5.6-sol", outcome: "unknown",
    origin: "transport", phase: "upstream_stream", failed: true, http_status: 200, upstream_attempts: 1,
    timings_ms: { last_activity: 500, finished: 120500 }, prompt: "excluded" }];
  const failures = [{ request_id: "local-1", at: "2026-10-05T00:00:01Z", response_id: "resp-1",
    model: "gpt-6-astra", event_type: "response.failed", code: "encrypted-replay", message: "upstream {input}", retried: true }];
  h.api.renderFailures(failures, requests);
  const list = h.nodes.get("failures");
  assert.equal(list.children.length, 2);
  const detail = list.children[0].children[0];
  detail.open = true;
  await detail.children.at(-1).listeners.click();
  assert.match(copied, /request_id: local-2/);
  assert.match(copied, /origin: transport/);
  assert.match(copied, /last_activity=500.0/);
  assert.match(copied, /http_status: 200/);
  assert.doesNotMatch(copied, /excluded/);
  h.api.renderFailures(failures, requests);
  assert.equal(list.children[0].children[0].open, true);
  await list.children[1].children[0].children.at(-1).listeners.click();
  assert.match(copied, /outcome: completed/);
  assert.match(copied, /upstream_attempts: 2/);
  assert.match(copied, /upstream \{input\}/);
  assert.equal(h.requests.length, requestCount);
});

test("provider tabs abort stale responses, retain independent catalogs and survive provider removal", async () => {
  let release, providers = ["github", "third"].map(id => ({ id, name: id, enabled: true, auth: {},
    clients: [{ id: "codex", name: "Codex App", selected: id === "github", state: "configured" }] }));
  const h = harness({ fetchFn: async url => {
    if (url === "/_ccdx/ui/providers") return { ok: true, json: async () => ({ source: "provider_status", providers }) };
    if (!url.includes("/models/")) return;
    const id = url.includes("provider=third") ? "third" : "github";
    if (id === "third") await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ source: "live", selectable: 1, advertised: 1, models: [{ id: `${id}-model`, vendor: id, endpoints: [] }] }) };
  } });await flush();
  const buttons = h.nodes.get("model-providers").children;
  buttons[1].listeners.click();await flush();
  buttons[0].listeners.click();await flush();
  assert.equal(h.nodes.get("live-models-body").children[0].children[0].textContent, "github-model");
  release();await flush();
  assert.equal(h.nodes.get("live-models-body").children[0].children[0].textContent, "github-model");
  providers = providers.slice(0, 1);await h.api.loadAuth();
  assert.equal(h.nodes.get("model-providers").children.length, 1);
  assert.equal(h.nodes.get("source-detail").textContent, "Codex App → github");
});

test("account generation changes invalidate even a first in-flight catalog without a saved snapshot", async () => {
  let generation = 1, releaseOld, calls = 0;
  const h = harness({ fetchFn: async url => {
    if (url === "/_ccdx/ui/providers") return { ok: true, json: async () => ({ source: "provider_status", providers: [
      { id: "github", generation, name: "GitHub Copilot", enabled: true, auth: {}, clients: [{ id: "codex", name: "Codex App", selected: true }] },
    ] }) };
    if (!url.includes("/models/")) return;
    const old = ++calls === 1;
    if (old) await new Promise(resolve => { releaseOld = resolve; });
    return { ok: true, json: async () => ({ source: "live", models: [{ id: old ? "old-account-model" : "new-account-model", endpoints: [] }] }) };
  } });await flush();
  generation = 2;await h.api.loadAuth();await flush();
  releaseOld();await flush();
  assert.equal(h.nodes.get("live-models-body").children[0].children[0].textContent, "new-account-model");
  assert.equal(calls, 2);
});

test("filtering one historical source retains the other historical source options", async () => {
  const h = harness({ fetchFn: async url => url.includes("/usage") ? { ok: true, json: async () => ({ source: "local_usage_log",
    provider: url.includes("provider=retired_a") ? "retired_a" : "all", providers: url.includes("provider=retired_a") ? { retired_a: 1 } : { retired_a: 1, retired_b: 1 },
    total: { requests: 1 }, rows: [], model_count: 0 }) } : undefined });await flush();
  const selector = h.nodes.get("usage-provider");selector.value = "retired_a";selector.listeners.change();await flush();
  assert.ok(selector.children.some(option => option.value === "retired_b"));
});
