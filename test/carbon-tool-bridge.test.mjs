import { test } from "node:test";
import assert from "node:assert/strict";
import { createCarbonStreamAdapter, prepareCarbonToolBridge } from "../src/carbon-tool-bridge.mjs";
import { chatToResponses, forwardToChat, responsesToChat } from "../src/responses-bridge.mjs";
import { clearResponseHistoryForTests } from "../src/response-history.mjs";
import { startAdapter } from "../src/adapter.mjs";
import { maskPrivacyRequest, protectPrivacyResponse } from "../src/privacy-transform.mjs";
import { invokeAdapter } from "../test-support/adapter.mjs";

const custom = { type: "custom", name: "exec", description: "Run JavaScript",
  format: { type: "grammar", syntax: "lark", definition: "start: SOURCE\nSOURCE: /.+/" } };
const search = { type: "tool_search", execution: "client", description: "Find tools",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } };
const fn = name => ({ type: "function", name, description: "Look up information",
  parameters: { type: "object", properties: { n: { type: "string" } }, additionalProperties: false } });

test("Carbon converts custom, namespaced, searched and historical tools without changing the source", () => {
  const body = { model: "gemini-4-carbon", tools: [custom, search,
    { type: "namespace", name: "docs", tools: [fn("lookup"), { ...custom, name: "patch" }] },
    { ...fn("later"), defer_loading: true }], input: [
    { type: "message", role: "user", content: "Search and run a tool" },
    { type: "tool_search_call", execution: "client", call_id: "search1", arguments: { query: "files" } },
    { type: "tool_search_output", execution: "client", call_id: "search1", tools: [{ ...fn("later"), defer_loading: true }] },
    { type: "custom_tool_call", name: "exec", call_id: "call1", input: "text(9007199254740993); // 中文 😀\n" },
    { type: "custom_tool_call_output", call_id: "call1", output: "done" },
    { type: "additional_tools", role: "developer", tools: [fn("another")] },
    { type: "message", role: "user", content: "Continue" },
  ] };
  const before = structuredClone(body);
  const bridge = prepareCarbonToolBridge(body, 6);
  const chat = responsesToChat(bridge.body);
  assert.deepEqual(body, before);
  assert.equal(bridge.currentInputStart, 5);
  const names = chat.tools.map(tool => tool.function.name);
  assert.deepEqual(names, ["exec", "tool_search", "docs__lookup", "docs__patch", "later", "another"]);
  assert.match(chat.tools[0].function.description, /start: SOURCE/);
  const historical = chat.messages.find(message => message.tool_calls?.some(call => call.id === "call1"));
  assert.equal(JSON.parse(historical.tool_calls[0].function.arguments).input, "text(9007199254740993); // 中文 😀\n");
  assert.equal(chat.messages.find(message => message.tool_call_id === "call1").content, "done");
  assert.equal(chat.messages.find(message => message.tool_call_id === "search1").role, "tool");
  assert.deepEqual(bridge.outputItem({ id: "c2", name: "docs__patch", arguments: JSON.stringify({ input: "patch\n" }) }),
    { type: "custom_tool_call", id: "c2", call_id: "c2", name: "patch", namespace: "docs", input: "patch\n", status: "completed" });
  assert.deepEqual(bridge.outputItem({ id: "s2", name: "tool_search", arguments: '{"query":"calendar"}' }),
    { type: "tool_search_call", id: "s2", call_id: "s2", execution: "client", arguments: { query: "calendar" }, status: "completed" });
});

test("Carbon names are collision-free and never allow undeclared or malformed calls", () => {
  const bridge = prepareCarbonToolBridge({ model: "gemini-4-carbon", input: "hi",
    tools: [fn("a__b"), { type: "namespace", name: "a", tools: [fn("b")] }, custom] });
  const names = bridge.body.tools.map(tool => tool.name || tool.function.name);
  assert.equal(new Set(names).size, 3);
  assert.equal(bridge.outputItem({ id: "1", name: names[1], arguments: "{}" }).namespace, "a");
  for (const call of [
    { name: "unknown", arguments: "{}" },
    { name: "exec", arguments: '{"input":123}' },
    { name: "exec", arguments: '{"input":"ok","extra":true}' },
  ]) assert.throws(() => bridge.outputItem({ id: "call", ...call }), { code: "ccdx_carbon_invalid_tool_call" });
  assert.throws(() => prepareCarbonToolBridge({ tools: [{ ...fn("wait"), defer_loading: true }] }),
    { code: "ccdx_carbon_tool_incompatible" });
  assert.throws(() => prepareCarbonToolBridge({ tools: [{ ...search, execution: "server" }] }),
    { code: "ccdx_carbon_tool_incompatible" });
});

