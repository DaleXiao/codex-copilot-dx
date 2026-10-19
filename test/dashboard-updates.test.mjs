import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import { createDashboardUpdateStatus } from "../src/dashboard-updates.mjs";
import { ADAPTER_VERSION } from "../src/running-adapter.mjs";

const release = (version, extra = {}) => ({ tag_name: `v${version}`, published_at: "2026-10-19T02:36:27Z", draft: false, prerelease: false, ...extra });
const response = value => Response.json(value);
const commands = runInNewContext(readFileSync(new URL("../src/dashboard/updates.js", import.meta.url), "utf8") + "\nccdxDashboardUpdates.installationCommand;");

test("the default current version uses the running adapter's captured version", async () => {
  const value = await createDashboardUpdateStatus({ fetchFactory: async () => async () => response(release(ADAPTER_VERSION)) })();
  assert.equal(value.current.version, ADAPTER_VERSION);assert.equal(value.update_available, false);
});

test("release checks share in-flight work, cache immutable copies and use exact current-release dates", async () => {
  let reads = 0, factories = 0, clock = 0;
  const check = createDashboardUpdateStatus({ currentVersion: "1.2.3", now: () => clock, fetchFactory: async () => {
    factories++;return async (url, options) => {
      reads++;assert.equal(options.redirect, "error");assert.ok(options.signal);assert.equal(options.headers.Authorization, undefined);
      return response(url.endsWith("/latest") ? release("1.2.4") : release("1.2.3", { published_at: "2026-10-18T04:09:43Z" }));
    };
  } });
  const snapshots = await Promise.all(Array.from({ length: 20 }, check));
  assert.equal(reads, 2);assert.equal(factories, 1);
  assert.equal(snapshots[0].update_available, true);assert.equal(snapshots[0].current.published_at, "2026-10-18T04:09:43.000Z");
  snapshots[0].latest.version = "bad";
  assert.equal(snapshots[1].latest.version, "1.2.4");assert.equal((await check()).latest.version, "1.2.4");
  clock += 300001;await check();assert.equal(reads, 3, "The current release date is retained; only latest metadata refreshes");
});

test("checked current and locally newer versions never advertise an upgrade or invent dates", async () => {
  for (const version of ["1.2.3", "1.2.2"]) {
    const check = createDashboardUpdateStatus({ currentVersion: "1.2.3", fetchFactory: async () => async () => response(release(version, { published_at: null })) });
    const result = await check();assert.equal(result.status, "checked");assert.equal(result.update_available, false);
    assert.equal(result.current.published_at, null);assert.equal(result.latest.published_at, null);
  }
  const invalidDate = await createDashboardUpdateStatus({ currentVersion: "1.2.3", fetchFactory: async () => async () => response(release("1.2.3", { published_at: "2026-02-30T00:00:00Z" })) })();
  assert.equal(invalidDate.current.published_at, null);
});

test("failed and rate-limited checks retain last-good metadata without claiming freshness or latest", async () => {
  let clock = 0, limited = false, reads = 0;
  const check = createDashboardUpdateStatus({ currentVersion: "1.2.3", now: () => clock, fetchFactory: async () => async () => {
    reads++;return limited ? new Response("private diagnostic", { status: 429 }) : response(release("1.2.4"));
  } });
  const good = await check();limited = true;clock += 300001;
  const failed = await check();assert.equal(failed.status, "rate_limited");assert.equal(failed.update_available, false);
  assert.equal(failed.latest.version, "1.2.4");assert.equal(failed.last_success_at, good.last_success_at);
  assert.notEqual(failed.checked_at, good.checked_at);assert.doesNotMatch(JSON.stringify(failed), /private diagnostic/);
  const before = reads;clock += 59000;await check();assert.equal(reads, before);
  clock += 1001;await check();assert.equal(reads, before + 1);
});

test("unavailable npm settings, invalid stable releases, malformed and oversized metadata fail closed", async () => {
  const cases = [
    async () => { throw Error("credential private proxy"); },
    ...[release("1.2.4", { draft: true }), release("1.2.4", { prerelease: true }), release("1.2.4", { tag_name: "v1.2.4;calc" })].map(value => async () => async () => response(value)),
    async () => async () => new Response("not json"),
    async () => async () => new Response("x".repeat(128 * 1024 + 1)),
  ];
  for (const fetchFactory of cases) {
    const result = await createDashboardUpdateStatus({ currentVersion: "1.2.3", fetchFactory })();
    assert.equal(result.status, "unavailable");assert.equal(result.latest, null);assert.equal(result.update_available, false);
    assert.doesNotMatch(JSON.stringify(result), /credential|private proxy|calc/);
  }
});

test("a stalled metadata body is bounded by the lookup deadline", async () => {
  const check = createDashboardUpdateStatus({ timeoutMs: 20, fetchFactory: async () => async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } })) });
  // Keep the event loop alive while AbortSignal.timeout's unref'ed timer expires.
  const hold = setTimeout(() => {}, 1000);
  try { assert.equal((await check()).status, "unavailable"); } finally { clearTimeout(hold); }
});

test("fallback installation commands validate versions and preserve shell/npm security policy", () => {
  for (const version of [null, "", "1.2.4; calc", "1.2.4\nwhoami", "$(id)", "1.2.4-beta.1", "01.2.4"]) {
    assert.equal(commands("macos", version), "");assert.equal(commands("windows", version), "");
  }
  const mac = commands("macos", "1.2.4"), windows = commands("windows", "1.2.4");
  for (const text of [mac, windows]) {
    assert.match(text, /\/v1\.2\.4\/install\./);assert.doesNotMatch(text, /allow-remote|allow-git|--force|Bypass|ExecutionPolicy|registry\.npmjs|\biex\b|sudo/);
  }
  assert.match(mac, /mktemp -d/);assert.match(mac, /trap .*EXIT/);assert.match(windows, /finally/);
  for (const [current, latest, target] of [["1.2.4", "1.2.3", "1.2.4"], ["1.2.3", "1.2.4", "1.2.4"], ["1.10.0", "1.9.9", "1.10.0"], ["2.0.0", "1.99.99", "2.0.0"]]) {
    assert.ok(commands("macos", current, latest).includes(`/v${target}/install.sh`), "Recovery never chooses an older known release");
    assert.ok(commands("windows", current, latest).includes(`/v${target}/install.ps1`));
  }
  if (process.platform !== "win32") assert.equal(spawnSync("sh", ["-n"], { input: mac, encoding: "utf8" }).status, 0);
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", "$source = [Console]::In.ReadToEnd(); $tokens = $null; $errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors); if ($errors.Count) { exit 1 }"], { input: windows, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
});
