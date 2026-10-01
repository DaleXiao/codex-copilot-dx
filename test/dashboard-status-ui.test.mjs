import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const html = readFileSync(new URL("../src/dashboard/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../src/dashboard/ui.js", import.meta.url), "utf8");
const renderScript = script.split('\nelement("refresh").addEventListener("click", refresh);')[0];

test("dashboard usage renders percentages, zero hits and unknown rates in the seventh column", () => {
  const usageScript = script.slice(script.indexOf("function usageValues(row)"), script.indexOf("async function loadUsage()"));
  const usageValues = runInNewContext(`${usageScript}\nusageValues;`, {
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
  assert.match(html, /<th scope="col">CACHE HIT<\/th>/);
  assert.match(html, /id="usage-body"><tr><td colspan="7">Loading/);
});

test("dashboard shows active per-request caps separately from history occupancy", () => {
  assert.match(html, /Per-request limits \(active\)<br><span id="body-limits">/);
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
  const render = runInNewContext(`${renderScript}\nrender;`, { document });
  render(data);
  assert.equal(nodes.get("body-limits").textContent, "raw 64.0 MiB / decoded 256.0 MiB");
  assert.equal(nodes.get("history").textContent, "32.0 MiB / 128.0 MiB");
  assert.equal(nodes.get("history-meter").value, 25);

  data.limits.max_decoded_body_bytes = 128 * 1048576;
  render(data);
  assert.equal(nodes.get("body-limits").textContent, "raw 64.0 MiB / decoded 128.0 MiB");
  delete data.limits;
  render(data);
  assert.equal(nodes.get("body-limits").textContent, "raw — / decoded —");
});