test("Carbon preserves image-host and App tool identities and arguments", () => {
  const image = { type: "function", name: "imagegen", description: "Generate an image",
    parameters: { type: "object", properties: { mode: { type: "string" }, prompt: { type: "string" } },
      required: ["mode", "prompt"] } };
  const app = { type: "function", name: "read_document", description: "Read a document",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } };
  const bridge = prepareCarbonToolBridge({ model: "gemini-4-carbon", input: "use tools", tools: [
    { type: "namespace", name: "ccdx_images", tools: [image] },
    { type: "namespace", name: "mcp__codex_apps__documents", tools: [app] },
  ] });
  const tools = responsesToChat(bridge.body).tools.map(item => item.function.name);
  assert.deepEqual(tools, ["ccdx_images__imagegen", "mcp__codex_apps__documents__read_document"]);
  const imageArgs = '{"mode":"generate","prompt":"中文 😀"}', appArgs = '{"id":"9007199254740993"}';
  const imageCall = bridge.outputItem({ id: "image-call", name: tools[0], arguments: imageArgs });
  const appCall = bridge.outputItem({ id: "app-call", name: tools[1], arguments: appArgs });
  assert.equal(imageCall.namespace, "ccdx_images");assert.equal(imageCall.name, "imagegen");
  assert.equal(imageCall.arguments, imageArgs);
  assert.equal(appCall.namespace, "mcp__codex_apps__documents");assert.equal(appCall.name, "read_document");
  assert.equal(appCall.arguments, appArgs);
});

test("Carbon preserves tool-result images after all parallel tool outputs", () => {
  const image = "data:image/png;base64,aGVsbG8=";
  const body = { model: "gemini-4-carbon", tools: [custom, fn("read")], input: [
    { type: "function_call", name: "read", call_id: "c1", arguments: "{}" },
    { type: "custom_tool_call", name: "exec", call_id: "c2", input: "text('x')" },
    { type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "picture" },
      { type: "input_image", image_url: image, detail: "high" }] },
    { type: "custom_tool_call_output", call_id: "c2", output: "done" },
    { type: "message", role: "user", content: "continue" },
  ] };
  const original = structuredClone(body);
  const bridge = prepareCarbonToolBridge(body, 4);
  const messages = responsesToChat(bridge.body).messages;
  assert.deepEqual(body, original);
  assert.equal(bridge.currentInputStart, 5);
  assert.deepEqual(messages.map(message => message.role), ["assistant", "tool", "tool", "user", "user"]);
  assert.equal(messages[1].tool_call_id, "c1");assert.equal(messages[2].tool_call_id, "c2");
  assert.match(messages[3].content[0].text, /TOOL OUTPUT - NOT USER INPUT/);
  assert.equal(messages[3].content[1].image_url.url, image);
  assert.equal(messages[3].content[1].image_url.detail, "high");
  assert.equal(JSON.stringify(messages[1]).includes(image), false);
  assert.throws(() => prepareCarbonToolBridge({ ...body, input: [
    { type: "custom_tool_call_output", call_id: "c", output: [{ type: "input_image", image_url: null }] },
  ] }), { code: "ccdx_carbon_tool_incompatible" });
});

