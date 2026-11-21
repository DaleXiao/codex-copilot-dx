import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeHealthProbes, isClaudeHealthProbe } from "../src/providers/claude-health-probes.mjs";

const body = { model: "fixture", max_tokens: 1, messages: [{ role: "user", content: "." }] };
const result = () => Response.json({ type: "message", role: "assistant", stop_reason: "max_tokens", content: [{ type: "text", text: "." }] });
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
  await pool.run(options, send);
  now = 249;await pool.run(options, send);
  assert.equal(calls, 1);
  await pool.run({ ...options, headers: { "anthropic-beta": "fixture" } }, send);
  assert.equal(calls, 2);
  await pool.run({ ...options, headers: { Authorization: "Bearer different-synthetic-key" } }, send);
  assert.equal(calls, 3);
  now = 250;await pool.run(options, send);
  assert.equal(calls, 4);
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
  assert(info.claimUsage());
  assert(!info.claimUsage());
});

test("real refusals and malformed success never enter the completed probe window", async t => {
  const pool = createClaudeHealthProbes();
  t.after(() => pool.clear());
  let calls = 0;
  const refuse = async () => { calls++;return Response.json({ error: { type: "rate_limit_error" } }, { status: 429 }); };
  assert.equal((await pool.run(options, refuse)).status, 429);
  assert.equal((await pool.run(options, refuse)).status, 429);
  await pool.run(options, () => Response.json({ ok: true }));
  assert.equal((await pool.run(options, refuse)).status, 429);
  assert.equal(calls, 3);
});
