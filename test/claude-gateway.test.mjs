import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startClaudeGateway, createMessagesObserver } from "../src/claude-gateway.mjs";
import { buildMessagesUsageRecord, usageCacheHitRate } from "../src/usage-store.mjs";
import { currentRequestContext } from "../src/request-context.mjs";
import { claudeModelEntries } from "../src/claude-models.mjs";
import { createStreamPerformanceMetrics } from "../src/stream-performance.mjs";

const key = "ccdx_m365_" + "a".repeat(64);
test("unaliased stream framing never forwards a severed JSON fragment and keeps a complete final event", () => {
  const observed = [], reader = createMessagesObserver(value => observed.push(value));
  assert.equal(reader.write(Buffer.from('event: message_start\ndata: {"type":"message_start"}\n\ndata: {"type":"content_')).length, 1);
  assert.throws(() => reader.finish(), /Invalid Claude stream event/);
  const ended = createMessagesObserver(value => observed.push(value));
  assert.equal(ended.write(Buffer.from('data: {"type":"message_stop"}')).length, 0);
  const final = Buffer.concat(ended.finish()).toString();assert.match(final, /message_stop/);assert.match(final, /\n\n$/);
});
const message = { id: "msg_synthetic", type: "message", role: "assistant", model: "claude-opus-5.5",
  content: [{ type: "text", text: "Hello 测试 😀" }], stop_reason: "end_turn",
  usage: { input_tokens: 2, cache_read_input_tokens: 8, cache_creation_input_tokens: 5, output_tokens: 3 } };