test("Carbon restores custom tool input incrementally and preserves escapes", async () => {
  const bridge = prepareCarbonToolBridge({ model: "gemini-4-carbon", input: "hi", tools: [custom] });
  const chat = responsesToChat(bridge.body);
  const adapter = createCarbonStreamAdapter(bridge);
  const events = [];
  let controller, sawFirst, fail;
  const firstDelta = new Promise(resolve => { sawFirst = resolve; });
  const source = new ReadableStream({ start(c) { controller = c; } });
  const run = forwardToChat({ ...chat, stream: true }, async (type, data) => {
    events.push({ type, data });
    if (type === "response.custom_tool_call_input.delta") sawFirst();
  }, () => {}, (_status, _message, error) => { fail = error; }, {
    toolAdapter: adapter,
    chatCompletionsFn: async () => new Response(source, { headers: { "content-type": "text/event-stream" } }),
  });
  const chunk = call => Buffer.from("data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] }) + "\n\n");
  const expected = 'hello world\n😀 \\"x\\"';
  const encoded = JSON.stringify({ input: expected }).replace("😀", "\\uD83D\\uDE00");
  const firstCut = encoded.indexOf("world"), secondCut = encoded.indexOf("\\uDE00");
  controller.enqueue(chunk({ index: 0, id: "call1", function: { name: "exec", arguments: encoded.slice(0, firstCut) } }));
  await Promise.race([firstDelta, new Promise((_, reject) => setTimeout(() => reject(new Error("no incremental custom input")), 1000))]);
  assert.equal(events.some(event => event.type === "response.custom_tool_call_input.done"), false);
  controller.enqueue(chunk({ index: 0, function: { arguments: encoded.slice(firstCut, secondCut) } }));
  controller.enqueue(chunk({ index: 0, function: { arguments: encoded.slice(secondCut) } }));
  controller.enqueue(Buffer.from("data: [DONE]\n\n"));controller.close();
  assert.equal(await run, true, fail?.message);
  assert.equal(fail, undefined);
  const parts = events.filter(event => event.type === "response.custom_tool_call_input.delta").map(event => event.data.delta);
  const item = events.find(event => event.type === "response.output_item.done").data.item;
  assert.equal(parts.join(""), expected);
  assert.equal(item.input, parts.join(""));
  assert.equal(item.type, "custom_tool_call");
  assert.equal(events.at(-1).data.response.output[0].input, item.input);
});

test("Carbon rejects malformed custom output without completing or executing the call", async () => {
  const bridge = prepareCarbonToolBridge({ model: "gemini-4-carbon", input: "hi", tools: [custom] });
  const chat = responsesToChat(bridge.body);
  const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "exec", arguments: '{"input":"ok","extra":true}' } }] } }] };
  const wire = "data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n";
  const events = [];let failure;
  const result = await forwardToChat({ ...chat, stream: true }, async (type, data) => events.push({ type, data }),
    () => {}, (_status, _message, error) => { failure = error; },
    { toolAdapter: createCarbonStreamAdapter(bridge), chatCompletionsFn: async () => new Response(wire, { headers: { "content-type": "text/event-stream" } }) });
  assert.equal(result, false);
  assert.equal(failure.code, "ccdx_carbon_invalid_tool_call");
  assert.equal(events.some(event => event.type === "response.completed" || event.type === "response.output_item.done"), false);
});

test("Carbon request reaches Chat and round-trips the custom tool across turns", async () => {
  clearResponseHistoryForTests();
  const seen = [];
  const options = { getCachedModelEndpointsFn: () => ["/chat/completions"], chatCompletionsFn: async body => {
    seen.push(structuredClone(body));
    const message = seen.length === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function",
        function: { name: "exec", arguments: JSON.stringify({ input: "text(42)" }) } }] }
      : { role: "assistant", content: "done" };
    return Response.json({ model: "gemini-4-carbon", choices: [{ message, finish_reason: seen.length === 1 ? "tool_calls" : "stop" }] });
  } };
  try {
    const first = await invokeAdapter(options, { body: { model: "gemini-4-carbon", input: "run", tools: [custom], stream: false } });
    assert.equal(first.status, 200, first.text);
    const firstBody = JSON.parse(first.text);
    assert.equal(firstBody.output[0].type, "custom_tool_call");
    assert.equal(firstBody.output[0].input, "text(42)");
    const second = await invokeAdapter(options, { body: { model: "gemini-4-carbon", previous_response_id: firstBody.id,
      input: [{ type: "custom_tool_call_output", call_id: "call_1", output: "42" }], tools: [custom], stream: false } });
    assert.equal(second.status, 200, second.text);
    assert.equal(JSON.parse(second.text).output[0].content[0].text, "done");
    assert.equal(seen.length, 2);
    assert.equal(seen[1].messages.find(message => message.tool_calls?.[0]?.id === "call_1").tool_calls[0].function.name, "exec");
    assert.equal(seen[1].messages.find(message => message.tool_call_id === "call_1").content, "42");
  } finally { clearResponseHistoryForTests(); }
});

