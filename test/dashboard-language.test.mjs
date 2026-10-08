import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext, runInNewContext } from "node:vm";
import test from "node:test";

const languageScript = readFileSync(new URL("../src/dashboard/language.js", import.meta.url), "utf8");
const themeScript = readFileSync(new URL("../src/dashboard/theme.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../src/dashboard/index.html", import.meta.url), "utf8");

function node(textContent = "", attributes = {}) {
  return { textContent, attributes: { ...attributes }, dataset: {}, children: [],
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); },
    addEventListener(name, fn) { this[name] = fn; } };
}

function load({ saved = new Map(), blocked = false, theme = false } = {}) {
  const nodes = new Map([["language-toggle", node("中文")], ["theme-toggle", node()], ["favicon", node()], ["heading", node("USAGE", { "data-i18n": "" })]]);
  const root = { dataset: {} };
  const ready = [];
  const document = { documentElement: root, getElementById: (id) => nodes.get(id),
    querySelectorAll: () => [...nodes.values()].filter((item) => Object.keys(item.attributes).some((key) => key.startsWith("data-i18n"))),
    addEventListener(name, fn) { if (name === "DOMContentLoaded") ready.push(fn); } };
  const context = createContext({ document, localStorage: {
    getItem(key) { if (blocked) throw new Error("blocked"); return saved.get(key); },
    setItem(key, value) { if (blocked) throw new Error("blocked"); saved.set(key, value); },
  }, encodeURIComponent });
  runInContext(languageScript, context);
  if (theme) runInContext(themeScript, context);
  ready.forEach((fn) => fn());
  return { nodes, root, context, saved, language: context.ccdxLanguage, toggle: () => nodes.get("language-toggle").click() };
}

test("language defaults to English, restores Chinese and persists only its own preference", () => {
  const saved = new Map([["ccdx.dashboard.theme", "light"]]);
  const page = load({ saved });
  assert.equal(page.root.lang, "en");
  assert.equal(page.nodes.get("heading").textContent, "MODEL USAGE");
  assert.equal(page.nodes.get("language-toggle").textContent, "中文");
  page.toggle();
  assert.equal(page.root.lang, "zh-CN");
  assert.equal(page.nodes.get("heading").textContent, "模型用量");
  assert.equal(page.nodes.get("language-toggle").textContent, "EN");
  assert.equal(saved.get("ccdx.dashboard.language"), "zh");
  assert.equal(saved.get("ccdx.dashboard.theme"), "light");
  assert.equal(load({ saved }).root.lang, "zh-CN");
  page.toggle();
  assert.equal(page.nodes.get("heading").textContent, "MODEL USAGE");
  assert.equal(load({ saved }).root.lang, "en");
  assert.equal(load({ saved: new Map([["ccdx.dashboard.language", "unexpected"]]) }).root.lang, "en");
});

test("language remains usable when storage is blocked", () => {
  const page = load({ blocked: true });
  page.toggle();
  assert.equal(page.nodes.get("heading").textContent, "模型用量");
  page.toggle();
  assert.equal(page.nodes.get("heading").textContent, "MODEL USAGE");
});

test("dynamic templates translate in place, preserve literal data and do not evaluate markup or placeholders", () => {
  const page = load();
  const target = node();
  page.nodes.set("dynamic", target);
  const account = "@user_1<script>{count}</script>";
  page.language.set(target, "GitHub / {account} / SAVED", { account });
  target.open = true;
  target.value = "unchanged";
  page.toggle();
  assert.equal(target.textContent, `GitHub / ${account} / 已保存`);
  assert.equal(target.open, true);
  assert.equal(target.value, "unchanged");
  page.language.set(target, "{count} succeeded", { count: "1,234" });
  assert.equal(target.textContent, "成功：1,234次");
  page.toggle();
  assert.equal(target.textContent, "1,234 succeeded");
  page.language.set(target, "{date} / {description}", { date: "2026-10-02", description: { key: "no retained history" } }, "title");
  page.toggle();
  assert.equal(target.getAttribute("title"), "2026-10-02 / 没有记录");
  const rawError = "Unknown upstream event {input} {constructor}";
  page.language.set(target, rawError);
  assert.equal(target.textContent, rawError);
  page.toggle();
  assert.equal(target.textContent, rawError);
});

