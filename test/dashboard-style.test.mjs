import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/dashboard/ui.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../src/dashboard/index.html", import.meta.url), "utf8");

test("dashboard section headings share typography, including collapsible context and analytics", () => {
  assert.match(css, /\.card h2, \.panel h2, \.lower h2, \.panel > summary, \.analytics-section > summary \{[^}]*color: var\(--heading\); font-size: 11px; font-weight: 700; letter-spacing: \.08em; line-height: 1\.6; margin: 0;/);
  assert.match(css, /table \{[^}]*font-size: 11px;/);
  assert.match(css, /\.hint \{[^}]*font-size: 11px;/);
  assert.match(css, /\.table-note \{[^}]*font-size: 11px;/);
});

test("all native disclosures use one plus/minus rule without duplicate animation markers", () => {
  assert.match(css, /details > summary \{[^}]*grid-template-columns: auto minmax\(0, 1fr\);[^}]*list-style: none;/);
  assert.match(css, /details > summary::-webkit-details-marker \{ display: none; \}/);
  assert.match(css, /details > summary::marker \{ content: ""; \}/);
  assert.match(css, /details > summary::before \{ content: "\+";/);
  assert.match(css, /details\[open\] > summary::before \{ content: "−"; \}/);
  assert.doesNotMatch(css, /summary h2::before/);
  assert.match(css, /\.settings-panel > summary \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\) auto; \}/);
  assert.match(css, /summary:focus-visible, select:focus-visible \{ outline: 2px solid var\(--accent\);/);
  for (const id of ["request-context", "usage-analytics", "animation-settings"]) {
    assert.match(html, new RegExp(`<details[^>]*id="${id}"[^>]*>\\s*<summary`));
  }
});