test("Carbon HTTP stream sends typed ordered Responses events for Codex", async () => {
  const args = JSON.stringify({ input: 'text("fixture")' });
  const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function",
    function: { name: "exec", arguments: args } }] }, finish_reason: "tool_calls" }] };
  const response = await invokeAdapter({ getCachedModelEndpointsFn: () => ["/chat/completions"],
    chatCompletionsFn: async () => new Response("data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } }) },
  { body: { model: "gemini-4-carbon", input: "run", tools: [custom], stream: true } });
  assert.equal(response.status, 200, response.text);
  const frames = response.text.split("\n\n").filter(part => part.startsWith("event: "));
  const events = frames.map(frame => {
    const [label, data] = frame.split("\n");
    const parsed = JSON.parse(data.slice(6));
    assert.equal(parsed.type, label.slice(7));
    return parsed;
  });
  assert.deepEqual(events.map(event => event.sequence_number), events.map((_, index) => index));
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(events.at(-1).response.output[0].type, "custom_tool_call");
  assert.equal(events.at(-1).response.output[0].input, 'text("fixture")');
});

test("Carbon reports an invalid tool as incomplete without completing the call", async () => {
  let calls = 0;
  const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function",
    function: { name: "exec", arguments: '{"input":"ok","extra":true}' } }] } }] };
  const response = await invokeAdapter({ getCachedModelEndpointsFn: () => ["/chat/completions"], chatCompletionsFn: async () => {
    calls += 1;return new Response("data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
  } }, { body: { model: "gemini-4-carbon", input: "run", tools: [custom], stream: true } });
  const events = response.text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  assert.equal(calls, 1);
  assert.equal(events.some(event => event.type === "response.output_item.done" || event.type === "response.completed"), false);
  assert.equal(events.at(-1).type, "response.incomplete");
  assert.equal(events.at(-1).response.incomplete_details.reason, "invalid_tool_call");
});

test("Carbon never emits a completed tool item for a truncated upstream call", async () => {
  const bridge = prepareCarbonToolBridge({ model: "gemini-4-carbon", input: "hi", tools: [custom] });
  const chat = responsesToChat(bridge.body);
  const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "exec", arguments: '{"input":"partial' } }] },
    finish_reason: "length" }] };
  const wire = "data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n";
  const events = [];
  const completed = await forwardToChat({ ...chat, stream: true }, async (type, data) => events.push({ type, data }),
    () => {}, () => assert.fail("a truncated call must be reported as incomplete"),
    { toolAdapter: createCarbonStreamAdapter(bridge),
      chatCompletionsFn: async () => new Response(wire, { headers: { "content-type": "text/event-stream" } }) });
  assert.equal(completed, false);
  assert.equal(events.some(event => event.type === "response.output_item.done" || event.type === "response.completed"), false);
  assert.equal(events.at(-1).type, "response.incomplete");
  assert.equal(events.at(-1).data.response.output[0].status, "incomplete");
  assert.equal(events.at(-1).data.response.output[0].input, "partial");
});

