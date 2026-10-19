import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

import { dashboardLanguage } from "../test-support/dashboard-language.mjs";

const html = readFileSync(new URL("../src/dashboard/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../src/dashboard/ui.js", import.meta.url), "utf8");
const viewScripts = ["status", "usage"].map(name => readFileSync(new URL(`../src/dashboard/${name}.js`, import.meta.url), "utf8")).join("\n");
const renderScript = viewScripts + "\n" + script.split('\nelement("refresh").addEventListener(')[0]
  + script.slice(script.indexOf("function emptyTable("), script.indexOf("async function loadModels("));

test("provider status explains a local proxy failure with technical codes in its details", () => {
  const nodes = new Map();
  const createNode = () => ({ textContent: "", children: [], attributes: {}, setAttribute(key, value) { this.attributes[key] = value; },
    replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); } });
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, createNode());return nodes.get(id); }, createElement: createNode };
  const renderProviders = runInNewContext(`${renderScript}\nrenderProviders;`, { document, ccdxLanguage: dashboardLanguage });
  renderProviders({ providers: [{ id: "m365", name: "Microsoft 365", state: "unavailable", reason: "m365_proxy_settings_unsupported",
    network_diagnostic: { source: "system", stage: "proxy_config", cause_code: "proxy_bypass_invalid" } }] });
  const cell = nodes.get("provider-auth").children[0].children[3];
  assert.match(cell.textContent, /Unavailable.*Invalid proxy exception rule/);
  assert.match(cell.attributes.title, /System settings.*Interpret proxy rules.*proxy_bypass_invalid.*m365_proxy_settings_unsupported/);
  assert.doesNotMatch(cell.textContent, /sign-in|permissions/);
});

test("Overview formats the current-run token ratio without turning unknown values into zero", () => {
  const nodes = new Map();
  const createNode = () => ({ textContent: "", children: [], querySelectorAll() { return []; }, replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); } });
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, createNode());return nodes.get(id); }, createElement: createNode };
  const render = runInNewContext(`${renderScript}\nrender;`, { document, ccdxLanguage: dashboardLanguage });
  for (const [rate, partial, expected] of [[2 / 3, false, "66.7%"], [0, false, "0.0%"], [0.25, true, "~25.0%"], [null, true, "—"], [undefined, false, "—"], [1.01, false, "—"], [-0.1, false, "—"]]) {
    render({ runtime_usage: { records: 2, input_tokens: 300, cached_input_tokens: 200, output_tokens: 10, cache_hit_rate: rate, cache_hit_rate_partial: partial } });
    assert.equal(nodes.get("runtime-cache-hit").textContent, expected);
  }
});

test("request-context rows are lazy, bounded, text-only and distinguish missing values from zero", () => {
  const nodes = new Map();
  const createNode = () => ({ textContent: "", children: [], open: false,
    replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); } });
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, createNode()); return nodes.get(id); }, createElement: createNode };
  const renderContext = runInNewContext(`${renderScript}\nrenderContext;`, { document, ccdxLanguage: dashboardLanguage });
  renderContext({ recent_requests: [
    { model: "gpt-6.1-sol", outcome: "completed", context: { payload_bytes: 1048576, images: 0, input_tokens: 150, context_window_tokens: 1000 } },
    { model: "<script>not-html</script>", outcome: "failed", context: { payload_bytes: null, images: null, input_tokens: null, context_window_tokens: 1000 } },
  ], by_route: { responses_compact: { terminal_outcomes: { totals: { completed: 2, incomplete: 0, failed: 1 } } } } });
  assert.equal(nodes.get("context-body").children.length, 0);
  document.getElementById("request-context").open = true;
  renderContext();
  const rows = nodes.get("context-body").children;
  assert.equal(rows[0].children[0].textContent, "<script>not-html</script>");
  assert.equal(rows[0].children[2].textContent, "—");
  assert.equal(rows[0].children[5].textContent, "—");
  assert.equal(rows[1].children[2].textContent, "0");
  assert.equal(rows[1].children[5].textContent, "15.0%");
  assert.equal(rows[0].children[6].textContent, "Failed");
  assert.equal(rows[1].children[6].textContent, "Completed");
  assert.match(nodes.get("context-note").textContent, /2 completed · 0 incomplete · 1 failed/);
  renderContext({ recent_requests: Array.from({ length: 25 }, () => ({ context: {} })) });
  assert.equal(nodes.get("context-body").children.length, 20);
});

