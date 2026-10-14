import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClientIntegration } from "../src/client-integration.mjs";
import { requestPredictionFix } from "../src/native-prediction-fix.mjs";
import { runPredictionCommand } from "../src/native-prediction.mjs";
import { writePredictionSettings } from "../src/native-prediction-profile.mjs";
import { invokeAdapter, invokeAdapterRequest } from "../test-support/adapter.mjs";
import { Readable } from "node:stream";
import { createRequestMetrics } from "../src/observability.mjs";
import http from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createAdapterHandler } from "../src/adapter.mjs";
import { ADAPTER_PREDICTION_FIX_PATH as endpoint, adapterHealthPayload, PREDICTION_FIX_CAPABILITY } from "../src/running-adapter.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-prediction-fix-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));return { home, env: {} };
}
function integration(t, { fail = false, enabled = true, route = "verified" } = {}) {
  const counts = { starts: 0, closes: 0, healthy: true, current: true };
  const client = createClientIntegration({ startPrediction: async ({ state, expectedPort }) => {
    counts.starts++;state.configure(enabled);
    if (!enabled) return null;
    if (fail && counts.starts === 1) throw new Error("synthetic previous compatibility failure");
    if (expectedPort !== undefined) assert.equal(expectedPort, 23456);
    state.running({ type: "direct" });
    return { pacUrl: "http://127.0.0.1:23456/proxy.pac", enabled: () => true, healthy: () => counts.healthy,
      appCurrent: () => counts.current, inspectRoute: async () => route, prepareRoute: async () => ({ status: "pending" }),
      close: async () => { counts.closes++;state.stopped(); } };
  } });t.after(() => client.close());return { client, counts };
}

test("manual repair starts a previously unavailable bridge once and is idempotent when healthy", async t => {
  const { client, counts } = integration(t, { fail: true });
  await client.start();assert.equal(client.snapshot().prediction.bridge, "unavailable");
  const results = await Promise.all(Array.from({ length: 8 }, () => client.fix()));
  assert.equal(counts.starts, 2);for (const result of results) assert.equal(result.status, "ready");
  assert.equal(client.pacUrl(), "http://127.0.0.1:23456/proxy.pac");
  await client.fix();assert.equal(counts.starts, 2);assert.equal(counts.closes, 0);
});

test("repair preserves the saved port, distinguishes missing App routes and never enables disabled prediction", async t => {
  const { client, counts } = integration(t, { route: "missing" });await client.start();
  counts.healthy = false;
  const result = await client.fix();assert.equal(result.status, "needs_app_relaunch");assert.equal(result.prediction.candidate, "unknown");assert.equal(counts.starts, 2);
  const disabled = integration(t, { enabled: false });assert.equal((await disabled.client.fix()).status, "disabled");assert.equal(disabled.client.pacUrl(), null);
});

test("a manual retry gets a fresh automatic budget and route inspection failure does not mark a healthy bridge down", async t => {
  let starts = 0;
  const client = createClientIntegration({ startPrediction: async ({ state }) => {
    state.configure(true);
    if (++starts === 1) { state.recovering(3);throw new Error("previous setup unavailable"); }
    state.running({ type: "direct" });
    return { pacUrl: "http://127.0.0.1:23456/proxy.pac", healthy: () => true, enabled: () => true,
      inspectRoute: async () => { throw new Error("process inspection unavailable"); }, close: async () => state.stopped() };
  } });t.after(() => client.close());
  await client.start();const result = await client.fix();
  assert.equal(result.prediction.bridge, "running");assert.equal(result.status, "route_unverified");
  assert.equal(result.prediction.recovery.attempts, 0);assert.equal(result.route_error, true);
});

test("repair waits for startup and shutdown cannot leak a newly created listener", async t => {
  let resume, closed = 0;
  const client = createClientIntegration({ startPrediction: async ({ state }) => {
    await new Promise(resolve => { resume = resolve; });state.configure(true);state.running({ type: "direct" });
    return { pacUrl: "http://127.0.0.1:23456/proxy.pac", healthy: () => true, enabled: () => true, inspectRoute: async () => "verified", close: async () => { closed++;state.stopped(); } };
  } });
  const starting = client.start();await Promise.resolve();await Promise.resolve();
  const fixing = client.fix();const rejection = assert.rejects(fixing, /closing/);
  const stopping = client.close();resume();await starting;await stopping;await rejection;
  assert.equal(closed, 1);assert.equal(client.pacUrl(), null);
  await assert.rejects(client.fix(), /closing/);
});

