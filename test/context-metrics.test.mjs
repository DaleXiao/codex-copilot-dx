import test from "node:test";
import assert from "node:assert/strict";
import { createStreamPerformanceMetrics } from "../src/stream-performance.mjs";
import { observeContextSession } from "../src/context-metrics.mjs";
import { runWithRequestContext } from "../src/request-context.mjs";
import { invokeAdapter } from "../test-support/adapter.mjs";

test("Responses handler observes the real upstream usage without rewriting the response", async () => {
  const metrics = createStreamPerformanceMetrics(), previous = process.env.CCDX_DISABLE_USAGE;
  process.env.CCDX_DISABLE_USAGE = "1";
  const response = { id: "context-native", object: "response", status: "completed", model: "gpt-6.1-sol", output: [],
    usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 60 }, output_tokens: 3, total_tokens: 123 } };
  try {
    const result = await invokeAdapter({ streamPerformanceMetrics: metrics, getCachedModelEndpointsFn: () => ["/responses"], responsesFn: async () => Response.json(response) },
      { body: { model: response.model, input: "private fixture", stream: false }, headers: { session_id: "private-session" } });
    assert.equal(result.status, 200);assert.deepEqual(JSON.parse(result.text), response);
    const point = metrics.contextSnapshot().sessions[0].points[0];
    assert.equal(point.input_tokens, 120);assert.equal(point.cached_input_tokens, 60);
    assert.doesNotMatch(JSON.stringify(metrics.contextSnapshot()), /private fixture|private-session/);
  } finally { if (previous === undefined) delete process.env.CCDX_DISABLE_USAGE;else process.env.CCDX_DISABLE_USAGE = previous; }
});

function fixture() {
  let now = 0;
  const metrics = createStreamPerformanceMetrics({ now: () => now, routeNames: ["responses", "responses_compact", "messages"] });
  function begin({ session = "private-session", agent, profile = "private-account", model = "test", route = "responses", application = "codex_app", body = {} } = {}) {
    const tracker = metrics.begin(route, { requestId: `r${now}`, application });tracker.setProvider("github");tracker.setModel(model, { configured: true });
    runWithRequestContext({ streamPerformance: tracker }, () => observeContextSession(body,
      { ...(session ? { session_id: session } : {}), ...(agent ? { "x-claude-code-agent-id": agent } : {}) }, { profileId: () => profile }));
    return tracker;
  }
  const finish = (tracker, input = 100, cache = 40) => { tracker.observeContext({ input_tokens: input, cached_input_tokens: cache, context_window_tokens: 1000 });now++;tracker.terminal("completed");tracker.finish({ statusCode: 200 }); };
  return { metrics, begin, finish, advance: ms => { now += ms; } };
}

test("context tracks reported values, explicit compactions and missing identity without retaining content", () => {
  const f = fixture();
  f.finish(f.begin({ body: { get input() { throw Error("Do not read prompts"); } } }));
  f.finish(f.begin(), 200, 80);f.finish(f.begin({ route: "responses_compact" }), 200);
  f.finish(f.begin({ session: null }), 50, null);
  const snapshot = f.metrics.contextSnapshot();
  assert.equal(snapshot.sessions.length, 1);assert.equal(snapshot.sessions[0].points.length, 2);
  assert.equal(snapshot.sessions[0].points[1].cached_input_tokens, 80);
  assert.equal(snapshot.sessions[0].compactions.length, 1);assert.equal(snapshot.unassigned.length, 1);
  assert.equal(snapshot.unassigned[0].cached_input_tokens, null);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-session|private-account|prompt/);
  snapshot.sessions[0].points[0].input_tokens = 9999;
  assert.equal(f.metrics.contextSnapshot().sessions[0].points[0].input_tokens, 100);
});

test("context separates accounts, clients, models and subagents and marks overlapping requests", () => {
  const f = fixture(), first = f.begin();f.advance(10);const second = f.begin();
  f.finish(second, 200);f.finish(first, 100);
  for (const options of [{ profile: "other" }, { agent: "worker" }, { model: "other" }, { application: "claude_app" }]) f.finish(f.begin(options));
  const sessions = f.metrics.contextSnapshot().sessions;
  assert.equal(sessions.length, 5);
  const concurrent = sessions.find(entry => entry.points.length === 2);
  assert.equal(concurrent.concurrent, true);assert.deepEqual(concurrent.points.map(point => point.input_tokens), [100, 200]);
});

test("context bounds retained metadata and never invents usage, cache or window", () => {
  const f = fixture();for (let index = 0; index < 70; index++) f.finish(f.begin(), index, index + 1);
  let snapshot = f.metrics.contextSnapshot();assert.equal(snapshot.sessions[0].points.length, 64);
  assert.equal(snapshot.sessions[0].points[0].cached_input_tokens, null);
  for (let index = 0; index < 70; index++) f.finish(f.begin({ session: `session-${index}` }));
  for (let index = 0; index < 25; index++) f.begin({ session: null }).finish({ statusCode: 400 });
  snapshot = f.metrics.contextSnapshot();assert.equal(snapshot.sessions.length, 64);assert.equal(snapshot.unassigned.length, 20);
  assert.equal(snapshot.unassigned[0].input_tokens, null);assert.equal(snapshot.unassigned[0].context_window_tokens, null);
});

test("context accepts bounded declared metadata, ignores invalid IDs and cannot reject requests", () => {
  const f = fixture();f.finish(f.begin({ session: null, body: { metadata: { user_id: JSON.stringify({ session_id: "declared-session" }) } } }));
  f.finish(f.begin({ session: "a".repeat(513) }));f.finish(f.begin({ session: "bad\nvalue" }));
  const tracker = f.begin({ session: null });
  assert.doesNotThrow(() => runWithRequestContext({ streamPerformance: tracker }, () => observeContextSession({}, { session_id: "valid" }, { profileId() { throw Error("unavailable"); } })));
  f.finish(tracker);
  assert.equal(f.metrics.contextSnapshot().sessions.length, 1);assert.equal(f.metrics.contextSnapshot().unassigned.length, 3);
});