test("dashboard usage renders percentages, zero hits and unknown rates in the seventh column", () => {
  const usageValues = runInNewContext(`${viewScripts}\nglobalThis.ccdxDashboardUsage.create({ number }).usageValues;`, {
    number: (value) => value ?? "—",
  });
  const row = { model: "test", requests: 1, input_tokens: 100, cache_read_tokens: 80,
    output_tokens: 3, total_tokens: 103, cache_hit_rate: 0.8 };
  assert.deepEqual(Array.from(usageValues(row)), ["test", 1, 100, 80, 3, 103, "80.0%"]);
  for (const [rate, expected] of [[0, "0.0%"], [1, "100.0%"], [null, "—"], [undefined, "—"], [1.2, "—"]]) {
    assert.equal(usageValues({ ...row, cache_hit_rate: rate }).at(-1), expected);
  }
  assert.equal(usageValues({ ...row, cache_hit_rate_partial: true }).at(-1), "~80.0%");
  assert.equal(usageValues({ ...row, cache_hit_rate: null, cache_hit_rate_partial: true }).at(-1), "—");
  assert.match(html, /<th scope="col" data-i18n="cache_hit">REUSE RATE<\/th>/);
  assert.match(html, /id="usage-body"><tr><td colspan="7" data-i18n="loading">Loading/);
});

test("dashboard shows active per-request caps separately from history occupancy", () => {
  assert.match(html, /Per-request limits<\/span><br><span id="body-limits">/);
  assert.match(html, /<strong id="history">—<\/strong><progress id="history-meter"/);
  const nodes = new Map();
  const createNode = () => ({
    textContent: "",
    value: 0,
    children: [],
    querySelectorAll() { return []; },
    replaceChildren(...children) { this.children = children; },
    append(child) { this.children.push(child); },
  });
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, createNode());
      return nodes.get(id);
    },
    createElement: createNode,
  };
  const data = {
    version: "test",
    requests: { total: 4, status_4xx: 1, status_5xx: 0, active: 1 },
    limits: { max_body_bytes: 64 * 1048576, max_decoded_body_bytes: 256 * 1048576 },
    response_history: { bytes: 32 * 1048576, maxBytes: 128 * 1048576, entries: 2 },
  };
  const render = runInNewContext(`${renderScript}\nrender;`, { document, ccdxLanguage: dashboardLanguage });
  render(data);
  assert.equal(nodes.get("body-limits").textContent, "Received limit: 64.0 MiB\nAfter unpacking: 256.0 MiB");
  assert.equal(nodes.get("history").textContent, "32.0 MiB / 128.0 MiB");
  assert.equal(nodes.get("history-meter").value, 25);

  data.limits.max_decoded_body_bytes = 128 * 1048576;
  render(data);
  assert.equal(nodes.get("body-limits").textContent, "Received limit: 64.0 MiB\nAfter unpacking: 128.0 MiB");
  delete data.limits;
  render(data);
  assert.equal(nodes.get("body-limits").textContent, "Received limit: —\nAfter unpacking: —");
});

test("dashboard timing shows its own sample counts and estimation boundary", () => {
  const nodes = new Map();
  const node = () => ({ textContent: "", children: [], open: false, querySelectorAll() { return []; }, replaceChildren() {}, append() {} });
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node };
  const render = runInNewContext(`${renderScript}\nrender;`, { document, ccdxLanguage: dashboardLanguage });
  render({ stream_performance: { by_route: { responses: { ttft_ms: { avg: 125, samples: 2 }, output_tokens_per_second: { avg: 178.6, samples: 1, unit: "token/s" } } } } });
  assert.equal(nodes.get("ttft").textContent, "125.0 ms / 2 samples");
  assert.equal(nodes.get("tpot").textContent, "178.6 token/s / 1 samples");
  render({});
  assert.match(nodes.get("ttft").textContent, /^—/);
  assert.match(nodes.get("tpot").textContent, /^—/);
  render({ stream_performance: { by_route: { responses: { tpot_us: { avg: 5600, samples: 1 } } } } });
  assert.match(nodes.get("tpot").textContent, /^—/); // Never invert a legacy average.
  assert.match(html, /Codex Responses timing since startup\. Speed is estimated\./);
});

test("native prediction dashboard distinguishes bridge readiness from candidate visibility", () => {
  const nodes = new Map();
  const node = () => ({ textContent: "", children: [], querySelectorAll() { return []; }, replaceChildren() {}, append() {} });
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node };
  const render = runInNewContext(`${renderScript}\nrender;`, { document, ccdxLanguage: dashboardLanguage });
  const prediction = { configured: true, bridge: "running", client_route: "observed", candidate: "displayed" };
  render({ client_integrations: { prediction } });
  assert.equal(nodes.get("prediction-preference").textContent, "Configured");
  assert.equal(nodes.get("prediction-bridge").textContent, "Running");
  assert.equal(nodes.get("prediction-route").textContent, "Settings request received");
  assert.equal(nodes.get("prediction-candidate").textContent, "Unknown");
  prediction.bridge = "recovering";render({ client_integrations: { prediction } });
  assert.equal(nodes.get("prediction-bridge").textContent, "Recovering");
  prediction.bridge = "unavailable";prediction.reason = "<script>unsafe</script>";
  render({ client_integrations: { prediction } });
  assert.equal(nodes.get("prediction-note").textContent, prediction.reason);
  render({});assert.equal(nodes.get("prediction-preference").textContent, "Unknown");
});
