import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startClaudeGateway, createMessagesObserver } from "../src/claude-gateway.mjs";
import { buildMessagesUsageRecord, usageCacheHitRate } from "../src/usage-store.mjs";
import { currentRequestContext } from "../src/request-context.mjs";

const key = "ccdx_m365_" + "a".repeat(64);
const message = { id: "msg_synthetic", type: "message", role: "assistant", model: "claude-opus-5.5",
  content: [{ type: "text", text: "Hello 测试 😀" }], stop_reason: "end_turn",
  usage: { input_tokens: 2, cache_read_input_tokens: 8, cache_creation_input_tokens: 5, output_tokens: 3 } };
async function gateway(t, messages, extra = {}) {
  const records = [], calls = [];
  const server = await startClaudeGateway({ port: 0, apiKey: key, provider: {
    id: "m365", models: () => [{ id: "claude-opus-5.5", name: "Opus 5.5" }], client: { messages: async (body, options) => {
      calls.push(body);currentRequestContext()?.streamPerformance?.upstreamStarted();options.onUpstreamStart?.();return messages(body, options);
    } },
  }, record: value => records.push(value), ...extra });
  t.after(() => server.close());
  const request = (body, options = {}) => fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...options.headers },
    body: JSON.stringify(body || { model: "claude-opus-5.5", messages: [{ role: "user", content: "hello" }], max_tokens: 64 }),
    signal: AbortSignal.timeout(3000),
  });
  return { server, records, calls, request };
}

test("Claude gateway delivers Messages JSON and normalizes cache accounting once", async t => {
  const g = await gateway(t, async () => Response.json(message));
  const response = await g.request();assert.equal(response.status, 200);assert.deepEqual(await response.json(), message);
  assert.equal(g.calls.length, 1);assert.equal(g.records.length, 1);
  assert.equal(g.records[0].usage.input_tokens, 15);assert.equal(g.records[0].usage.total_tokens, 18);
  assert.equal(usageCacheHitRate(g.records[0].usage), 8 / 15);
  assert.equal(g.records[0].anthropic_usage.input_tokens, 2);
  assert.equal(g.server.snapshot().completed, 1);assert.equal(g.server.snapshot().active, 0);
});

test("Claude API failures expose safe transport facts without raw causes or extra diagnostic fields", async t => {
  const logs = [], error = Object.assign(new Error("ccdx_api_network_unavailable"), { code: "ccdx_api_network_unavailable", statusCode: 502,
    cause: new Error("synthetic-private-upstream-key"), transport: { code: "ECONNRESET", phase: "tls", reused_socket: true, key: "synthetic-private-upstream-key" } });
  const g = await gateway(t, async () => { throw error; }, { log: (...args) => logs.push(args) });
  const response = await g.request();assert.equal(response.status, 502);const value = await response.json();
  assert.deepEqual(value.error.diagnostic, { code: "ECONNRESET", phase: "tls", reused_socket: true });
  assert.equal(JSON.stringify(value).includes("synthetic-private-upstream-key"), false);
  assert.match(logs[0][1], /ECONNRESET, tls/);assert.equal(JSON.stringify(logs).includes("synthetic-private-upstream-key"), false);
});

