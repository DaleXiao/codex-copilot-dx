import assert from "node:assert/strict";
import test from "node:test";
import { forwardToChat } from "../src/responses-bridge.mjs";

async function replay(names, declared, { argumentsParts = names.map(() => ""), emit } = {}) {
  const events = [];
  let calls = 0;
  let releases = 0;
  const chunks = names.map((name, index) => ({ choices: [{ delta: { tool_calls: [{ index: 0,
    ...(index === 0 ? { id: "call-name" } : {}), function: { name, arguments: argumentsParts[index] } }] },
    ...(index === names.length - 1 ? { finish_reason: "tool_calls" } : {}) }] }));
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  const result = await forwardToChat({ model: "fixture", messages: [],
    tools: declared.map((name) => ({ type: "function", function: { name } })) },
  async (event, data) => { events.push({ event, data }); return emit?.(event, data); },
  () => {}, (status, message) => { throw new Error(`${status}: ${message}`); }, {
    chatCompletionsFn: async () => { calls += 1; return new Response(body, { headers: { "Content-Type": "text/event-stream" } }); },
    releaseRequest: () => { releases += 1; },
  });
  return { result, events, calls, releases };
}

test("Chat bridge ignores confirmed full-name repeats without dropping argument deltas", async () => {
  const { events, calls, releases } = await replay(["shell", "shell", "shell"], ["shell"], { argumentsParts: ['{"x":', "1", "}"] });
  const added = events.find(({ event }) => event === "response.output_item.added").data.item;
  const done = events.find(({ event }) => event === "response.output_item.done").data.item;
  const final = events.find(({ event }) => event === "response.completed").data.response.output[0];
  for (const item of [added, done, final]) assert.equal(item.name, "shell");
  assert.equal(final.call_id, "call-name");
  assert.equal(final.arguments, '{"x":1}');
  assert.equal(events.filter(({ event }) => event === "response.function_call_arguments.delta").length, 3);
  assert.equal(calls, 1);
  assert.equal(releases, 1);
});

test("Chat bridge preserves name fragments, overlaps, late names and undeclared ambiguity", async () => {
  for (const [parts, declared, expected] of [
    [["look", "up"], ["lookup"], "lookup"],
    [["get_", "_weather"], ["get__weather"], "get__weather"],
    [["get_", "_", "weather"], ["get__weather"], "get__weather"],
    [["run", "run", "_task"], ["run", "runrun_task"], "runrun_task"],
    [["", "shell"], ["shell"], "shell"],
    [["part", "part"], [], "partpart"],
    [["constructor", "constructor"], ["constructor"], "constructor"],
  ]) {
    const { events, calls } = await replay(parts, declared);
    assert.equal(events.find(({ event }) => event === "response.completed").data.response.output[0].name, expected);
    assert.equal(calls, 1);
  }
});

test("Chat name handling preserves downstream cancellation and emits no completion", async () => {
  const { result, events, calls } = await replay(["shell", "shell"], ["shell"], {
    argumentsParts: ["{", "}"], emit: (event) => event === "response.function_call_arguments.delta" ? false : undefined,
  });
  assert.equal(result, false);
  assert.equal(calls, 1);
  assert.equal(events.some(({ event }) => event === "response.completed"), false);
});

test("repeated names remain isolated across interleaved tool calls", async () => {
  const events = [];
  const chunks = [
    [{ index: 0, id: "call-a", function: { name: "shell", arguments: "{" } }, { index: 1, id: "call-b", function: { name: "lookup", arguments: "[" } }],
    [{ index: 1, function: { name: "lookup", arguments: "]" } }, { index: 0, function: { name: "shell", arguments: "}" } }],
  ];
  const body = chunks.map((tool_calls) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls } }] })}\n\n`).join("") + "data: [DONE]\n\n";
  await forwardToChat({ model: "fixture", messages: [], tools: ["shell", "lookup"].map((name) => ({ type: "function", function: { name } })) },
    async (event, data) => events.push({ event, data }), () => {}, (status, message) => { throw new Error(`${status}: ${message}`); },
    { chatCompletionsFn: async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }) });
  const output = events.find(({ event }) => event === "response.completed").data.response.output;
  assert.deepEqual(output.map(({ name, call_id, arguments: args }) => [name, call_id, args]), [["shell", "call-a", "{}"], ["lookup", "call-b", "[]"]]);
});
