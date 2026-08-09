import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAdapterStatus, readAdapterStatus } from "../src/cli-status.mjs";

function statusPayload(overrides = {}) {
  return {
    ok: true,
    name: "codex-copilot-dx",
    version: "0.5.0",
    pid: 1234,
    uptime_ms: 125000,
    process: { rss_bytes: 220 * 1024 * 1024, heap_used_bytes: 145 * 1024 * 1024 },
    requests: { total: 20, active: 1, completed: 19, errors: 2, aborted: 1, status_4xx: 2, status_5xx: 0 },
    stream_performance: {
      by_route: {
        responses: {
          ttft_ms: { avg: 1605.8, samples: 12 },
          tpot_us: { avg: 5621.6, samples: 11, unit: "us" },
        },
      },
    },
    admission: { activeRequests: 1, queued: 0, rejected: 0, timedOut: 0, waitMsAvg: 0 },
    response_history: { entries: 116, bytes: 64 * 1024 * 1024, evicted: 89 },
    image_optimization: {
      cache_entries: 5,
      cache_bytes: 380000,
      cache_max_bytes: 64 * 1024 * 1024,
      cache_hits: 476,
      cache_misses: 4,
    },
    image_history_pressure: {
      active_recovery_trees: 1,
      adapted_requests: 7,
      historical_images_omitted: 42,
      timeouts_recorded: 2,
    },
    copilot: { token_cached: true, token_expires_in_ms: 90000 },
    models: { models: 42, claude_models: 8 },
    limits: {
      max_body_bytes: 64 * 1024 * 1024,
      max_decoded_body_bytes: 128 * 1024 * 1024,
      response_history_max_bytes: 64 * 1024 * 1024,
    },
    ...overrides,
  };
}

test("readAdapterStatus: reads the loopback status endpoint once", async () => {
  const calls = [];
  const data = statusPayload();
  const result = await readAdapterStatus({
    host: "::1",
    port: 4321,
    timeoutMs: 100,
    fetchImpl: async (...args) => {
      calls.push(args);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  assert.equal(result.baseUrl, "http://[::1]:4321");
  assert.deepEqual(result.data, data);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "http://[::1]:4321/_ccdx/status");
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(calls[0][1].headers.Accept, "application/json");
});

test("formatAdapterStatus: summarizes runtime health with invocation-aware identity", () => {
  const output = formatAdapterStatus({
    baseUrl: "http://127.0.0.1:2026",
    data: statusPayload(),
  }, { commandName: "codex-copilot-dx" });

  assert.match(output, /^codex-copilot-dx status/m);
  assert.match(output, /Adapter 0\.5\.0.*PID 1234.*uptime 2m 5s/);
  assert.match(output, /19\/20 completed, 1 active, 2 4xx, 0 5xx, 1 aborted/);
  assert.match(output, /TTFT avg 1\.61s \(12 samples\), TPOT avg 5\.62ms\/token/);
  assert.match(output, /History: 64\.0MiB \/ 64\.0MiB, 116 entries, 89 evicted/);
  assert.match(output, /Image cache: 5 entries, 99\.2% hits/);
  assert.match(output, /Visual history: 1 recovery trees, 7 adapted requests, 42 older images omitted, 2 timeouts/);
  assert.match(output, /Models: 42 total, 8 Claude/);
  assert.match(output, /request body 64\.0MiB, decoded body 128\.0MiB/);
  assert.doesNotMatch(output, /Profiles:|Routing:/);
});

test("formatAdapterStatus: summarizes dual profiles and routing when available", () => {
  const output = formatAdapterStatus({
    baseUrl: "http://127.0.0.1:2026",
    data: statusPayload({
      profiles: {
        codex: {
          mode: "legacy",
          client: { token_cached: true, token_expires_in_ms: 90_000 },
          models: { source: "live", models: 42, claude_models: 8 },
        },
        claude: {
          mode: "isolated",
          client: { token_cached: false, token_expires_in_ms: null },
          models: { source: "cache", models: 12, claude_models: 12 },
        },
      },
      routing: { responses: "codex", messages: "claude" },
      requests: {
        total: 10,
        completed: 10,
        by_route: {
          pm_models: { total: 2, active: 0, errors: 0 },
          pm_chat_completions: { total: 4, active: 1, errors: 1 },
          pm_responses: { total: 3, active: 0, errors: 0 },
          pm_embeddings: { total: 1, active: 0, errors: 0 },
        },
      },
    }),
  });

  assert.match(output, /Profiles: Codex legacy: token cached \(1m 30s remaining\), 42 total\/8 Claude models \(live\)/);
  assert.match(output, /Claude isolated: token not cached, 12 total\/12 Claude models \(cache\)/);
  assert.match(output, /Routing: \/v1\/responses -> Codex; \/v1\/messages -> Claude/);
  assert.match(output, /PM relay: 10 requests, 1 active, 1 errors; models 2, chat 4, responses 3, embeddings 1/);
});

test("formatAdapterStatus: warns when the running adapter is older than the CLI", () => {
  const output = formatAdapterStatus({
    baseUrl: "http://127.0.0.1:2026",
    data: statusPayload({ version: "0.4.44" }),
  }, { cliVersion: "0.5.0" });

  assert.match(output, /\[WARN\] Adapter 0\.4\.44.*this CLI is 0\.5\.0.*stop the running adapter before switching versions/);
});

test("formatAdapterStatus: tolerates absent optional metrics", () => {
  const output = formatAdapterStatus({
    baseUrl: "http://127.0.0.1:2026",
    data: statusPayload({
      process: undefined,
      requests: undefined,
      stream_performance: undefined,
      admission: undefined,
      response_history: undefined,
      image_optimization: undefined,
      image_history_pressure: undefined,
      copilot: undefined,
      models: undefined,
      limits: undefined,
    }),
  });

  assert.match(output, /Requests: n\/a\/n\/a completed/);
  assert.match(output, /TTFT avg n\/a \(n\/a samples\), TPOT avg n\/a/);
  assert.match(output, /Memory: RSS n\/a, heap n\/a/);
  assert.match(output, /Copilot token not cached/);
});

test("readAdapterStatus: reports HTTP, JSON, protocol, connection, and timeout failures", async (t) => {
  await t.test("HTTP", async () => {
    await assert.rejects(
      readAdapterStatus({ fetchImpl: async () => new Response("forbidden", { status: 403 }) }),
      /returned HTTP 403/,
    );
  });

  await t.test("invalid JSON", async () => {
    await assert.rejects(
      readAdapterStatus({ fetchImpl: async () => new Response("not-json", { status: 200 }) }),
      /returned invalid JSON/,
    );
  });

  await t.test("incompatible payload", async () => {
    await assert.rejects(
      readAdapterStatus({
        fetchImpl: async () => new Response(JSON.stringify({ ok: true, name: "other", version: "1", pid: 1 })),
      }),
      /incompatible status payload/,
    );
  });

  await t.test("not running", async () => {
    const error = new Error("fetch failed", { cause: { code: "ECONNREFUSED" } });
    await assert.rejects(
      readAdapterStatus({ fetchImpl: async () => { throw error; } }),
      /adapter is not running/,
    );
  });

  await t.test("timeout", async () => {
    const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    await assert.rejects(
      readAdapterStatus({ timeoutMs: 5, fetchImpl }),
      /timed out after 5ms/,
    );
  });
});