async function gateway(t, messages, extra = {}) {
  const records = [], calls = [];
  const server = await startClaudeGateway({ port: 0, apiKey: key, provider: {
    id: "m365", profileId: () => "test-profile", models: () => [{ id: "claude-opus-5.5", name: "Opus 5.5" }], client: { messages: async (body, options) => {
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
  const performance = createStreamPerformanceMetrics({ routeNames: ["messages"] });
  const g = await gateway(t, async () => Response.json(message), { performance });
  const response = await g.request(undefined, { headers: { session_id: "test-session" } });assert.equal(response.status, 200);assert.deepEqual(await response.json(), message);
  assert.equal(g.calls.length, 1);assert.equal(g.records.length, 1);
  assert.equal(g.records[0].usage.input_tokens, 15);assert.equal(g.records[0].usage.total_tokens, 18);
  assert.equal(usageCacheHitRate(g.records[0].usage), 8 / 15);
  assert.equal(g.records[0].anthropic_usage.input_tokens, 2);
  assert.equal(g.server.snapshot().completed, 1);assert.equal(g.server.snapshot().active, 0);
  const observed = performance.contextSnapshot().sessions[0].points[0];
  assert.equal(observed.input_tokens, 15);assert.equal(observed.cached_input_tokens, 8);
  assert.equal(observed.context_window_tokens, null);
});

test("Messages context observes declared, effective and pinned windows without another catalog read", async t => {
  const raw = { capabilities: { limits: { max_context_window_tokens: 1234567 } } };
  const cases = [
    { name: "legacy declared metadata", metadata: raw, expected: 1234567 },
    { name: "effective override", configured: true, metadata: { ...raw, capability: { values: { context_window: 345678 } } }, expected: 345678 },
    { name: "Messages protocol", configured: true, metadata: { capability: { values: { context_window: 999999 } }, protocol_capabilities: { messages: { values: { context_window: 222222 } } } }, expected: 222222 },
    { name: "pinned route capability", resolved: { values: { context_window: 555555 } }, expected: 555555 },
    { name: "pinned unknown", resolved: { values: {} }, expected: null },
    { name: "unknown effective override", metadata: { ...raw, capability: { values: {} } }, expected: null },
    { name: "invalid declared value", metadata: { capabilities: { limits: { max_context_window_tokens: "1000000" } } }, expected: null },
  ];
  for (const item of cases) await t.test(item.name, async t => {
    let reads = 0, calls = 0, finished = 0;
    const source = { id: item.resolved ? "api_test" : "m365", configuredModels: item.configured,
      models() { reads++;if (item.resolved) throw Error("Do not re-read a pinned capability");return [{ id: message.model, ...item.metadata }]; },
      client: { messages: async body => { calls++;assert.equal(body.model, message.model);return Response.json(message); } } };
    const g = await gateway(t, null, { provider: source, ...(item.resolved ? { resolveRequest: () => ({ provider: source, model: message.model,
      capability: item.resolved, finish: () => { finished++; } }) } : {}) });
    const response = await g.request();assert.equal(response.status, 200);assert.deepEqual(await response.json(), message);
    const observed = g.server.snapshot().performance.recent_requests.at(-1);
    assert.equal(observed.context.context_window_tokens, item.expected);
    assert.equal(observed.context.input_tokens, 15);assert.equal(calls, 1);
    assert.equal(reads, item.resolved ? 0 : 1);assert.equal(finished, item.resolved ? 1 : 0);
    assert.equal(observed.provider, source.id);
  });
});

test("unavailable observation metadata keeps Messages available and provider-applied windows retain priority", async t => {
  for (const applied of [null, 765432]) await t.test(String(applied), async t => {
    let calls = 0;
    const source = { id: "api_test", models() { throw Error("Optional catalog unavailable"); }, client: {
      messages: async () => { calls++;if (applied) currentRequestContext().streamPerformance.observeContext({ context_window_tokens: applied });return Response.json(message); },
    } };
    const g = await gateway(t, null, { provider: source, ...(applied ? { resolveRequest: () => ({ provider: source, model: message.model, capability: { values: { context_window: 987654 } } }) } : {}) });
    const response = await g.request();assert.equal(response.status, 200);assert.deepEqual(await response.json(), message);
    assert.equal(calls, 1);assert.equal(g.server.snapshot().performance.recent_requests.at(-1).context.context_window_tokens, applied);
  });
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

test("App alias streaming changes only the model event across fragmented multiline SSE", async t => {
  const actual = "deepseek-v4.1-flash-1017", models = [{ id: actual, capabilities: { limits: { max_context_window_tokens: 456789 } } }], alias = claudeModelEntries(models, { desktopAliases: true })[0].name;
  const first = { type: "message_start", message: { ...message, model: actual, content: [], vendor: { untouched: true } } };
  const tail = 'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"测试 😀"}}\r\n\r\n'
    + 'event: content_block_delta\ndata: {"type":"content_block_delta","index":9,"delta":{"type":"signature_delta","signature":"opaque-signature"}}\n\n'
    + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n'
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const bytes = Buffer.from(': keep comment\r\nevent: message_start\r\nid: frame-1\r\ndata: {"type":"message_start",\r\ndata: "message":' + JSON.stringify(first.message) + '}\r\n\r\n' + tail);
  for (const size of [1, 7, 65536]) {
    let offset = 0;const calls = [];
    const g = await gateway(t, null, { desktopAliases: true, provider: { id: "api_test", configuredModels: true, models: () => models,
      client: { messages: async body => { calls.push(body);return new Response(new ReadableStream({ pull(controller) {
        if (offset === bytes.length) { controller.close();return; }
        controller.enqueue(bytes.subarray(offset, offset + size));offset = Math.min(bytes.length, offset + size);
      } }), { headers: { "Content-Type": "text/event-stream" } }); } } } });
    const response = await g.request({ model: alias, messages: [], stream: true });assert.equal(response.status, 200);
    const wire = await response.text();assert.ok(wire.endsWith(tail), "non-model frames, signatures and UTF-8 keep their bytes");
    assert.ok(wire.startsWith(': keep comment\r\nevent: message_start\r\nid: frame-1\r\n'));
    const observed = [], observer = createMessagesObserver(event => observed.push(event));observer.write(Buffer.from(wire));observer.finish();
    assert.deepEqual(observed[0], { ...first, message: { ...first.message, model: alias } });
    assert.equal(calls[0].model, actual);assert.equal(g.records[0].model, actual);assert.equal(g.server.snapshot().last_model, actual);
    assert.equal(g.server.snapshot().performance.recent_requests.at(-1).context.context_window_tokens, 456789);
    assert.equal(g.server.snapshot().completed, 1);
    const catalog = await fetch(`http://127.0.0.1:${g.server.port}/v1/models`, { headers: { "x-api-key": key } });
    assert.deepEqual((await catalog.json()).data, [{ id: alias, type: "model", display_name: actual }]);
  }
});

test("App aliases cover JSON and count_tokens while bounded framing rejects oversized comments", async t => {
  const actual = "qwen3.8-max", models = [{ id: actual, capability: { values: { context_window: 234567 } } }], alias = claudeModelEntries(models, { desktopAliases: true })[0].name, calls = [];
  const g = await gateway(t, null, { desktopAliases: true, provider: { id: "api_test", configuredModels: true, models: () => models, client: {
    messages: async (body, options) => { calls.push({ body, options });return Response.json(options.countTokens ? { input_tokens: 42 } : { ...message, model: actual }); },
  } } });
  assert.equal((await (await g.request({ model: alias, messages: [] })).json()).model, alias);
  const counts = await fetch(`http://127.0.0.1:${g.server.port}/v1/messages/count_tokens`, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key }, body: JSON.stringify({ model: alias, messages: [] }) });
  assert.deepEqual(await counts.json(), { input_tokens: 42 });assert.ok(calls.every(call => call.body.model === actual));assert.equal(calls[1].options.countTokens, true);
  assert.equal(g.records.length, 1);assert.equal(g.records[0].model, actual);
  const recorded = g.server.snapshot().performance.recent_requests;
  assert.equal(recorded.length, 1);assert.equal(recorded[0].context.context_window_tokens, 234567);
  const observer = createMessagesObserver(() => {}, 64, alias);
  assert.throws(() => { for (let i = 0; i < 8; i++) observer.write(Buffer.from(": comment\n")); }, /limit/);
});

test("custom App system messages become ordered top-level text without changing conversation blocks", async t => {
  const calls = [], models = [{ id: "vendor-model" }], alias = claudeModelEntries(models, { desktopAliases: true })[0].name;
  const g = await gateway(t, null, { desktopAliases: true, provider: { id: "api_test", configuredModels: true, models: () => models,
    client: { messages: async body => { calls.push(body);return Response.json({ ...message, model: body.model }); } } } });
  const cache = { type: "text", text: "second", cache_control: { type: "ephemeral" } }, conversation = [{ role: "user", content: [{ type: "text", text: "request" }] }];
  const input = { model: alias, system: "original", messages: [{ role: "system", content: "first" }, { role: "system", content: [cache] }, ...conversation], max_tokens: 8 };
  assert.equal((await g.request(input)).status, 200);
  assert.deepEqual(calls[0].system, [{ type: "text", text: "original" }, { type: "text", text: "first" }, cache]);
  assert.deepEqual(calls[0].messages, conversation);assert.equal(calls[0].model, models[0].id);
  assert.equal((await g.request({ ...input, messages: [...conversation, { role: "system", content: "late" }] })).status, 200);
  assert.deepEqual(calls[1].messages, conversation);assert.deepEqual(calls[1].system, [{ type: "text", text: "original" }, { type: "text", text: "late" }]);
  assert.equal((await g.request({ ...input, messages: [{ role: "system", content: [{ type: "image" }] }, ...conversation] })).status, 400);
  assert.equal(calls.length, 2, "invalid system content fails before inference");
  const legacy = await gateway(t, async body => Response.json({ ...message, echoed_roles: body.messages.map(message => message.role) }));
  const reply = await legacy.request({ model: "claude-opus-5.5", messages: [{ role: "system", content: "legacy" }, ...conversation] });
  assert.deepEqual((await reply.json()).echoed_roles, ["system", "user"], "other gateway paths keep their existing behavior");
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

test('capability waiting does not restart a count caller\'s upstream timeout budget',async t=>{
 const {setTimeout:wait}=await import('node:timers/promises');let continued=false;
 const g=await gateway(t,async(_body,options)=>{await wait(60,null,{signal:options.signal});continued=true;options.onUpstreamStart?.();await wait(60,null,{signal:options.signal});return Response.json({input_tokens:1});},{env:{CCDX_UPSTREAM_TIMEOUT_MS:'100'}});
 const r=await fetch(`http://127.0.0.1:${g.server.port}/v1/messages/count_tokens`,{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key},body:JSON.stringify({model:'claude-opus-5.5',messages:[]}),signal:AbortSignal.timeout(3000)});
 assert.equal(r.status,504);await r.text();assert.equal(continued,true);assert.equal(g.server.snapshot().failed,0,'A count timeout is not a generation failure');
});