test("repair endpoint protects native loopback access before dispatch and does not affect inference counters", async () => {
  const requestMetrics = createRequestMetrics();
  let calls = 0;const fixPrediction = async () => { calls++;return { status: "ready", prediction: { bridge: "running", candidate: "unknown" } }; };
  for (const [headers, expected] of [[{ origin: "https://other.invalid" }, 403], [{ host: "other.invalid" }, 403], [{ "content-type": "text/plain" }, 415], [{}, 200]]) {
    const response = await invokeAdapter({ fixPrediction, requestMetrics }, { url: endpoint, headers: { host: "localhost:2026", ...headers }, body: { action: "fix" } });
    assert.equal(response.status, expected);
  }
  assert.equal(calls, 1);
  assert.equal(requestMetrics.snapshot().total, 0);
  for (const [peer, headers] of [["192.168.1.2", { host: "localhost:2026" }], ["127.0.0.1", {}], ["127.0.0.1", { host: "localhost:2026", origin: "null" }]]) {
    const req = Readable.from((async function* () { assert.fail("forbidden repair must not read a body"); })());
    Object.assign(req, { method: "POST", url: endpoint, headers, socket: { remoteAddress: peer } });
    assert.equal((await invokeAdapterRequest({ fixPrediction }, req)).status, 403);
  }
  assert.equal((await invokeAdapter({ fixPrediction }, { url: endpoint, method: "GET", headers: { host: "localhost:2026" } })).status, 405);
  assert.equal((await invokeAdapter({ fixPrediction }, { url: endpoint, headers: { host: "localhost:2026" }, body: { action: "on" } })).status, 400);
  assert.equal((await invokeAdapter({ fixPrediction }, { url: endpoint, headers: { host: "localhost:2026" }, body: { action: "fix", extra: "x".repeat(2000) } })).status, 413);
  const health = JSON.parse((await invokeAdapter({ fixPrediction }, { method: "GET", url: "/_ccdx/health" })).text);
  assert.ok(health.capabilities.includes(PREDICTION_FIX_CAPABILITY));
  assert.equal((await invokeAdapter({}, { url: endpoint, headers: { host: "localhost:2026" }, body: { action: "fix" } })).status, 503);
});

test("repair client refuses old/foreign services and validates operation status rather than HTTP success", async () => {
  let posts = 0;
  const healthy = { ...adapterHealthPayload(), capabilities: [PREDICTION_FIX_CAPABILITY] };
  for (const health of [{ ...healthy, name: "foreign" }, { ...healthy, capabilities: [] }]) {
    await assert.rejects(requestPredictionFix({ fetchImpl: async (_url, options) => { assert.notEqual(options.method, "POST");return Response.json(health); } }), /adapter|repair/);
  }
  const result = await requestPredictionFix({ fetchImpl: async (url, options) => {
    assert.equal(options.redirect, "error");
    if (url.endsWith("/health")) return Response.json(healthy);
    posts++;assert.equal(options.method, "POST");assert.deepEqual(JSON.parse(options.body), { action: "fix" });
    return Response.json({ status: "failed", prediction: { bridge: "unavailable", candidate: "unknown", reason: "port occupied" } });
  } });
  assert.equal(result.status, "failed");assert.equal(posts, 1);
});

test("prediction fix CLI keeps disabled installations untouched and reports partial repair as non-success", async t => {
  const options = fixture(t), lines = [];
  assert.equal((await runPredictionCommand({ ...options, action: "fix", output: value => lines.push(value), repairRuntime: () => assert.fail("disabled must not request a bridge") })).status, "disabled");
  assert.equal(fs.readdirSync(options.home).length, 0);
  writePredictionSettings({ version: 1, enabled: true }, options);
  const result = await runPredictionCommand({ ...options, action: "fix", output: value => lines.push(value), repairRuntime: async () => ({ status: "needs_app_relaunch", app_route: "unverified", prediction: { bridge: "running", candidate: "unknown" } }) });
  assert.equal(result.exitCode, 1);assert.match(lines.join("\n"), /No App was restarted/);
});

test("actual prediction fix CLI uses only the local management route and reports incomplete repairs", { timeout: 15000 }, async t => {
  const options = fixture(t), env = { ...process.env, CCDX_TEST_HOME: options.home, XDG_CONFIG_HOME: path.join(options.home, "config"),
    ADAPTER_HOST: "127.0.0.1", CCDX_AUTO_LAUNCH: "0" };
  writePredictionSettings({ version: 1, enabled: true }, { ...options, env });
  let calls = 0, status = "ready";
  const handler = createAdapterHandler({ fixPrediction: async () => {
    calls++;return { status, app_route: status === "ready" ? "verified" : "unverified", prediction: { bridge: "running", candidate: "unknown" } };
  }, responsesFn: () => assert.fail("repair must never send inference") });
  const server = http.createServer(handler);t.after(async () => { server.closeAllConnections();await new Promise(resolve => server.close(resolve));handler.cleanup?.(); });
  server.listen(0, "127.0.0.1");await once(server, "listening");env.ADAPTER_PORT = String(server.address().port);
  const cli = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("../scripts/replay-fixtures/config-startup-preload.cjs", import.meta.url));
  const run = () => promisify(execFile)(process.execPath, ["--require", preload, cli, "prediction", "fix"], { env, timeout: 5000 });
  const first = await run();assert.match(first.stdout, /App launch route verified/);assert.equal(calls, 1);
  status = "needs_app_relaunch";
  await assert.rejects(run(), error => error.code === 1 && /No App was restarted/.test(error.stdout));assert.equal(calls, 2);
  for (const [next, message] of [["needs_service_restart", /Restart the CCDX service/], ["environment_preserved", /existing bridge and routes were preserved/]]) {
    status = next;await assert.rejects(run(), error => error.code === 1 && message.test(error.stdout));
  }
  assert.equal(calls, 4);
  writePredictionSettings({ version: 1, enabled: false }, { ...options, env });
  assert.match((await run()).stdout, /nothing was enabled or changed/);assert.equal(calls, 4);
});