test("Carbon plain text stream uses typed Responses events too", async () => {
  const chunk = { choices: [{ delta: { content: "hello" }, finish_reason: "stop" }] };
  const response = await invokeAdapter({ getCachedModelEndpointsFn: () => ["/chat/completions"],
    chatCompletionsFn: async () => new Response("data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } }) },
  { body: { model: "gemini-4-carbon", input: "hi", stream: true } });
  assert.equal(response.status, 200);
  const frames = response.text.split("\n\n").filter(part => part.startsWith("event: "));
  for (const frame of frames) {
    const [label, data] = frame.split("\n");
    assert.equal(JSON.parse(data.slice(6)).type, label.slice(7));
  }
});

test("Carbon waits for fragmented tool names and late call ids before announcing", async () => {
  const bridge = prepareCarbonToolBridge({ model: "gemini-4-carbon", input: "hi",
    tools: [fn("do"), { ...custom, name: "do_more" }] });
  const chat = responsesToChat(bridge.body);
  const chunks = [
    { index: 0, function: { name: "do" } },
    { index: 0, function: { name: "_more", arguments: '{"input":"one ' } },
    { index: 0, id: "late-id", function: { arguments: 'two"}' } },
  ];
  const wire = chunks.map(call => "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] }) + "\n\n").join("")
    + "data: [DONE]\n\n";
  const events = [];let failure;
  const success = await forwardToChat({ ...chat, stream: true }, async (type, data) => events.push({ type, data }),
    () => {}, (_status, _message, error) => { failure = error; },
    { toolAdapter: createCarbonStreamAdapter(bridge),
      chatCompletionsFn: async () => new Response(wire, { headers: { "content-type": "text/event-stream" } }) });
  assert.equal(success, true, failure?.message);
  const added = events.find(event => event.type === "response.output_item.added").data.item;
  const done = events.find(event => event.type === "response.output_item.done").data.item;
  assert.equal(added.name, "do_more");assert.equal(added.type, "custom_tool_call");
  assert.equal(added.call_id, "late-id");assert.equal(done.call_id, "late-id");assert.equal(done.input, "one two");
});

test("Carbon custom tool streaming preserves privacy masking and restores the original text", async t => {
  const sessions = new WeakMap(), secret = "ghp_" + "x".repeat(36);
  let upstreamText = "";
  const privacy = {
    wrap(fn, { res, protocol }) {
      return async (body, options) => {
        const session = await maskPrivacyRequest(body, { protocol, secret: Buffer.alloc(32, 7), find: async texts => texts.map(() => []) });
        sessions.set(res, session);protectPrivacyResponse(res, session);
        return fn(session.body, { ...options, bodyText: undefined });
      };
    },
    restoreResponse: (res, value) => sessions.get(res)?.restoreValue(value) || value,
    close() {},
  };
  const server = await startAdapter(0, "127.0.0.1", { privacy, getCachedModelEndpointsFn: () => ["/chat/completions"],
    chatCompletionsFn: async body => {
      upstreamText = JSON.stringify(body);
      const text = body.messages.find(message => message.role === "user").content;
      const args = JSON.stringify({ input: "text(" + JSON.stringify(text) + ")" });
      const at = args.indexOf("{{CCDX_") + 5;
      const chunks = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_privacy", function: { name: "exec", arguments: args.slice(0, at) } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(at) } }] }, finish_reason: "tool_calls" }] },
      ];
      return new Response(chunks.map(chunk => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } });
    } });
  t.after(() => new Promise(resolve => { server.closeAllConnections();server.close(resolve); }));
  const response = await fetch("http://127.0.0.1:" + server.address().port + "/v1/responses", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gemini-4-carbon", input: secret, tools: [custom], stream: true }) });
  assert.equal(response.status, 200);
  const events = (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  assert.equal(upstreamText.includes(secret), false);
  assert.match(upstreamText, /\{\{CCDX_[a-f0-9]{24}\}\}/);
  const joined = events.filter(event => event.type === "response.custom_tool_call_input.delta").map(event => event.delta).join("");
  assert.equal(joined, "text(" + JSON.stringify(secret) + ")");
  assert.equal(events.at(-1).response.output[0].input, joined);
});

test("standalone search masks sensitive query and context without changing the source", async () => {
  const secret = "ghp_" + "z".repeat(36);
  const body = { model: "gemini-4-carbon", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: secret }] }],
    commands: { search_query: [{ q: "find " + secret }], open: [{ ref_id: "https://example.test/" + secret }] } };
  const before = structuredClone(body);
  const session = await maskPrivacyRequest(body, { protocol: "search", secret: Buffer.alloc(32, 3), find: async texts => texts.map(() => []) });
  assert.deepEqual(body, before);
  assert.equal(JSON.stringify(session.body).includes(secret), false);
  assert.equal(session.count, 3);
  const masked = session.body.commands.search_query[0].q;
  assert.equal(session.restoreValue({ output: masked }).output, "find " + secret);
  session.release();
});

test("Nonstreaming Carbon restores namespaced tool identity", () => {
  const bridge = prepareCarbonToolBridge({ model: "gemini-4-carbon", input: "hi",
    tools: [{ type: "namespace", name: "docs", tools: [fn("lookup")] }] });
  const response = chatToResponses({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{
    id: "c", function: { name: "docs__lookup", arguments: '{"n":"9007199254740993"}' },
  }] } }] }, "gemini-4-carbon", { toolAdapter: bridge });
  assert.equal(response.output[0].namespace, "docs");
  assert.equal(response.output[0].name, "lookup");
  assert.equal(response.output[0].arguments, '{"n":"9007199254740993"}');
});
