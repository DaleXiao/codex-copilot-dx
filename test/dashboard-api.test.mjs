import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAdapterHandler } from "../src/adapter.mjs";
import { TERMINAL_ANIMATION_THEMES } from "../src/terminal-animation.mjs";
import { userSettingsPath } from "../src/user-settings.mjs";
import { summarizeUsage } from "../src/usage.mjs";

async function invoke(handler, {
  method = "GET",
  url,
  host = "127.0.0.1:2026",
  origin,
  remoteAddress = "127.0.0.1",
  body,
  contentType = "application/json",
  dashboardHeader = "1",
} = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = method;
  req.url = url;
  req.socket = { remoteAddress };
  req.headers = { host, ...(dashboardHeader ? { "x-ccdx-dashboard": dashboardHeader } : {}), ...(origin ? { origin } : {}), ...(body === undefined ? {} : { "content-type": contentType }) };
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.destroyed = false;
  res.writableEnded = false;
  res.writableFinished = false;
  const chunks = [];
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.writeHead = (code, headers = {}) => { res.statusCode = code; Object.assign(res.headers, headers); return res; };
  res.write = (chunk) => { chunks.push(Buffer.from(chunk)); return true; };
  res.end = (chunk) => {
    if (chunk !== undefined) chunks.push(Buffer.from(chunk));
    res.writableEnded = true;
    res.writableFinished = true;
    res.emit("finish");
    return res;
  };
  await handler(req, res);
  const text = Buffer.concat(chunks).toString("utf8");
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(text) };
}

test("dashboard animation uses existing themes and settings, preserving unrelated keys", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-dashboard-animation-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = {};
  const filePath = userSettingsPath({ env, home });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{"auto_review_model":"gpt-5.6-sol"}\n');
  const handler = createAdapterHandler({ dashboardOptions: { env, home } });

  const before = await invoke(handler, { url: "/_ccdx/ui/animation" });
  assert.equal(before.status, 200);
  assert.equal(before.body.theme, "comet");
  assert.deepEqual(before.body.themes.map(({ id }) => id), TERMINAL_ANIMATION_THEMES.map(({ id }) => id));
  assert.equal(before.body.themes[0].frames.length, TERMINAL_ANIMATION_THEMES[0].frameCount);
  assert.match(before.body.themes[0].frames[0].ansi, /\u001b\[/);
  const metadata = await invoke(handler, { url: "/_ccdx/ui/animation?frames=0" });
  assert.equal(metadata.status, 200);
  assert.deepEqual(metadata.body.themes.map(({ id }) => id), before.body.themes.map(({ id }) => id));
  assert.equal(metadata.body.themes[0].frames, undefined);
  assert.ok(JSON.stringify(metadata.body).length < JSON.stringify(before.body).length / 100);

  const saved = await invoke(handler, {
    method: "POST", url: "/_ccdx/ui/animation", origin: "http://127.0.0.1:2026",
    body: { theme: "twin" },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.theme, "twin");
  assert.equal(saved.body.changed, true);
  assert.equal(saved.body.source, "settings");
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), {
    auto_review_model: "gpt-5.6-sol", terminal_animation: "twin",
  });

  const reset = await invoke(handler, {
    method: "POST", url: "/_ccdx/ui/animation", origin: "http://127.0.0.1:2026",
    body: { theme: "comet" },
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.source, "default");
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { auto_review_model: "gpt-5.6-sol" });
});

