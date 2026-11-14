import test from "node:test";
import assert from "node:assert/strict";
import { createToolActivity, TOOL_ACTIVITY_LIMITS, isToolActivityOutput } from "../src/tool-activity.mjs";
import { createStreamPerformanceMetrics, markToolActivity } from "../src/stream-performance.mjs";
import { runWithRequestContext } from "../src/request-context.mjs";

const meta = (session = "a".repeat(64), application = "codex_app") => ({ session, application, provider: "github", model: "model" });
const call = (id, name = "read_file") => ({ type: "function_call", call_id: id, name, arguments: "private payload" });
test("tool observations match results by scoped ID and retain parallel pending calls", () => {
  const activity = createToolActivity(), request = activity.request(() => meta());
  request.output({ output: [call("one"), call("two")] });request.finish("completed");
  const other = activity.request(() => meta("b".repeat(64)));
  other.input({ input: [{ type: "function_call_output", call_id: "one", output: "private result" }] });
  assert.deepEqual(activity.snapshot().items.map(x => x.state), ["waiting", "waiting"]);
  activity.request(() => meta()).input({ input: [{ type: "function_call_output", call_id: "one" }] });
  assert.deepEqual(activity.snapshot().items.map(x => x.state).sort(), ["returned", "waiting"]);
  const snapshot = JSON.stringify(activity.snapshot());
  assert.ok(!snapshot.includes("private"));assert.ok(!snapshot.includes("a".repeat(64)));assert.ok(!snapshot.includes('"one"'));
});
test("a call ID supplied after an item announcement still matches its result once", () => {
  const activity = createToolActivity(), request = activity.request(() => meta());
  request.output({ output_index: 0, item: { type: "function_call", id: "item_one", name: "read_file" } });
  request.output({ output_index: 0, item: { type: "function_call", id: "item_one", call_id: "call_one", name: "read_file" } });
  request.output({ output: [{ type: "function_call", id: "item_one", call_id: "call_one", name: "read_file" }] });request.finish("completed");
  activity.request(() => meta()).input({ input: [{ type: "function_call_output", call_id: "call_one" }] });
  assert.equal(activity.snapshot().items.length, 1);assert.equal(activity.snapshot().items[0].state, "returned");
});
test("client computer and shell calls wait for results even when generation is completed", () => {
  const activity = createToolActivity(), request = activity.request(() => meta());
  request.output({ output: ["computer_call", "shell_call"].map((type, i) => ({ type, id: `item-${i}`, call_id: `call-${i}`, status: "completed" })) });
  request.finish("completed");assert.ok(activity.snapshot().items.every(row => row.state === "waiting"));
  activity.request(() => meta()).input({ input: [{ type: "computer_call_output", call_id: "call-0" }, { type: "shell_call_output", call_id: "call-1" }] });
  assert.ok(activity.snapshot().items.every(row => row.state === "returned"));
});

test("Messages metadata completes and cancels without reading tool arguments or output", () => {
  const activity = createToolActivity(), m = () => meta("a".repeat(64), "claude_app");
  const request = activity.request(m);
  request.output({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "one", name: "search_files", get input() { throw Error("must not inspect arguments"); } } }, "messages");
  request.output({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "one", name: "search_files" } }, "messages");
  request.finish("completed");assert.equal(activity.snapshot().items.length, 1);
  activity.request(m).input({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "one", is_error: true, get content() { throw Error("must not inspect output"); } }] }] }, "messages");
  assert.equal(activity.snapshot().items[0].state, "failed");
  const cancelled = activity.request(m);cancelled.output({ type: "tool_use", id: "two", name: "run_command" }, "messages");cancelled.finish("cancelled");
  assert.equal(activity.snapshot().items[0].state, "cancelled");
  const native = activity.request(m);
  native.output({ type: "message", content: [{ type: "server_tool_use", id: "native", name: "web_search" }, { type: "web_search_tool_result", tool_use_id: "native", content: "not retained" }] }, "messages");
  native.finish("completed");assert.equal(activity.snapshot().items[0].state, "returned");
});

