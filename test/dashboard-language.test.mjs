import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
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
  assert.equal(page.nodes.get("heading").textContent, "USAGE");
  assert.equal(page.nodes.get("language-toggle").textContent, "中文");
  page.toggle();
  assert.equal(page.root.lang, "zh-CN");
  assert.equal(page.nodes.get("heading").textContent, "用量");
  assert.equal(page.nodes.get("language-toggle").textContent, "EN");
  assert.equal(saved.get("ccdx.dashboard.language"), "zh");
  assert.equal(saved.get("ccdx.dashboard.theme"), "light");
  assert.equal(load({ saved }).root.lang, "zh-CN");
  page.toggle();
  assert.equal(page.nodes.get("heading").textContent, "USAGE");
  assert.equal(load({ saved }).root.lang, "en");
  assert.equal(load({ saved: new Map([["ccdx.dashboard.language", "unexpected"]]) }).root.lang, "en");
});

test("language remains usable when storage is blocked", () => {
  const page = load({ blocked: true });
  page.toggle();
  assert.equal(page.nodes.get("heading").textContent, "用量");
  page.toggle();
  assert.equal(page.nodes.get("heading").textContent, "USAGE");
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
  assert.equal(target.textContent, "成功 1,234 次");
  page.toggle();
  assert.equal(target.textContent, "1,234 succeeded");
  page.language.set(target, "{date} / {description}", { date: "2026-10-02", description: { key: "no retained history" } }, "title");
  page.toggle();
  assert.equal(target.getAttribute("title"), "2026-10-02 / 无留存历史");
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
  assert.equal(button.getAttribute("aria-label"), "切换为日间模式");
  assert.equal(favicon.href, original);
  button.click();
  assert.equal(button.getAttribute("aria-label"), "切换为夜间模式");
  assert.equal(page.root.dataset.theme, "light");
  const light = favicon.href;
  page.toggle();
  assert.equal(button.getAttribute("aria-label"), "Switch to dark mode");
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