test("usage analytics is opt-in, uses one metadata scan and validates timezone before reading", async () => {
  const records = [{ ts: new Date(Date.now() - 1000).toISOString(), model: "gpt-6.1-sol", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0, total_tokens: 12 }, prompt: "not-for-dashboard", key: "secret-key" }];
  let calls = 0;
  let callbacks = 0;
  const handler = createAdapterHandler({ dashboardOptions: { usageSummaryFn: async (options) => {
    calls += 1;
    for (const row of records) if (options?.onRecord) { callbacks += 1; options.onRecord(row, summarizeUsage([row])); }
    return summarizeUsage(records);
  } } });
  const plain = await invoke(handler, { url: "/_ccdx/ui/usage" });
  assert.equal(plain.body.analytics, undefined);
  assert.equal(callbacks, 0);
  const result = await invoke(handler, { url: "/_ccdx/ui/usage?analytics=1&time_zone=Asia%2FShanghai" });
  assert.equal(calls, 2);
  assert.equal(callbacks, 1);
  assert.deepEqual(result.body.total, plain.body.total);
  assert.deepEqual(result.body.rows, plain.body.rows);
  assert.equal(result.body.analytics.days.length, 365);
  assert.equal(result.body.analytics.days.at(-1).requests, 1);
  assert.doesNotMatch(JSON.stringify(result.body), /not-for-dashboard|secret-key|response_id/);
  const invalid = await invoke(handler, { url: "/_ccdx/ui/usage?analytics=1&time_zone=Invalid%2FZone" });
  assert.equal(invalid.status, 400);
  assert.equal(calls, 2);
  for (const options of [{ remoteAddress: "10.0.0.2" }, { dashboardHeader: "" }, { host: "evil.example" }]) {
    assert.equal((await invoke(handler, { url: "/_ccdx/ui/usage?analytics=1", ...options })).status, 403);
  }
  assert.equal(calls, 2);
});

test("dashboard animation rejects cross-origin, LAN, bad media type and unlisted themes without writes", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-dashboard-security-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const handler = createAdapterHandler({ dashboardOptions: { env: {}, home } });
  const pathName = "/_ccdx/ui/animation";
  for (const options of [
    { origin: "https://evil.example" },
    { origin: undefined },
    { origin: "http://127.0.0.1:2026", host: "evil.example:2026" },
    { origin: "http://127.0.0.1:2026", remoteAddress: "10.0.0.5" },
  ]) {
    const result = await invoke(handler, { method: "POST", url: pathName, body: { theme: "twin" }, ...options });
    assert.equal(result.status, 403);
  }
  const wrongType = await invoke(handler, {
    method: "POST", url: pathName, origin: "http://127.0.0.1:2026",
    body: { theme: "twin" }, contentType: "text/plain",
  });
  assert.equal(wrongType.status, 415);
  const invalid = await invoke(handler, {
    method: "POST", url: pathName, origin: "http://127.0.0.1:2026", body: { theme: "braille" },
  });
  assert.equal(invalid.status, 400);
  assert.equal(fs.existsSync(userSettingsPath({ env: {}, home })), false);
});

test("dashboard reports environment-disabled animation without changing the saved preference", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-dashboard-override-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const handler = createAdapterHandler({ dashboardOptions: { env: { CCDX_TERMINAL_ANIMATION: "off" }, home } });
  const result = await invoke(handler, {
    method: "POST", url: "/_ccdx/ui/animation", origin: "http://127.0.0.1:2026", body: { theme: "pulse" },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.disabled_by_environment, true);
  assert.equal(result.body.theme, "pulse");
});

test("dashboard live model lookup never labels a failed lookup as cached success", async () => {
  const catalog = {
    advertised: 3,
    upstreamHost: "api.githubcopilot.com",
    models: [{ id: "gpt-6-sol", vendor: "OpenAI", endpoints: ["responses"], preview: false }],
  };
  const success = createAdapterHandler({ dashboardOptions: { liveModelsFn: async () => catalog } });
  const result = await invoke(success, { url: "/_ccdx/ui/models/live" });
  assert.equal(result.status, 200);
  assert.equal(result.body.source, "live");
  assert.equal(result.body.selectable, 1);
  assert.deepEqual(result.body.models[0].endpoints, ["responses"]);
  const failure = createAdapterHandler({ dashboardOptions: { liveModelsFn: async () => { throw new Error("HTTP 403 policy denied secret-token"); } } });
  const denied = await invoke(failure, { url: "/_ccdx/ui/models/live" });
  assert.equal(denied.status, 502);
  assert.match(denied.body.error, /HTTP 403/);
  assert.doesNotMatch(denied.body.error, /secret-token/);
  assert.equal(denied.body.models, undefined);
});

