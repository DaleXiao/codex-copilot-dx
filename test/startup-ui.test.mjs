import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { startupBanner, startupCheck, startupReady, startupLogger, predictionStartupCheck } from "../src/startup-ui.mjs";
import { status } from "../src/status.mjs";

test("A atom banner is static, bounded and enabled only on a wide colored terminal", () => {
  const args = { version: "0.0.0", env: {}, stream: { isTTY: true, columns: 80 } };
  const colored = startupBanner(args);
  assert.match(colored, /\x1b\[38;2;166;245;168m/);assert.match(colored, /[▀▄█]/);
  assert.equal(colored.split("\n").length, 6);
  for (const line of colored.split("\n")) assert.ok(stripVTControlCharacters(line).length < 72);
  assert.doesNotMatch(colored, /\x1b\[(?:\d*[ABCDEFGHJK]|\?25)/);
  for (const override of [{ env: { NO_COLOR: "" } }, { env: { TERM: "dumb" } },
    { stream: { isTTY: false, columns: 120 } }, { stream: { isTTY: true, columns: 40 } }]) {
    const plain = startupBanner({ ...args, ...override });
    assert.equal(plain, "ccdx v0.0.0 by Dale Xiao\nLocal model services for Codex and Claude");
  }
});

test("startup status, labels and footer share the left edge; reuse cannot advertise stopping another service", () => {
  for (const kind of ["ok", "info", "warn", "err", "wait", "debug"]) {
    assert.equal(startupCheck(kind, "Adapter", "available").indexOf("Adapter"), 8);
    assert.equal(startupCheck(kind, "Adapter", "available").indexOf("available"), 20);
    assert.equal(status(kind, "message").indexOf("message"), 8);
  }
  for (const reused of [true, false]) {
    const footer = startupReady({ baseUrl: "http://127.0.0.1:2026", reused });
    for (const line of footer.split("\n").filter(Boolean)) assert.doesNotMatch(line, /^\s/);
    assert.match(footer, /Help    ccdx help/);assert.equal(footer.includes("Stop    Ctrl+C"), !reused);
  }
});

test("self-check does not confuse disabled, unavailable, saved-route, launch and visible-candidate evidence", () => {
  assert.match(predictionStartupCheck(), /\[INFO\].*Off/);
  assert.match(predictionStartupCheck({ configured: true, bridge: "unavailable" }), /\[WARN\].*Bridge unavailable/);
  assert.match(predictionStartupCheck({ configured: true, bridge: "running", launch_route: "verified" }), /route verified; suggestion not checked/);
  for (const route of ["persisted", "unknown", "unverified"]) {
    const line = predictionStartupCheck({ configured: true, bridge: "running", launch_route: route });
    assert.match(line, /route not verified; suggestion not checked/);assert.doesNotMatch(line, /\[OK\]/);
  }
});

test("startup formatting retains prompts and warnings without importing service modules", () => {
  const lines = [], log = startupLogger("Auth", line => lines.push(line));
  log("[WARN] credential warning\n\nOpen the device login page");
  assert.match(lines[0], /\[WARN\].*Auth.*credential warning/);
  assert.deepEqual(lines.slice(1), ["", "Open the device login page"]);
  assert.doesNotMatch(startupCheck("info", "Auth\nFAKE", "a\x1b[2J\nb"), /\x1b|\n/);
});

test("runtime status keeps one aligned line and cannot execute external terminal controls", () => {
  const line = status("info", "model=example\x1b[2J\nforged\r\u202e row");
  assert.equal(line, "[INFO]  model=example forged row");
  assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f\u202e]/);
});