test("Claude gateway preserves stream bytes, completes at message_stop and cancels its upstream reader", async t => {
  const events = [
    { type: "message_start", message: { ...message, content: [], stop_reason: null } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello 测试 😀" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  const bytes = Buffer.from(events.map(e => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(""));
  let offset = 0, cancelled = false;
  const g = await gateway(t, async () => new Response(new ReadableStream({
    pull(controller) { if (offset < bytes.length) { const end = Math.min(bytes.length, offset + 7);controller.enqueue(bytes.subarray(offset, end));offset = end; } },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } }));
  const response = await g.request({ model: "claude-opus-5.5", messages: [], stream: true });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);assert.equal(cancelled, true);
  assert.equal(g.server.snapshot().completed, 1);assert.equal(g.records.length, 1);
  assert.equal(g.server.snapshot().performance.by_route.messages.terminal_outcomes.by_model["claude-opus-5.5"].completed, 1);
});

test("empty and signature-only Claude deltas do not count as first model output", async t => {
  const events = [{ type: "message_start", message: { ...message, content: [] } },
    { type: "content_block_delta", index: 4, delta: { type: "text_delta", text: "" } },
    { type: "content_block_delta", index: 4, delta: { type: "signature_delta", signature: "opaque-signature" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }, { type: "message_stop" }];
  const bytes = Buffer.from(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  const g = await gateway(t, async () => new Response(bytes, { headers: { "Content-Type": "text/event-stream" } }));
  assert.deepEqual(Buffer.from(await (await g.request({ model: "claude-opus-5.5", messages: [], stream: true })).arrayBuffer()), bytes);
  const stats = g.server.snapshot();
  assert.equal(stats.performance.by_route.messages.ttft_ms.samples, 0);
  assert.equal(stats.completed, 1);assert.equal(stats.active, 0);
});

test("sparse interleaved Claude tool, thinking and text blocks retain byte order across fragments", async t => {
  const events = [{ type: "message_start", message: { ...message, content: [] } },
    { type: "content_block_start", index: 9, content_block: { type: "tool_use", id: "tool_a", name: "read", input: {} } },
    { type: "content_block_start", index: 3, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 9, delta: { type: "input_json_delta", partial_json: '{"file":' } },
    { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "测试 😀" } },
    { type: "content_block_delta", index: 9, delta: { type: "input_json_delta", partial_json: '"a.txt"}' } },
    { type: "content_block_stop", index: 3 }, { type: "content_block_stop", index: 9 },
    { type: "content_block_start", index: 15, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 15, delta: { type: "thinking_delta", thinking: "reasoning" } },
    { type: "content_block_delta", index: 15, delta: { type: "signature_delta", signature: "opaque-kept" } },
    { type: "content_block_stop", index: 15 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } }, { type: "message_stop" }];
  const bytes = Buffer.from(events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  for (const size of [1, 7, 64]) {
    let offset = 0;
    const g = await gateway(t, async () => new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) { controller.close();return; }
      controller.enqueue(bytes.subarray(offset, offset + size));offset = Math.min(bytes.length, offset + size);
    } }), { headers: { "Content-Type": "text/event-stream" } }));
    const response = await g.request({ model: "claude-opus-5.5", messages: [], stream: true });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal(g.records.length, 1);assert.equal(g.server.snapshot().active, 0);
    assert.equal(g.server.snapshot().performance.by_route.messages.ttft_ms.samples, 1);
  }
});

test("Claude gateway applies configured body limits before upstream dispatch", async t => {
  const g = await gateway(t, async () => Response.json(message), { env: { CCDX_MAX_BODY_BYTES: "64" } });
  const response = await g.request({ model: "claude-opus-5.5", messages: [{ role: "user", content: "x".repeat(128) }] });
  assert.equal(response.status, 413);await response.text();assert.equal(g.calls.length, 0);
});

test("HTTP 200 without a Claude terminal is failed, and truncation remains incomplete", async t => {
  const g = await gateway(t, async body => body.stream ? new Response('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
    { headers: { "Content-Type": "text/event-stream" } }) : Response.json({ ...message, stop_reason: "max_tokens" }));
  const truncated = await g.request();await truncated.text();assert.equal(g.server.snapshot().incomplete, 1);
  const disconnected = await g.request({ model: "claude-opus-5.5", messages: [], stream: true });
  assert.match(await disconnected.text(), /ccdx_gateway_error/);assert.equal(g.server.snapshot().failed, 1);
  assert.equal(g.server.snapshot().active, 0);
});

