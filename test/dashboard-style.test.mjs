import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { invokeAdapter } from "../test-support/adapter.mjs";

const css = readFileSync(new URL("../src/dashboard/ui.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../src/dashboard/index.html", import.meta.url), "utf8");

test("every script and stylesheet referenced by the dashboard is served", async () => {
  for (const match of html.matchAll(/(?:src|href)="(\/[a-z-]+\.(?:js|css))"/g)) {
    const response = await invokeAdapter({}, { method: "GET", url: match[1], headers: { host: "127.0.0.1:2026" } });
    assert.equal(response.status, 200, match[1]);assert.ok(response.text.length > 0);
  }
});

test("dashboard section headings share typography, including collapsible context and analytics", () => {
  assert.match(css, /\.card h2, \.panel h2, \.lower h2, \.panel > summary, \.analytics-section > summary \{[^}]*color: var\(--heading\); font-size: 11px; font-weight: 700; letter-spacing: \.08em; line-height: 1\.6; margin: 0;/);
  assert.match(css, /table \{[^}]*font-size: 11px;/);
  assert.match(css, /\.hint \{[^}]*font-size: 11px;/);
  assert.match(css, /\.table-note \{[^}]*font-size: 11px;/);
});

test("all native disclosures use one chevron rule without duplicate markers", () => {
  assert.match(css, /details > summary \{[^}]*grid-template-columns: auto minmax\(0, 1fr\);[^}]*list-style: none;/);
  assert.match(css, /details > summary::-webkit-details-marker \{ display: none; \}/);
  assert.match(css, /details > summary::marker \{ content: ""; \}/);
  assert.match(css, /details > summary::before \{ content: "";[^}]*mask: url\("data:image\/svg\+xml/);
  assert.match(css, /details\[open\]:not\(\[data-disclosure-closing\]\) > summary::before \{ transform: rotate\(180deg\); \}/);
  assert.doesNotMatch(css, /content: "[+−]"/);
  assert.doesNotMatch(css, /summary h2::before/);
  assert.match(css, /\.settings-panel > summary \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\) auto; \}/);
  assert.match(css, /summary:focus-visible, select:focus-visible \{ outline: 2px solid var\(--accent\);/);
  for (const id of ["client-features", "request-context", "upstream-models", "model-usage", "recent-failures", "usage-analytics", "animation-settings"]) {
    assert.match(html, new RegExp(`<details[^>]*id="${id}"[^>]*>\\s*<summary`));
  }
});

test("sidebar views keep dedicated business capabilities with their clients", () => {
  assert.match(html, /<nav aria-label="Navigation"/);
  for (const route of ["overview", "codex", "claude", "models", "usage", "system"]) {
    assert.match(html, new RegExp('data-route="' + route + '"'));
    assert.match(html, new RegExp('data-view="' + route + '"'));
  }
  const codex = html.slice(html.indexOf('data-view="codex"'), html.indexOf('data-view="claude"'));
  for (const id of ["runtime-resources", "prediction-settings", "additional-capabilities"]) assert.ok(codex.includes('id="' + id + '"'));
  assert.match(html, /SERVICE REQUESTS/);assert.doesNotMatch(html, /CODEX REQUESTS/);
  assert.match(css, /\[hidden\] \{ display: none !important;/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.doesNotMatch(html, /<summary\b[^>]*>(?:(?!<\/summary>)[\s\S])*<button/);
});
