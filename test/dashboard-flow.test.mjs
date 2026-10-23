import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { invokeAdapter } from "../test-support/adapter.mjs";

const script = readFileSync(new URL("../src/dashboard/flow.js", import.meta.url), "utf8");
test("flow assets use the same loopback-only management boundary", async () => {
  const local = await invokeAdapter({}, { url: "/flow.js", method: "GET", headers: { host: "127.0.0.1:2026" } });
  assert.equal(local.status, 200);assert.equal(local.text, script);
  assert.equal((await invokeAdapter({}, { url: "/flow.js", method: "GET", headers: { host: "evil.invalid" } })).status, 403);
});

function fixture() {
  const nodes = new Map(), timers = new Map(), listeners = new Map();let now = 0, hidden = false;
  class Node {
    constructor(tag = "div") { this.tag = tag;this.children = [];this.dataset = {};this.style = {};this.attributes = {};this.events = {};this.textContent = ""; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(key, value) { this.events[key] = value; }
    append(...children) { for (const child of children) { child.remove();child.parent = this;this.children.push(child); } }
    replaceChildren(...children) { for (const child of [...this.children]) child.remove();this.append(...children); }
    insertBefore(child, target) { child.remove();child.parent = this;const index = this.children.indexOf(target);this.children.splice(index < 0 ? this.children.length : index, 0, child); }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);this.parent = null; }
    closest() { return hidden ? {} : null; }
    get isConnected() { return Boolean(this.parent); }
    getBoundingClientRect() { return { width: 800, height: 300, top: 0, left: 0, right: 100 }; }
  }
  const el = id => { if (!nodes.has(id)) nodes.set(id, new Node());return nodes.get(id); };
  const document = { visibilityState: "visible", documentElement: {}, getElementById: id => id === "status-icon" ? null : el(id), createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag), addEventListener: (key, fn) => listeners.set(key, fn) };
  const language = { format: (key, values) => `${key}${values && Object.keys(values).length ? JSON.stringify(values) : ""}`, set: (node, key, values) => { node.textContent = language.format(key, values); } };
  const context = { document, Date: { now: () => now }, setTimeout: (fn, ms) => { timers.set(fn, ms);return fn; }, clearTimeout: fn => timers.delete(fn),
    ccdxLanguage: language, ccdxIcons: { set: (node, key, kind, values) => language.set(node, key, values) },
    addEventListener: (key, fn) => listeners.set(key, fn), ResizeObserver: class { observe() {} }, MutationObserver: class { observe() {} } };
  runInNewContext(script, context);
  return { api: context.ccdxDashboardFlow, el, document, timers, listeners, hide: value => { hidden = value; }, advance: ms => { now += ms; } };
}
const row = (application, model, extra = {}) => ({ request_id: `${application}-${model}`, application, model, provider: "m365", upstream_attempts: 1, elapsed_ms: 1000, first_output_ms: null, ...extra });
const snapshot = rows => ({ stream_performance: { active_requests: rows, active_total: rows.length } });

test("flow groups concurrent work, selects only names and keeps the exact total outside filters", () => {
  const f = fixture(), records = [row("codex_app", "gpt-test", { first_output_ms: 2 }), row("claude_code", "claude-test", { upstream_attempts: 2 }), row("claude_app", "claude-other")];
  f.api.update(snapshot(records));
  assert.equal(f.el("request-flow").dataset.state, "active");
  assert.equal(f.el("flow-apps").children.length, 3);
  const choice = f.el("flow-apps").children[0].children[0];choice.events.click();
  assert.equal(choice.attributes["aria-pressed"], "true");assert.equal(choice.children.length, 0);
  assert.match(f.el("flow-state").textContent, /"count":3/);
  assert.equal(f.el("flow-active-body").children.length, 1);
  assert.equal(f.el("flow-active-body").children[0].children[3].textContent, "flow_responding");
  f.el("flow-clear").events.click();assert.equal(f.el("flow-active-body").children.length, 3);
  assert.equal(f.el("flow-active-body").children[1].children[3].textContent, "flow_retrying");
  records[0].terminal_outcome = "failed";f.api.update(snapshot(records));
  assert.equal(f.el("flow-active-body").children[0].children[3].textContent, "flow_finishing");
  f.api.update(snapshot([]));assert.equal(f.el("request-flow").dataset.state, "idle");
  assert.equal(f.el("flow-apps").children[0].children[1].hidden, true);
  f.api.update({ stream_performance: { active_requests: [records[0]], active_total: 65 } });
  assert.match(f.el("flow-apps").children[0].children[1].textContent, /flow_count_lower.*"count":"1"/);
  assert.equal(f.el("flow-apps").children[0].children[1].hidden, false);
  f.api.update({ stream_performance: { active_requests: [], active_total: 64 } });
  assert.equal(f.el("request-flow").dataset.state, "active");
  assert.equal(f.el("flow-apps").children[0].children[1].textContent, "—");
});

test("single observations hide counts; a shared route names the concurrent count without changing totals", () => {
  const f = fixture(), records = [row("codex", "gpt-test"), row("codex", "gpt-test", { request_id: "second", first_output_ms: 2 })];
  f.api.update(snapshot(records));
  const node = f.el("flow-apps").children[0];
  assert.equal(node.children[0].textContent, "flow_app_codex");
  assert.equal(node.children[1].hidden, false);assert.match(node.children[1].textContent, /flow_count.*"count":"2"/);
  assert.equal(node.children[0].children.length, 0);
  f.api.update(snapshot([records[1]]));
  assert.equal(node.children[1].hidden, true);assert.match(node.children[2].textContent, /^flow_responding/);
  f.api.unavailable();assert.equal(node.children[1].hidden, false);assert.equal(node.children[1].textContent, "—");
});

test("stale, malformed and hidden flow never invent idle or replay work", () => {
  const f = fixture();f.api.update(snapshot([row("claude", "<script>literal</script>")]));
  assert.ok(f.el("flow-models").children.some(node => node.children[0]?.textContent === "<script>literal</script>"));
  f.document.visibilityState = "hidden";f.listeners.get("visibilitychange")();
  assert.equal(f.el("request-flow").dataset.paused, "true");
  f.advance(7000);f.document.visibilityState = "visible";f.listeners.get("pageshow")();
  assert.equal(f.el("request-flow").dataset.state, "unknown");
  f.api.update({ stream_performance: { active_total: "0", active_requests: [] } });
  assert.equal(f.el("request-flow").dataset.state, "unknown");
  f.api.update(snapshot([]));assert.equal(f.el("request-flow").dataset.state, "idle");
  f.hide(true);f.api.visibilityChanged();assert.equal(f.el("request-flow").dataset.paused, "true");
  f.api.unavailable();assert.equal(f.timers.size, 0);
});