test("Gemini name-only results require an unambiguous call in the same session", () => {
  const activity = createToolActivity(), m = () => meta("a".repeat(64), "gemini_app"), request = activity.request(m);
  request.output({ candidates: [{ content: { parts: [{ functionCall: { name: "read_file" } }, { functionCall: { name: "search_files" } }] } }] }, "gemini");
  request.finish("completed");
  activity.request(m).input({ contents: [{ parts: [{ functionResponse: { name: "read_file", get response() { throw Error("must not inspect tool output"); } } }] }] }, "gemini");
  assert.deepEqual(activity.snapshot().items.map(x => x.state).sort(), ["returned", "waiting"]);
  const same = activity.request(() => meta("b".repeat(64), "gemini_app"));
  same.output({ candidates: [{ content: { parts: [{ functionCall: { name: "same" } }, { functionCall: { name: "same" } }] } }] }, "gemini");same.finish("completed");
  activity.request(() => meta("b".repeat(64), "gemini_app")).input({ contents: [{ parts: [{ functionResponse: { name: "same" } }] }] }, "gemini");
  assert.equal(activity.snapshot().items.filter(x => x.name === "same" && x.state === "waiting").length, 2);
});
test("Gemini streamed calls with the same part position keep distinct IDs and names", () => {
  const activity = createToolActivity(), m = () => meta("a".repeat(64), "gemini_app"), request = activity.request(m);
  for (const [id, name] of [["one", "read_file"], ["two", "search_files"]]) request.output({ response: { candidates: [{ content: { parts: [{ functionCall: { id, name } }] } }] } }, "gemini");
  request.finish("completed");assert.equal(activity.snapshot().items.length, 2);
  activity.request(m).input({ contents: [{ parts: [{ functionResponse: { id: "one", name: "read_file" } }] }] }, "gemini");
  assert.deepEqual(activity.snapshot().items.map(row => row.state).sort(), ["returned", "waiting"]);
  const noId = activity.request(() => meta("b".repeat(64), "gemini_app"));
  for (let i = 0; i < 2; i++) noId.output({ functionCall: { name: "same" }, index: 0 }, "gemini");
  noId.finish("completed");assert.equal(activity.snapshot().items.find(row => row.name === "same").state, "unknown");
});

test("unknown sessions and stale observations stop waiting without inventing tool completion", () => {
  let time = 0;const activity = createToolActivity({ now: () => time });
  const missing = activity.request(() => meta(null));missing.output(call("one"));missing.finish("completed");
  assert.equal(activity.snapshot().items[0].state, "unknown");
  const request = activity.request(() => meta());request.output(call("two"));request.finish("completed");
  time = TOOL_ACTIVITY_LIMITS.stale_ms;
  assert.equal(activity.snapshot().items[0].state, "unknown");
  activity.request(() => meta()).input({ input: [{ type: "function_call_output", call_id: "two" }] });
  assert.equal(activity.snapshot().items.find(x => x.name === "read_file" && x.state === "returned").state, "returned");
  time += TOOL_ACTIVITY_LIMITS.unknown_ms;assert.equal(activity.snapshot().items.length, 0);
});
test("an observed live response keeps preparing tools fresh with bounded notifications", () => {
  let time = 0, notices = 0;const activity = createToolActivity({ now: () => time, changed: () => notices++ }), request = activity.request(() => meta());
  request.output(call("one"));
  for (let i = 0; i < 100; i++) { time += 999;request.activity(); }
  assert.equal(activity.snapshot().items[0].state, "preparing");assert.ok(notices <= 51);
  request.finish("completed");time += TOOL_ACTIVITY_LIMITS.stale_ms;
  assert.equal(activity.snapshot().items[0].state, "unknown", "A finished response cannot manufacture later tool progress");
});

test("metadata limits hold and plain output never inspects text deltas", () => {
  const activity = createToolActivity(), request = activity.request(() => meta());
  request.output({ output: Array.from({ length: 100 }, (_, i) => call(String(i))) });
  assert.equal(activity.size, TOOL_ACTIVITY_LIMITS.per_request);
  assert.equal(activity.snapshot().items.length, TOOL_ACTIVITY_LIMITS.visible);
  assert.equal(isToolActivityOutput({ type: "response.output_text.delta", get delta() { throw Error("do not read text"); } }), false);
  for (const bad of [null, "text", {}, { candidates: {} }, { candidates: {some:"invalid"} }, { candidates: [null, { content: { parts: {} } }] }]) assert.equal(isToolActivityOutput(bad, "gemini"), false);
  assert.doesNotThrow(() => activity.request(() => meta()).input({ messages: [null, { content: {} }] }, "messages"));
  assert.doesNotThrow(() => activity.request(() => meta()).input({ contents: [null, { parts: {} }] }, "gemini"));
});

test("stream metrics expose actual tool metadata and do not turn a response end into tool success", () => {
  const metrics = createStreamPerformanceMetrics(), tracker = metrics.begin("responses", { application: "codex_app" });
  tracker.setProvider("github");tracker.setModel("model");tracker.observeSession("a".repeat(64));
  runWithRequestContext({ streamPerformance: tracker }, () => markToolActivity({ type: "response.output_item.added", output_index: 0, item: call("one") }));
  tracker.terminal("completed");tracker.finish({ statusCode: 200 });
  assert.equal(metrics.activitySnapshot().tool_activity.items[0].state, "waiting");
  const next = metrics.begin("responses", { application: "codex_app" });next.observeSession("a".repeat(64));
  next.observeToolInput({ input: [{ type: "function_call_output", call_id: "one" }] }, "responses");
  assert.equal(metrics.snapshot().tool_activity.items[0].state, "returned");next.finish({ aborted: true });
});
