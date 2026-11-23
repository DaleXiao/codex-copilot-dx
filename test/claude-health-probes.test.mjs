import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeHealthProbes, isClaudeHealthProbe } from "../src/providers/claude-health-probes.mjs";

const body = { model: "fixture", max_tokens: 1, messages: [{ role: "user", content: "." }] };
const message = (content, stop_reason = "max_tokens") => ({ type: "message", role: "assistant", stop_reason, content });
const result = () => Response.json(message([{ type: "text", text: "." }]));
const options = { url: "https://fixture.test/v1/messages", headers: {}, bodyText: JSON.stringify(body), maxResponseBytes: 4096, record() {} };

test("health checks are an exact request shape without session state", () => {
  assert(isClaudeHealthProbe(body, {}));
  assert(!isClaudeHealthProbe({ ...body, tools: [] }, {}));
  assert(!isClaudeHealthProbe(body, { "session-id": "fixture" }));
  assert(!isClaudeHealthProbe({ ...body, max_tokens: 2 }, {}));
});

test("a successful health check expires at 250ms and only identical prepared requests share it", async t => {
  let now = 0, calls = 0;
  const pool = createClaudeHealthProbes({ now: () => now });
  t.after(() => pool.clear());
  const send = () => { calls++;return result(); };
  const observations = [];
  const request = { ...options, record: value => observations.push(value) };
  await pool.run(request, send);
  now = 249;await pool.run(request, send);
  assert.equal(calls, 1);
  for (const variant of [
    { headers: { "anthropic-beta": "fixture" } },
    { headers: { "anthropic-version": "2026-10-21" } },
    { headers: { Authorization: "Bearer different-synthetic-key" } },
    { bodyText: JSON.stringify({ ...body, output_config: { effort: "high" } }) },
    { url: "https://other.fixture.test/v1/messages" },
  ]) {
    await pool.run({ ...request, ...variant }, send);
    assert.notEqual(observations.at(-1).group, observations[0].group);
    assert.equal(observations.at(-1).state, "stored");
  }
  assert.equal(observations[1].state, "reused_recent");
  assert.match(observations[0].group, /^[a-f0-9]{16}$/);
  assert.equal(observations[0].group, observations[1].group);
  now = 250;await pool.run(request, send);
  assert.equal(observations.at(-1).state, "stored");
  assert.equal(observations.at(-1).group, observations[0].group);
  assert.equal(calls, 7);
});

test("terminal empty and opaque thinking responses are replayed intact only within their source and credential", async t => {
  const first = createClaudeHealthProbes(), second = createClaudeHealthProbes();
  t.after(() => { first.clear();second.clear(); });
  for (const [shape, payload] of [
    ["empty", message([], "end_turn")],
    ["thinking_only", message([{ type: "thinking", thinking: "", signature: "synthetic-signature" }])],
    ["thinking_only", message([{ type: "redacted_thinking", data: "synthetic-opaque-data" }])],
  ]) {
    first.clear();second.clear();
    let info, calls = 0;
    const send = () => { calls++;return Response.json(payload); };
    const request = { ...options, headers: { "anthropic-version": "2026-10-21" }, record(value) { info = value; } };
    const original = await first.run(request, send);
    assert.deepEqual(await original.json(), payload);
    assert.equal(info.shape, shape);
    assert.equal(info.state, "stored");
    const group = info.group;
    assert(info.claimUsage());
    const replayed = await first.run(request, send);
    assert.deepEqual(await replayed.json(), payload);
    assert.equal(info.state, "reused_recent");
    assert.equal(info.group, group);
    assert(!info.claimUsage());
    await first.run({ ...request, headers: { ...request.headers, Authorization: "Bearer separate-account" } }, send);
    assert.equal(info.state, "stored");
    assert.notEqual(info.group, group);
    await second.run(request, send);
    assert.equal(info.state, "stored");
    assert.notEqual(info.group, group);
    assert.equal(calls, 3);
  }
});

test("a cancelled probe does not cancel another waiter's result and usage can be claimed only once", async t => {
  const pool = createClaudeHealthProbes();
  t.after(() => pool.clear());
  const first = new AbortController(), started = Promise.withResolvers(), release = Promise.withResolvers();
  const send = async signal => { started.resolve();await release.promise;assert(!signal.aborted);return result(); };
  const a = pool.run({ ...options, signal: first.signal }, send);
  await started.promise;
  let info;
  const b = pool.run({ ...options, record(value) { info = value; } }, send);
  const cancelled = assert.rejects(a, { name: "AbortError" });
  first.abort();
  await cancelled;
  release.resolve();
  assert.equal((await b).status, 200);
  assert.equal(info.reused, true);
  assert.equal(info.state, "reused_inflight");
  assert(info.claimUsage());
  assert(!info.claimUsage());
});

test("real refusals and malformed success never enter the completed probe window", async t => {
  const pool = createClaudeHealthProbes();
  t.after(() => pool.clear());
  let info;
  const request = { ...options, maxResponseBytes: 16384, record(value) { info = value; } };
  for (const [shape, send] of [
    ["http_status", () => Response.json({ error: { type: "rate_limit_error" } }, { status: 429, headers: { "retry-after": "2" } })],
    ["invalid_message", () => new Response("invalid JSON")],
    ["invalid_message", () => Response.json({ ok: true })],
    ["invalid_message", () => Response.json(message([], "refusal"))],
    ["other_content", () => Response.json(message([{ type: "tool_use", input: {} }]))],
    ["other_content", () => Response.json(message([{ type: "thinking" }]))],
    ["too_large", () => Response.json(message([{ type: "thinking", thinking: "x".repeat(9000) }]))],
  ]) {
    const response = await pool.run(request, send);
    assert.equal(info.state, "not_stored");
    assert.equal(info.shape, shape);
    if (shape === "http_status") {
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "2");
    }
  }
  await pool.run(request, result);
  assert.equal(info.state, "stored");
});
