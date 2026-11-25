import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { dashboardLanguage } from "../test-support/dashboard-language.mjs";

const script = readFileSync(new URL("../src/dashboard/tool-activity.js", import.meta.url), "utf8");
function fixture(saved, { deferLoad = false } = {}) {
  const elements = new Map(), frames = new Map(), timers = new Map(), listeners = new Map();
  const downloads = [];
  let now = 0, sequence = 0, draws = 0, intersection;
  const node = () => ({ dataset: {}, hidden: false, children: [], value: "", listeners: new Map(),
    closest() { return null; }, replaceChildren() { this.children = []; }, append(...items) { this.children.push(...items); },
    setAttribute(key, value) { this[key] = value; }, addEventListener(key, fn) { this.listeners.set(key, fn); } });
  const el = id => { if (!elements.has(id)) elements.set(id, node());return elements.get(id); };
  const ctx = { setTransform() {}, clearRect() { draws++; }, beginPath() {}, arc() {}, stroke() {}, fill() {}, closePath() {}, strokeRect() {}, fillRect() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {} };
  const canvas = el("tool-canvas");canvas.getContext = () => ctx;canvas.parentElement = node();canvas.getBoundingClientRect = () => ({ width: 250, height: 190 });
  const document = { visibilityState: "visible", documentElement: node(), currentScript: { src: "http://127.0.0.1/dashboard.js?v=fixture" },
    head: { append(script) { downloads.push(script);if (!deferLoad) script.listeners.get("load")(); } }, getElementById: el, createElement: node, addEventListener: (key, fn) => listeners.set(key, fn) };
  const motion = { matches: false, addEventListener: (key, fn) => listeners.set("motion", fn) };
  const context = { document, URL, localStorage: { getItem: () => saved, setItem: (_key, value) => { saved = value; } },
    performance: { now: () => now }, devicePixelRatio: 2, matchMedia: () => motion,
    getComputedStyle: () => ({ getPropertyValue: () => "#111111" }), addEventListener: (key, fn) => listeners.set(key, fn),
    requestAnimationFrame(fn) { frames.set(++sequence, fn);return sequence; }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout(fn, ms) { timers.set(++sequence, { fn, at: now + ms });return sequence; }, clearTimeout: id => timers.delete(id),
    ResizeObserver: class { observe() {} }, MutationObserver: class { observe() {} },
    IntersectionObserver: class { constructor(fn) { intersection = fn; } observe() {} },
    ccdxToolMachines: () => () => {}, ccdxToolArm: () => () => {},
    ccdxLanguage: { format: (key, values = {}) => key === "model_action_label" ? dashboardLanguage.format(key, values) : `${key}:${values.count ?? ""}`, set: (target, key, values) => { target.textContent = context.ccdxLanguage.format(key, values); } } };
  runInNewContext(script, context);
  return { api: context.ccdxToolActivity, el, motion, document, frames, listeners, downloads, get draws() { return draws; }, get saved() { return saved; },
    style(value) { el("tool-style").value = value;el("tool-style").listeners.get("change")(); },
    intersect(value) { intersection([{ isIntersecting: value }]); },
    advance(ms) { now += ms;for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id);timer.fn(); }for (const [id, fn] of [...frames]) { frames.delete(id);fn(now); } } };
}
const request = (patch = {}) => ({ purpose: "conversation", application: "codex_app", provider: "github", model: "test-model", phase: "body", terminal_outcome: null, first_output_ms: null, ...patch });
const data = (requests = [], items = []) => ({ stream_performance: { active_requests: requests, tool_activity: { items } } });
const tool = state => ({ id: "tool-one", application: "claude_app", provider: "api_work", model: "tool-model", name: "read_file", state, expires_in_ms: 15000 });

