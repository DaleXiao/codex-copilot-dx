import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { createUsageAnalytics } from "../src/usage-analytics.mjs";
import { summarizeUsage } from "../src/usage.mjs";

const script = readFileSync(new URL("../src/dashboard/ui.js", import.meta.url), "utf8");
const languageScript = readFileSync(new URL("../src/dashboard/language.js", import.meta.url), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

class Node {
  constructor(tag = "div") { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.listeners = {}; this.attributes = {}; this.open = false; this.value = ""; this.textContent = ""; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  hasAttribute(key) { return Object.hasOwn(this.attributes, key); }
  addEventListener(event, fn) { this.listeners[event] = fn; }
  querySelectorAll(selector) { return this.children.flatMap((node) => [...(selector === "details[open]" && node.tag === "details" && node.open ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector() { return new Node("summary"); }
  scrollIntoView() {}
  focus() {}
}

function harness({ fetchFn, clipboard = async () => {}, reduced = false, language = false, savedLanguage = "en" } = {}) {
  const nodes = new Map();
  const ready = [];
  const document = { documentElement: { dataset: {} }, visibilityState: "visible", getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); }, createElement: (tag) => new Node(tag), createDocumentFragment: () => new Node(), addEventListener(event, fn) { if (event === "DOMContentLoaded") ready.push(fn); },
    querySelectorAll() {
      const found = new Set();
      const visit = (node) => { if (Object.keys(node.attributes).some((key) => key.startsWith("data-i18n"))) found.add(node); node.children.forEach(visit); };
      nodes.forEach(visit);
      return [...found];
    },
  };
  document.getElementById("analytics-range").value = "30";
  document.getElementById("analytics-metric").value = "requests";
  const records = [{ ts: "2026-10-01T00:00:00Z", model: "test", usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, total_tokens: 110 } }];
  const collector = createUsageAnalytics({ now: Date.parse("2026-10-01T12:00:00Z") });
  records.forEach((row) => collector.record(row, summarizeUsage([row])));
  const usage = { source: "local_usage_log", total: { model: "TOTAL", requests: 1, input_tokens: 100, output_tokens: 10, total_tokens: 110 }, rows: [], model_count: 1 };
  const themes = { theme: "comet", themes: ["comet", "twin"].map((id) => ({ id, label: id, frames: [{ ansi: "x", delay_ms: 50 }], loop_pause_ms: 50 })) };
  const requests = [];
  const timers = new Set();
  let observer;
  const context = createContext({
    document, window: { matchMedia: () => ({ matches: reduced, addEventListener() {} }) }, navigator: { clipboard: { writeText: clipboard } },
    performance: { now: () => 0 }, AbortSignal, Intl, setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); },
    localStorage: { getItem: () => savedLanguage, setItem() {} },
    IntersectionObserver: class { constructor(fn) { observer = fn; } observe() {} },
    fetch: async (url, options) => {
      requests.push(url);
      if (fetchFn) { const response = await fetchFn(url, options); if (response) return response; }
      const data = url === "/_ccdx/status" ? { ok: true, name: "codex-copilot-dx" }
        : url === "/_ccdx/ui/auth" ? { source: "local_auth_status", configured: true, valid: true, login: "octocat" }
        : url.includes("/models/") ? { source: "live", models: [] }
        : url.includes("/usage") ? { ...usage, ...(url.includes("analytics=1") ? { analytics: collector.snapshot() } : {}) }
        : url.includes("frames=0") ? { ...themes, themes: themes.themes.map(({ id, label }) => ({ id, label })) } : themes;
      return { ok: true, json: async () => data };
    },
  });
  if (language) runInContext(languageScript, context);
  const api = runInContext(`${script}\n({ renderFailures, renderAuth, loadAuth, loadAnimation, loadUsage, renderAnalytics, selectUsageDay, get timer() { return previewTimer; }, get selection() { return selectedAnimation; } });`, context);
  ready.forEach((fn) => fn());
  return { api, nodes, requests, timers, visible(value) { observer([{ isIntersecting: value }]); } };
}

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
  assert.match(h.nodes.get("animation-state").textContent, /未保存/);
  assert.equal(h.nodes.get("analytics-model").value, "test");
  assert.equal(h.nodes.get("usage-state").textContent, "2026-10-01");
  assert.equal(h.nodes.get("usage-body").children[0].children[0].textContent, "合计");
  assert.deepEqual(h.nodes.get("activity-calendar").children, calendar);
  assert.equal(failure.open, true);
  assert.strictEqual(h.api.timer, timer);
  assert.equal(h.requests.length, requests);
  assert.match(h.nodes.get("auth-account").textContent, /@octocat \/ 已保存/);
  assert.match(h.nodes.get("daily-bars").children.at(-1).attributes.title, /已包含在输入中/);
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
  assert.equal(h.nodes.get("auth-account").textContent, "GitHub / @octocat / 已保存");
  assert.equal(h.nodes.get("usage-body").children[0].children[0].textContent, "合计");
  assert.equal(h.nodes.get("usage-body").children[0].children[2].textContent, "100");
  h.nodes.get("refresh").listeners.click();
  await flush();
  assert.equal(h.nodes.get("connection").textContent, "本机正常");
});

test("dashboard auth renders saved username and fallbacks without claiming online validation", async () => {
  const h = harness();
  await flush();
  assert.equal(h.nodes.get("auth-account").textContent, "GitHub / @octocat / SAVED");
  for (const [data, expected] of [
    [{ configured: false }, "GitHub / NOT CONFIGURED"],
    [{ configured: true, valid: false }, "GitHub / INVALID"],
    [{ configured: true, valid: false, reason: "credential_read_failed" }, "GitHub / UNAVAILABLE"],
    [{ configured: true, valid: true }, "GitHub / account unknown / SAVED"],
    [{ configured: true, valid: true, id: "7" }, "GitHub / ID 7 / SAVED"],
    [{ configured: true, valid: true, login: "dingxiao_microsoft", id: "7" }, "GitHub / @dingxiao_microsoft / SAVED"],
  ]) { h.api.renderAuth(data); assert.equal(h.nodes.get("auth-account").textContent, expected); }
  assert.equal(h.requests.filter((url) => url === "/_ccdx/ui/auth").length, 1);
  h.nodes.get("refresh").listeners.click();
  await flush();
  assert.equal(h.requests.filter((url) => url === "/_ccdx/ui/auth").length, 2);
});

test("auth failure and slow auth do not block normal dashboard refresh or cause retry loops", async () => {
  let release;
  const h = harness({ fetchFn: (url) => url === "/_ccdx/ui/auth" ? new Promise((resolve) => { release = resolve; }) : undefined });
  await flush();
  assert.equal(h.nodes.get("connection").textContent, "LOCAL OK");
  assert.equal(h.nodes.get("refresh").disabled, false);
  h.nodes.get("refresh").listeners.click();
  await flush();
  assert.equal(h.requests.filter((url) => url === "/_ccdx/ui/auth").length, 1);
  release({ ok: false, json: async () => ({ error: "secret-error" }) });
  await flush();
  assert.equal(h.nodes.get("auth-account").textContent, "GitHub / UNAVAILABLE");
  assert.equal(h.nodes.get("connection").textContent, "LOCAL OK");
  assert.equal(h.requests.filter((url) => url === "/_ccdx/ui/auth").length, 1);
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
  h.nodes.get("animation-settings").open = true;
  h.nodes.get("animation-settings").listeners.toggle();
  release({ ok: true, json: async () => ({ theme: "comet" }) });
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