test("language and theme labels stay independent and switching language does not regenerate the favicon", () => {
  const page = load({ theme: true });
  const button = page.nodes.get("theme-toggle");
  const favicon = page.nodes.get("favicon");
  const original = favicon.href;
  page.toggle();
  assert.equal(button.getAttribute("aria-label"), "白天模式");
  assert.equal(favicon.href, original);
  button.click();
  assert.equal(button.getAttribute("aria-label"), "夜间模式");
  assert.equal(page.root.dataset.theme, "light");
  const light = favicon.href;
  page.toggle();
  assert.equal(button.getAttribute("aria-label"), "Dark mode");
  assert.equal(favicon.href, light);
});

test("all annotated static English prose has a Chinese translation and the switch follows the theme button", () => {
  const page = load({ saved: new Map([["ccdx.dashboard.language", "zh"]]) });
  const keys = [...html.matchAll(/<[^>]+\sdata-i18n(?=\s|>)[^>]*>([^<]+)<\//g)].map((match) => match[1]);
  for (const tag of html.match(/<[^>]+>/g)) {
    if (tag.includes("data-i18n-label")) keys.push(/aria-label="([^"]+)"/.exec(tag)[1]);
    if (tag.includes("data-i18n-title")) keys.push(/title="([^"]+)"/.exec(tag)[1]);
  }
  assert.ok(keys.length > 60);
  for (const key of keys) assert.notEqual(page.language.format(key), key, `Untranslated: ${key}`);
  assert.match(html, /id="theme-toggle"[\s\S]*?<\/button><button id="language-toggle"/);
  assert.ok(html.indexOf('/language.js') < html.indexOf('/theme.js'));
  assert.doesNotMatch(languageScript, /fetch\(|setTimeout\(|setInterval\(|MutationObserver|innerHTML/);
});

test("bilingual copy preserves every placeholder and keeps Chinese descriptions short", () => {
  const dictionary = runInNewContext(`(${/const translations = (\{[\s\S]*?\n  \});/.exec(languageScript)[1]})`);
  const placeholders = (text) => [...new Set(text.match(/\{\w+\}/g) || [])].sort();
  assert.ok(Object.keys(dictionary).length >= 180);
  for (const [key, pair] of Object.entries(dictionary)) {
    assert.equal(pair.length, 2, key);
    for (const value of pair) {
      assert.equal(typeof value, "string", key);
      assert.ok(value.length, key);
      assert.deepEqual(placeholders(value), placeholders(key), `Changed values: ${key}`);
    }
    for (const line of pair[1].replace(/\{\w+\}/g, "").split("\n")) {
      if (line === "CCDX_TERMINAL_ANIMATION") continue;
      assert.ok([...line].length <= 20, `Long Chinese copy: ${line}`);
    }
  }
});

test("Chinese functional names are 2–4 characters while English uses the same meanings", () => {
  const page = load();
  const names = ["RECENT REQUEST CONTEXT", "ADAPTER", "KNOWN MODELS", "REQUESTS", "MODEL OUTCOMES", "LOCAL HISTORY", "ACTIVE LIMIT", "IMAGE GENERATION", "OPTIONAL", "UPSTREAM GPT MODELS", "USAGE", "USAGE ANALYTICS", "RECENT RESPONSE FAILURES", "TERMINAL ANIMATION", "Save selection", "All history", "Copy diagnostic", "WIRE MiB", "INPUT TOKENS", "MODEL WINDOW", "INPUT / WINDOW", "CACHE READ", "CACHE HIT", "DAILY TOKENS", "REQUEST ACTIVITY · 365 DAYS", "Comet", "Twin", "Shuttle", "Chase", "Mirror", "Pulse", "Stack", "Relay", "Split"];
  assert.equal(page.language.format("CACHE HIT"), "REUSE RATE");
  assert.equal(page.language.format("LOCAL HISTORY"), "LOCAL HISTORY");
  assert.equal(page.language.format("message"), "Error details");
  page.toggle();
  for (const key of names) {
    const size = [...page.language.format(key)].length;
    assert.ok(size >= 2 && size <= 4, key);
  }
  assert.equal(page.language.format("CACHE HIT"), "重用比例");
  assert.equal(page.language.format("LOCAL HISTORY"), "对话暂存");
  assert.match(page.language.format("HTTP 2xx != model completed."), /HTTP 2xx/);
  assert.equal(page.language.format("NOT INITIALIZED"), "尚未确认");
  for (const literal of ["constructor", "toString", "__proto__", "gpt-6.1-sol", "upstream_response", "response.failed"]) {
    assert.equal(page.language.format(literal), literal);
  }
  const reuseHint = page.language.format("Cache hit = recorded cached / input tokens. ~ = incomplete history. — = unavailable or invalid counts.");
  assert.match(reuseHint, /Token/);
  assert.match(reuseHint, /~.*不完整/);
  assert.match(reuseHint, /—.*未知或无效/);
});
