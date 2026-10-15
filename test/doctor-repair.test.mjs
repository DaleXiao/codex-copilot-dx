import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repairCodexConfig } from "../src/codex-config-doctor.mjs";
import { repairDoctor } from "../src/doctor-repair.mjs";
import { runDoctor, inspectAdapterCompatibility, inspectGitHubTokenOnline } from "../src/doctor.mjs";
import { initialCodexConfig } from "../src/config.mjs";
import { writeToken } from "../src/auth.mjs";

function fixture(t, content) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-doctor-repair-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, ".codex", "config.toml");
  if (content !== undefined) { fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, content); }
  return { home, file, env: {} };
}

test("doctor config repair shares startup transformations, backs up changes and preserves unrelated and explicit settings", t => {
  const original = initialCodexConfig(2026, "127.0.0.1").replaceAll(":2026", ":9999")
    .replace("context_management = true", "context_management = false") + '\n[mcp_servers.user_owned]\ncommand="custom"\n';
  const f = fixture(t, original);
  assert.equal(repairCodexConfig(f).status, "verified");
  assert.equal(fs.readFileSync(f.file + ".ccdx-doctor.bak", "utf8"), original);
  const fixed = fs.readFileSync(f.file, "utf8");
  assert.match(fixed, /:2026\/v1/);assert.match(fixed, /context_management = false/);assert.match(fixed, /command="custom"/);
  assert.equal(repairCodexConfig(f).changed, false);
  assert.equal(fs.readFileSync(f.file + ".ccdx-doctor.bak", "utf8"), original);
});

test("invalid config is preserved and missing config is created without installing image or prediction integrations", t => {
  const invalid = fixture(t, 'model = "unterminated');
  assert.equal(repairCodexConfig(invalid).status, "preserved");
  assert.equal(fs.readFileSync(invalid.file, "utf8"), 'model = "unterminated');
  const missing = fixture(t);
  assert.equal(repairCodexConfig(missing).status, "verified");
  assert.doesNotMatch(fs.readFileSync(missing.file, "utf8"), /mcp_servers|prediction|image/);
});

test("repairs run once, recheck owned results once, preserve credentials and disabled optional features", async t => {
  const f = fixture(t);let commands = 0, configs = 0, inspections = 0;
  const checks = await repairDoctor({ ...f, platform: "win32",
    command(options) { commands++;return { status: "ready", changed: options.repair }; },
    config() { configs++;return { status: "verified", changed: true }; },
    inspectConfig() { inspections++;return []; }, savedToken: () => "fixture",
    importToken: () => assert.fail("saved token must not be replaced"),
    predictionSettings: () => ({ enabled: false }), fixPrediction: () => assert.fail("disabled prediction must not be touched"),
  });
  assert.equal(commands, 2);assert.equal(configs, 1);assert.equal(inspections, 1);
  assert.equal(checks.find(check => check.id === "windows-command").result, "fixed_verified");
  assert.equal(checks.at(-1).result, "disabled");
});

test("partial repair reports a required App relaunch rather than claiming prediction visibility", async t => {
  const f = fixture(t);let fixes = 0;
  const checks = await repairDoctor({ ...f, command: () => ({ status: "not_applicable" }), config: () => ({ status: "unchanged" }),
    inspectConfig: () => [], savedToken: () => "fixture", predictionSettings: () => ({ enabled: true }),
    fixPrediction: async () => { fixes++;return { status: "needs_app_relaunch" }; },
  });
  assert.equal(fixes, 1);assert.equal(checks.at(-1).kind, "warn");
  assert.equal(checks.at(-1).result, "needs_app_relaunch");
  assert.match(checks.at(-1).message, /visibility is not verified/);
});

test("doctor JSON is standalone, redacted and separates before checks from verified repairs", async t => {
  const f = fixture(t, initialCodexConfig(2026, "127.0.0.1"));
  writeToken("ghu_fixture", f.home);
  const lines = [];
  const checks = await runDoctor({ ...f, checkAdapter: false, json: true, fix: true, log: value => lines.push(value),
    inspectUpdateEnvironmentFn: () => ({ state: "matched" }),
    repairDoctorFn: async () => [{ id: "codex-config", kind: "ok", result: "fixed_verified", message: "verified ghp_testsecret" }],
  });
  assert.equal(lines.length, 1);
  const report = JSON.parse(lines[0]);assert.equal(report.repair_requested, true);
  assert.ok(report.before_checks.length > 0);assert.ok(checks.every(check => !check.message.includes("ghp_testsecret")));
  assert.equal(checks.filter(check => check.id === "codex-config").length, 1);
});

test("doctor cannot count HTTP 200 business failures or incomplete/contradictory streams as completion", async () => {
  for (const failure of ["failed", "incomplete", "missing", "contradictory"]) {
    const checks = await inspectAdapterCompatibility({ fetchImpl: async (url, init) => {
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "gpt-test", supported_endpoints: ["/responses"] }] });
      if (url.endsWith("/compact")) return Response.json({ id: "compact", object: "response.compaction", output: [{ type: "compaction" }] });
      if (JSON.parse(init.body).stream) {
        const event = { type: "response.completed", response: { status: "completed" } };
        const events = failure === "contradictory" ? [event, { type: "response.failed" }] : [event];
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
      }
      return Response.json({ id: "resp", status: failure === "contradictory" ? "completed" : failure === "missing" ? undefined : failure, output: [] });
    } });
    assert.ok(checks.some(check => check.kind === "err" && /did not (complete|finish)/.test(check.message)), failure);
  }
});

test("online doctor rejects HTTP 200 error envelopes instead of reporting zero models as success", async t => {
  const f = fixture(t);writeToken("ghu_fixture", f.home);
  const checks = await inspectGitHubTokenOnline({ ...f, fetchImpl: async url => Response.json(url.endsWith("/user")
    ? { login: "fixture", id: 1 } : url.endsWith("/token") ? { token: "service" } : { error: { message: "business failure" } }) });
  assert.equal(checks.at(-1).kind, "err");assert.match(checks.at(-1).message, /despite HTTP 200/);
});