test("dashboard usage returns bounded metadata-only rows sorted by tokens", async () => {
  const summary = {
    requests: 3,
    totals: { input_tokens: 21, cached_input_tokens: 3, output_tokens: 9, total_tokens: 30 },
    byModel: {
      "gpt-6-sol": { requests: 1, input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      "gpt-6-astra": { requests: 2, input_tokens: 16, cached_input_tokens: 3, output_tokens: 7, total_tokens: 23 },
    },
    response_id: "must-not-leak",
  };
  const handler = createAdapterHandler({ dashboardOptions: { usageSummaryFn: async () => summary } });
  const result = await invoke(handler, { url: "/_ccdx/ui/usage" });
  assert.equal(result.status, 200);
  assert.equal(result.body.source, "local_usage_log");
  assert.deepEqual(result.body.rows.map((row) => row.model), ["gpt-6-astra", "gpt-6-sol"]);
  assert.equal(result.body.total.cache_read_tokens, 3);
  assert.equal(result.body.total.cache_hit_rate, 3 / 21);
  assert.equal(result.body.rows[0].cache_hit_rate, 3 / 16);
  assert.equal(result.body.rows[1].cache_hit_rate, null);
  assert.doesNotMatch(JSON.stringify(result.body), /must-not-leak/);
});

test("dashboard cache hit rate matches CLI and marks computable incomplete totals partial", async () => {
  const records = [
    { model: "a", usage: { input_tokens: 10, cached_input_tokens: 10, total_tokens: 10 } },
    { model: "b", usage: { input_tokens: 90, cached_input_tokens: 0, total_tokens: 90 } },
  ];
  const handler = createAdapterHandler({ dashboardOptions: { usageSummaryFn: async () => summarizeUsage(records) } });
  const first = await invoke(handler, { url: "/_ccdx/ui/usage" });
  assert.equal(first.body.total.cache_hit_rate, 0.1);
  assert.equal(first.body.rows.find(({ model }) => model === "a").cache_hit_rate, 1);
  assert.equal(first.body.rows.find(({ model }) => model === "b").cache_hit_rate, 0);
  records.push({ model: "old-log", usage: { input_tokens: 5 } });
  const incomplete = await invoke(handler, { url: "/_ccdx/ui/usage" });
  assert.equal(incomplete.body.total.cache_hit_rate, 10 / 105);
  assert.equal(incomplete.body.total.cache_hit_rate_partial, true);
  assert.equal(incomplete.body.rows.find(({ model }) => model === "old-log").cache_hit_rate, null);
  assert.equal(incomplete.body.rows.find(({ model }) => model === "a").cache_hit_rate, 1);
  assert.equal(incomplete.body.rows.find(({ model }) => model === "a").cache_hit_rate_partial, false);
});

test("dashboard usage bounds model rows without dropping the aggregate total", async () => {
  const byModel = Object.fromEntries(Array.from({ length: 130 }, (_, index) => [
    `gpt-${index}`, { requests: 1, total_tokens: index + 1 },
  ]));
  const handler = createAdapterHandler({ dashboardOptions: {
    usageSummaryFn: async () => ({ requests: 130, totals: { total_tokens: 8515 }, byModel }),
  } });
  const result = await invoke(handler, { url: "/_ccdx/ui/usage" });
  assert.equal(result.status, 200);
  assert.equal(result.body.model_count, 130);
  assert.equal(result.body.rows.length, 100);
  assert.equal(result.body.rows[0].model, "gpt-129");
  assert.equal(result.body.total.total_tokens, 8515);
});

test("dashboard API does not run read-only lookups for non-GET methods", async () => {
  let lookups = 0;
  const handler = createAdapterHandler({ dashboardOptions: {
    liveModelsFn: async () => { lookups += 1; return {}; },
    usageSummaryFn: async () => { lookups += 1; return {}; },
  } });
  for (const url of ["/_ccdx/ui/models/live", "/_ccdx/ui/usage"]) {
    const result = await invoke(handler, { method: "POST", url, origin: "http://127.0.0.1:2026", body: {} });
    assert.equal(result.status, 405);
  }
  assert.equal(lookups, 0);
});

test("dashboard API rejects cross-site simple GETs before expensive lookups", async () => {
  let lookups = 0;
  const handler = createAdapterHandler({ dashboardOptions: {
    liveModelsFn: async () => { lookups += 1; return {}; },
    usageSummaryFn: async () => { lookups += 1; return {}; },
  } });
  for (const url of ["/_ccdx/ui/models/live", "/_ccdx/ui/usage"]) {
    const result = await invoke(handler, { url, dashboardHeader: "" });
    assert.equal(result.status, 403);
  }
  assert.equal(lookups, 0);
});