test("motion defaults and removed preferences migrate while valid choices remain", () => {
  for (const saved of [undefined, "orbit", "weave", "busy", "speed", "halo", "grid", "invalid"]) assert.equal(fixture(saved).el("tool-style").value, "production");
  for (const saved of ["production", "clock", "assembly", "sorter", "gantry", "rotary", "arm", "off"]) assert.equal(fixture(saved).el("tool-style").value, saved);
  const f = fixture();f.api.update(data([], [tool("waiting")]), { live: true });
  for (const style of ["production", "clock", "assembly", "sorter", "gantry", "rotary", "arm"]) {
    f.style(style);const before = f.draws;f.advance(50);assert.ok(f.draws > before);assert.equal(f.saved, style);
    assert.equal(f.el("tool-state").textContent, "tool_waiting:1");
  }
  f.style("off");assert.equal(f.frames.size, 0);assert.equal(f.el("tool-state").textContent, "tool_waiting:1");
});
test("the arm renderer loads only on selection and a late load cannot animate a disabled style", () => {
  const f = fixture("production", { deferLoad: true });
  f.api.update(data([request()]), { live: true });
  assert.deepEqual(f.downloads.map(item => item.src), ["http://127.0.0.1/tool-activity-machines.js?v=fixture"]);
  f.style("arm");
  assert.equal(f.downloads[1].src, "http://127.0.0.1/tool-activity-arm.js?v=fixture");
  f.style("off");
  for (const script of f.downloads) script.listeners.get("load")();
  assert.equal(f.frames.size, 0);
  f.style("arm");
  assert.equal(f.downloads.length, 2);
  assert.ok(f.frames.size);
  assert.equal(f.saved, "arm");
});
test("agent activity follows real request phases and stops on terminal, diagnostic or disconnected evidence", () => {
  const f = fixture();f.api.update(data([request()]), { live: true });assert.equal(f.el("tool-state").textContent, "tool_processing:1");assert.ok(f.frames.size);
  f.api.update(data([request({ first_output_ms: 100, phase: "upstream_stream" })]), { live: true });assert.equal(f.el("tool-state").textContent, "tool_responding:1");
  for (const row of [request({ terminal_outcome: "cancelled" }), request({ purpose: "diagnostic" }), request({ phase: "unrecognized" })]) {
    f.api.update(data([row]), { live: true });assert.equal(f.frames.size, 0);assert.equal(f.el("tool-state").textContent, "tool_idle:0");
  }
  f.api.update(data([request()]));f.advance(6000);assert.equal(f.frames.size, 0);assert.equal(f.el("tool-state").textContent, "flow_status_unknown:0");
  f.api.update(data([request()], [tool("returned")]), { live: true });f.api.unavailable();assert.equal(f.frames.size, 0);
});
test("pending calls take precedence and actual returned results hand back to an active request", () => {
  const f = fixture();f.api.update(data([request({ first_output_ms: 100 })], [tool("waiting")]), { live: true });
  assert.equal(f.el("tool-state").textContent, "tool_waiting:1");assert.match(f.el("tool-context").textContent, /tool-model/);
  f.api.update(data([request({ first_output_ms: 100 })], [tool("returned")]), { live: true });
  assert.equal(f.el("tool-state").textContent, "tool_responding:1");assert.match(f.el("tool-context").textContent, /test-model/);
  for (const state of ["returned", "failed", "cancelled", "unknown"]) {
    f.api.update(data([], [tool(state)]), { live: true });assert.equal(f.frames.size, 0);assert.equal(f.el("tool-cursor").hidden, true);
  }
});
test("hidden, offscreen and reduced motion pause every style without changing its state text", () => {
  const f = fixture();f.api.update(data([request()]), { live: true });
  for (const style of ["production", "clock", "assembly", "sorter", "gantry", "rotary", "arm"]) {
    f.style(style);f.motion.matches = true;f.listeners.get("motion")();assert.equal(f.frames.size, 0);
    f.motion.matches = false;f.listeners.get("motion")();assert.ok(f.frames.size);
    f.intersect(false);assert.equal(f.frames.size, 0);f.intersect(true);assert.ok(f.frames.size);
    f.document.visibilityState = "hidden";f.listeners.get("visibilitychange")();assert.equal(f.frames.size, 0);
    f.document.visibilityState = "visible";f.listeners.get("visibilitychange")();assert.ok(f.frames.size);
    assert.equal(f.el("tool-state").textContent, "tool_processing:1");
  }
});
