import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const script = readFileSync(new URL("../src/dashboard/theme.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../src/dashboard/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/dashboard/ui.css", import.meta.url), "utf8");

function loadTheme(storage) {
  const listeners = new Map();
  const root = { dataset: {} };
  const button = {
    title: "",
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, callback) { this[name] = callback; },
  };
  const document = {
    documentElement: root,
    addEventListener(name, callback) { listeners.set(name, callback); },
    getElementById() { return button; },
  };
  runInNewContext(script, { document, localStorage: storage });
  listeners.get("DOMContentLoaded")();
  return { root, button };
}

test("dashboard defaults to the existing dark theme and switches without a server call", () => {
  const saved = new Map();
  const storage = {
    getItem(key) { return saved.get(key) || null; },
    setItem(key, value) { saved.set(key, value); },
  };
  const { root, button } = loadTheme(storage);
  assert.equal(root.dataset.theme, "dark");
  assert.equal(button["aria-label"], "Switch to light mode");
  button.click();
  assert.equal(root.dataset.theme, "light");
  assert.equal(button["aria-label"], "Switch to dark mode");
  assert.equal(saved.get("ccdx.dashboard.theme"), "light");
  button.click();
  assert.equal(root.dataset.theme, "dark");
  assert.equal(saved.get("ccdx.dashboard.theme"), "dark");
});

test("dashboard restores light mode before the stylesheet loads and tolerates unavailable storage", () => {
  const persisted = loadTheme({ getItem: () => "light", setItem() {} });
  assert.equal(persisted.root.dataset.theme, "light");
  assert.equal(persisted.button["aria-label"], "Switch to dark mode");
  const blocked = loadTheme({ getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } });
  assert.equal(blocked.root.dataset.theme, "dark");
  blocked.button.click();
  assert.equal(blocked.root.dataset.theme, "light");
});

test("dashboard uses inline SVG sun in dark mode and moon in light mode", () => {
  assert.match(html, /<script src="\/theme\.js"><\/script>[\s\S]*<link rel="stylesheet"/);
  assert.match(html, /class="icon-sun"[^>]*aria-hidden="true"/);
  assert.match(html, /class="icon-moon"[^>]*aria-hidden="true"/);
  assert.match(css, /\.icon-moon, :root\[data-theme="light"\] \.icon-sun \{ display: none; \}/);
  assert.match(css, /:root\[data-theme="light"\] \.icon-moon \{ display: block; \}/);
});