test("a Claude error event cannot become a completed reply after message_stop", async t => {
  const bytes = Buffer.from([
    { type: "message_start", message },
    { type: "error", error: { type: "overloaded_error", message: "Synthetic upstream failure" } },
    { type: "message_stop" },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  const g = await gateway(t, async () => new Response(bytes, { headers: { "Content-Type": "text/event-stream" } }));
  const response = await g.request({ model: "claude-opus-5.5", messages: [], stream: true });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(g.server.snapshot().completed, 0);assert.equal(g.server.snapshot().failed, 1);
  assert.equal(g.server.snapshot().performance.by_route.messages.terminal_outcomes.by_origin.upstream_event.failed, 1);
});

test("browser requests and invalid local keys never reach the M365 provider", async t => {
  const g = await gateway(t, async () => Response.json(message));
  for (const [headers, status] of [[{ Origin: "http://evil.test" }, 403], [{ Authorization: "Bearer wrong" }, 401]]) {
    const response = await g.request(undefined, { headers });assert.equal(response.status, status);await response.text();
  }
  const invalidHost = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: g.server.port, path: "/v1/models", headers: { Host: "evil.test", "x-api-key": key } }, res => {
      res.resume();res.on("end", () => resolve(res.statusCode));
    });req.on("error", reject);req.end();
  });
  assert.equal(invalidHost, 403);
  assert.equal(g.calls.length, 0);assert.equal(g.records.length, 0);
  const models = await fetch(`http://127.0.0.1:${g.server.port}/v1/models?limit=1000`, { headers: { "x-api-key": key } });
  assert.deepEqual((await models.json()).data.map(x => x.id), ["claude-opus-5-5"]);
});

test("bounded Claude observation preserves UTF-8 and handles multiline events", () => {
  const events = [], observer = createMessagesObserver(value => events.push(value), 64);
  const bytes = Buffer.from('data: {"type":\ndata: "ping","text":"😀"}\n\n');
  for (const byte of bytes) observer.write(Uint8Array.of(byte));observer.finish();
  assert.deepEqual(events, [{ type: "ping", text: "😀" }]);
  assert.throws(() => createMessagesObserver(() => {}, 8).write(Buffer.from("data: "+"a".repeat(9))), /limit/);
});

test("missing cache telemetry stays unknown rather than fabricating a zero hit rate", () => {
  const record = buildMessagesUsageRecord({ model: "claude-test", usage: { input_tokens: 10, output_tokens: 2 } });
  assert.equal(record.usage.total_tokens, 12);assert.equal(usageCacheHitRate(record.usage), null);
  assert.equal(buildMessagesUsageRecord({ usage: {} }), null);
});

test("Claude timeout and count_tokens preserve status facts; cancellation is an info notice", async t => {
  const logs = [];
  const g = await gateway(t, async (_body, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }), { env: { CCDX_UPSTREAM_TIMEOUT_MS: "30" }, log: (...args) => logs.push(args) });
  const timedOut = await g.request();assert.equal(timedOut.status, 504);await timedOut.text();
  const counts = await fetch(`http://127.0.0.1:${g.server.port}/v1/messages/count_tokens`, { method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key }, body: JSON.stringify({ model: "claude-opus-5.5", messages: [] }), signal: AbortSignal.timeout(3000) });
  assert.equal(counts.status, 504);await counts.text();assert.equal(g.server.snapshot().failed, 1);
  assert.ok(logs.every(([level, text]) => level === "warn" && text.includes("upstream_timeout")));
  const cancelled = await gateway(t, async (_body, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }), { log: (...args) => logs.push(args) });
  const controller = new AbortController();
  const pending = fetch(`http://127.0.0.1:${cancelled.server.port}/v1/messages`, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({ model: "claude-opus-5.5", messages: [] }), signal: controller.signal });
  const deadline = Date.now() + 3000;
  while (!cancelled.calls.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(cancelled.calls.length, 1);controller.abort();await assert.rejects(pending, { name: "AbortError" });
  while (cancelled.server.snapshot().active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(cancelled.server.snapshot().cancelled, 1);assert.equal(cancelled.server.snapshot().failed, 0);
  assert.equal(logs.at(-1)[0], "info");
  const recent = cancelled.server.snapshot().performance.recent_requests.at(-1);
  assert.equal(recent.http_status, 499);assert.equal(recent.origin, "client_disconnect");
});
