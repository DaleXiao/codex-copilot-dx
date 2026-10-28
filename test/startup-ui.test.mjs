import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { startupBanner, startupCheck, startupReady, startupLogger, predictionStartupCheck, providerStartupChecks, providerStartupSummary } from "../src/startup-ui.mjs";
import { status } from "../src/status.mjs";
import { createStartupPresentation } from "../src/startup-ui.mjs";

test("interactive startup replaces ordinary checks while retaining device codes and scoped warnings", () => {
  const writes = [], errors = [], presentation = createStartupPresentation({ output: { isTTY: true, columns: 80, rows: 24, write: text => writes.push(text) },
    errorOutput: { isTTY: true, write: text => errors.push(text) }, env: {} });
  presentation.log("log", [startupCheck("ok", "Config", "Codex local configuration checked")]);
  assert.match(writes.at(-1), /Starting · Codex/);assert.doesNotMatch(writes.join(""), /Ready|Images|Suggestions/);
  presentation.log("log", [startupCheck("info", "Sign-in", "Enter code: ABCD-EFGH")]);
  assert.match(writes.at(-1), /ABCD-EFGH/);
  presentation.log("warn", [startupCheck("warn", "App", "Codex requires a normal relaunch")]);
  assert.match(errors.join(""), /normal relaunch/);assert.equal(presentation.warnings.length, 1);
  presentation.finish();
});

test("A atom banner is static, bounded and enabled only on a wide colored terminal", () => {
  const args = { version: "0.0.0", env: {}, colorTheme: "green", stream: { isTTY: true, columns: 80 } };
  const colored = startupBanner(args);
  assert.match(colored, /\x1b\[38;2;166;245;168m/);assert.match(colored, /[▀▄█]/);assert.match(colored, /Local model gateway/);
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
  const healthy = predictionStartupCheck({ configured: true, bridge: "running", launch_route: "verified", recovery: { attempts: 0 }, persistence: "installed", environment: { status: "adapted" } });
  assert.match(healthy, /Running; suggestion display not verified/);assert.equal(healthy.split("\n").length, 1);
  assert.doesNotMatch(healthy, /Recovery|Environment|TLS|proxy/);
  for (const route of ["persisted", "unknown", "unverified"]) {
    const line = predictionStartupCheck({ configured: true, bridge: "running", launch_route: route });
    assert.match(line, /suggestion display not verified/);assert.doesNotMatch(line, /\[OK\]/);
  }
  assert.match(predictionStartupCheck({ configured: true, bridge: "running", active: false }), /Paused; trust and route retained/);
  assert.match(predictionStartupCheck({ configured: true, bridge: "running", environment: { status: "needs_service_restart" } }), /\[WARN\].*restart CCDX[\s\S]*ccdx prediction status/);
  assert.match(predictionStartupCheck({ configured: true, bridge: "unavailable", reason: "synthetic certificate error" }), /synthetic certificate error[\s\S]*ccdx prediction status/);
});

test("startup counts discovered catalogs without claiming inference access or uninspected client configuration", () => {
  const data = { profiles: { codex: { models: { source: "cache", models: 41 } } }, providers: { m365: { enabled: true, state: "checking", claude: { clients: { code: "not_configured", app: "not_configured" } } } } };
  assert.match(providerStartupChecks(data), /1 source with model lists.*GitHub 41 \(cache\); M365 checking/);
  assert.match(providerStartupChecks(data), /Code: not checked.*App: not checked.*local service off \(checking\)/);
  data.providers.m365 = { enabled: true, state: "ready", models: { total: 15, source: "live" }, claude: { gateway: "running", clients: { code: "configured", app: "preserved" } } };
  const summary = providerStartupSummary(data);
  assert.match(summary.catalogs, /2 sources with model lists.*M365 15 \(live\)/);
  assert.match(summary.claude, /Code: configured.*App: custom\/managed settings kept.*local service running/);
  assert.doesNotMatch(providerStartupChecks(data), /\[OK\]|inference verified/);
  data.profiles.codex.models.source = "built-in";data.providers.m365 = { enabled: false, state: "disabled" };
  assert.match(providerStartupChecks(data), /0 sources with model lists.*GitHub not discovered; M365 off/);
  assert.match(providerStartupChecks(), /Status unavailable/);assert.doesNotMatch(providerStartupChecks(), /0 sources/);
  data.providers.m365 = { state: "ready", claude: { clients: { code: "configuration_unavailable", app: "not_installed" } } };
  assert.match(providerStartupChecks(data), /\[WARN\].*Claude.*Code: config unreadable.*App: not installed/);
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

test("restored Claude settings are not reported as unchecked", () => {
  const summary = providerStartupSummary({ providers: { m365: { enabled: false, state: "disabled", claude: { clients: { code: "restored", app: "preserved" } } } } });
  assert.match(summary.claude, /Code: settings restored/);assert.match(summary.claude, /App: custom\/managed settings kept/);
});
