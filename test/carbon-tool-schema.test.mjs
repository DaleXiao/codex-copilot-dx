import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import { normalizeCarbonToolSchema, normalizeCarbonToolSchemas } from "../src/carbon-tool-schema.mjs";
import { defaultGithubProvider } from "../src/providers/github.mjs";
import { invokeAdapter } from "../test-support/adapter.mjs";

// Synthetic reduced fixture for the nullable, discriminated object union used
// by WorkIQ retrieve.capabilities. No account data or provider calls are needed.
const schema = { type: "object", required: ["query"], properties: {
  query: { type: "string" },
  capabilities: { type: ["array", "null"], items: {
    type: ["object", "null"], required: ["name"], anyOf: [
      { properties: { name: { const: "People" }, include_related_content: { type: ["boolean", "null"] } } },
      { required: ["name"], properties: { name: { const: "Meetings" }, items_by_id: {
        type: ["array", "null"], items: { type: ["object", "null"], required: ["id", "is_series"],
          properties: { id: { type: ["string", "null"] }, is_series: { type: "boolean" } } },
      } } },
    ],
  } },
} };
const definitions = [{ name: "retrieve", description: "Find fixture records", inputSchema: schema },
  { name: "echo", description: "Echo fixture text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }];
const union = schema.properties.capabilities.items;
const normalized = normalizeCarbonToolSchema(schema);
const compile = value => new Ajv({ strict: false, allowUnionTypes: true, validateFormats: false }).compile(value);

test("distributes both assertions, retaining nullable and branch constraints", () => {
  const actual = normalized.properties.capabilities.items;
  assert.equal(actual.type, undefined);
  assert.equal(actual.required, undefined);
  assert.equal(actual.anyOf.length, union.anyOf.length);
  actual.anyOf.forEach((branch, index) => {
    assert.deepEqual(branch.type, ["object", "null"]);
    assert.deepEqual(branch.required, ["name"]);
    assert.deepEqual(branch.properties, union.anyOf[index].properties);
  });
  assert.deepEqual(schema.properties.capabilities.items, union);
  assert.equal(normalizeCarbonToolSchema(normalized), normalized);
});

test("original and normalized schemas agree on a guided nullable/discriminated-union corpus", () => {
  const before = compile(schema), after = compile(normalized);
  const names = ["People", "Meetings", "OneDriveAndSharePoint", "Email", "TeamsMessages", "GraphConnectors", "Dataverse", "Unknown", null, 3];
  const shapes = [undefined, null, [], {}, "bad", 3, true, [null], [{id: null, is_series: true}], [{id: "x", is_series: false}], [{id: 3}], [{connection_id: null}], [{connection_id: 3}], [{url: "x"}], [{url: 3}], [{folder_id: "x"}], [{folder_id: 3}], ["x"], [3], [{tables: [{table_name: null}]}]];
  const values = [undefined, null, {}, [], "x", 1, true, [null], [{}], [{name: "People"}]];
  for (const name of names) for (const shape of shapes) {
    for (const key of ["include_related_content", "items_by_id", "items_by_sharepoint_ids", "items_by_url", "folders", "group_mailboxes", "shared_mailbox", "urls", "connections", "knowledge_sources"]) {
      const item = {name}; if (shape !== undefined) item[key] = shape;
      values.push([item], [null, item]);
    }
  }
  // Extra irrelevant fields are intentionally allowed by the original schema.
  values.push([{name: "People", items_by_id: "not-an-array"}], [{name: "Meetings", include_related_content: "not-a-boolean"}]);
  let count = 0;
  for (const capabilities of values) {
    const input = {query: "diagnostic"};
    if (capabilities !== undefined) input.capabilities = capabilities;
    assert.equal(after(input), before(input), JSON.stringify(input));
    count += 1;
  }
  for (const value of [null, 1, [], {}, {capabilities: []}, {query: null}]) {
    assert.equal(after(value), before(value)); count += 1;
  }
  assert.equal(count, 4018);
});

test("unknown capability, missing name, and invalid subtype fields stay rejected", () => {
  const validate = compile(normalized);
  for (const item of [{name: "Unknown"}, {}, {name: "Meetings", items_by_id: [{id: "x"}]}, {name: "People", include_related_content: "yes"}]) {
    assert.equal(validate({query: "x", capabilities: [item]}), false);
  }
  assert.equal(validate({query: "x", capabilities: [null, {name: "People"}]}), true);
});

test("tool and history input objects remain untouched; nested/flat tool forms work", () => {
  const input = [{type: "function_call", arguments: JSON.stringify({query: "x", capabilities: [{name: "People"}]})}];
  const body = {input, tools: [{type: "function", name: "flat", parameters: schema},
    {type: "function", function: {name: "nested", parameters: schema}}, {type: "custom", name: "other", format: {type: "text"}}]};
  const snapshot = structuredClone(body), actual = normalizeCarbonToolSchemas(body);
  assert.deepEqual(body, snapshot);
  assert.equal(actual.input, input);
  assert.equal(actual.tools[2], body.tools[2]);
  assert.deepEqual(actual.tools[0].parameters, normalized);
  assert.deepEqual(actual.tools[1].function.parameters, normalized);
  const simple = {tools: [{type: "function", name: "echo", parameters: {type: "object", properties: {text: {type: "string"}}}}]};
  assert.equal(normalizeCarbonToolSchemas(simple), simple);
});

test("literal values and schema property names are not confused with schema keywords", () => {
  const literal = {type: "object", required: ["name"], anyOf: [{properties: {name: {const: "x"}}}]};
  const input = {type: "object", const: literal, default: literal, enum: [literal], examples: [literal],
    properties: {anyOf: {type: "string"}, type: {type: "string"}, nested: literal}};
  const actual = normalizeCarbonToolSchema(input);
  for (const key of ["const", "default", "enum", "examples"]) assert.equal(actual[key], input[key]);
  assert.deepEqual(actual.properties.anyOf, {type: "string"});
  assert.equal(actual.properties.nested.type, undefined);
});

test("reference siblings and incompatible branch types are left intact", () => {
  for (const input of [
    {type: "object", anyOf: [{$ref: "#/$defs/A"}]},
    {$ref: "#/$defs/A", type: "object", anyOf: [{properties: {x: {type: "string"}}}]},
    {type: "number", anyOf: [{type: "integer"}]},
    {type: "object", anyOf: [true]},
    {type: "object", required: ["x", "x"], anyOf: [{properties: {x: {type: "string"}}}]},
  ]) assert.equal(normalizeCarbonToolSchema(input), input);
});

test("newly inherited assertions also reach nested unions without changing their meaning", () => {
  const input = {type: ["object", "null"], required: ["name"], anyOf: [
    {anyOf: [{properties: {name: {const: "A"}}}, {properties: {name: {const: "B"}}}]},
    {properties: {name: {const: "C"}}},
  ]};
  const result = normalizeCarbonToolSchema(input), before = compile(input), after = compile(result);
  assert.equal(result.anyOf[0].type, undefined);
  assert.equal(result.anyOf[0].anyOf[0].type[1], "null");
  assert.equal(normalizeCarbonToolSchema(result), result);
  for (const value of [null, 1, [], {}, {name: "A"}, {name: "B"}, {name: "C"}, {name: "D"}]) assert.equal(after(value), before(value));
});

test("recursion only enters schema-bearing keywords, with a bounded depth", () => {
  const input = {$defs: {cap: union}, definitions: {cap: union}, items: [union],
    dependencies: {cap: union, names: ["x"]}, dependentSchemas: {cap: union}};
  const result = normalizeCarbonToolSchema(input);
  for (const value of [result.$defs.cap, result.definitions.cap, result.items[0], result.dependencies.cap, result.dependentSchemas.cap]) {
    assert.equal(value.type, undefined); assert.equal(value.anyOf[0].type[0], "object");
  }
  assert.equal(result.dependencies.names, input.dependencies.names);
  let deep = union;
  for (let index = 0; index < 1000; index++) deep = {items: deep};
  assert.equal(normalizeCarbonToolSchema(deep), deep);
});

async function roundtrip(body, { provider = defaultGithubProvider, reply } = {}) {
  let captured;
  const response = await invokeAdapter({ provider, getCachedModelEndpointsFn: () => ["/chat/completions"],
    chatCompletionsFn: async (request, options) => {
      captured = { request: structuredClone(request), wire: JSON.parse(options.bodyText) };
      if (reply) return reply(request);
      return Response.json({ id: "chat-test", model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
    } }, { body });
  assert.equal(response.status, 200, response.text);
  return { text: response.text, captured };
}
const fullTools = definitions.map(tool => ({type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema}));

test("patched handler serializes normalized flat tools before sending upstream", async () => {
  const {text, captured} = await roundtrip({model: "gemini-4-carbon", input: "hi", tools: fullTools, stream: false, store: false});
  assert.deepEqual(captured.wire, captured.request);
  assert.deepEqual(captured.wire.tools.find(tool => tool.function.name === "retrieve").function.parameters, normalized);
  assert.equal(JSON.parse(text).output[0].content[0].text, "OK");
});

test("non-Carbon and non-GitHub routes retain the original schema", async () => {
  for (const [model, provider] of [["gemini-4-argon", defaultGithubProvider], ["gemini-4-carbon", {...defaultGithubProvider, id: "api-test"}]]) {
    const {captured} = await roundtrip({model, input: "hi", tools: fullTools, stream: false, store: false}, {provider});
    assert.deepEqual(captured.wire.tools[0].function.parameters, schema);
  }
});

test("streamed namespaced calls retain the original tool name and structured arguments", async () => {
  const args = JSON.stringify({query: "diagnostic", capabilities: [{name: "People", include_related_content: false}]});
  const {text, captured} = await roundtrip({model: "gemini-4-carbon", input: "hi", stream: true, store: false,
    tools: [{type: "namespace", name: "workiq", tools: [{type: "function", name: "retrieve", parameters: schema}]}]}, {
    reply: request => {
      const name = request.tools[0].function.name;
      const chunks = [
        {choices: [{index: 0, delta: {role: "assistant", tool_calls: [{index: 0, id: "call-test", type: "function", function: {name, arguments: args.slice(0, 15)}}]}, finish_reason: null}]},
        {choices: [{index: 0, delta: {tool_calls: [{index: 0, function: {arguments: args.slice(15)}}]}, finish_reason: null}]},
        {choices: [{index: 0, delta: {}, finish_reason: "tool_calls"}]},
      ];
      return new Response(chunks.map(chunk => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n", {headers: {"content-type": "text/event-stream"}});
    },
  });
  assert.deepEqual(captured.wire.tools[0].function.parameters, normalized);
  const events = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  const call = events.find(event => event.type === "response.completed").response.output[0];
  assert.equal(call.type, "function_call"); assert.equal(call.name, "retrieve"); assert.equal(call.namespace, "workiq");
  assert.equal(call.arguments, args); assert.equal(compile(schema)(JSON.parse(call.arguments)), true);
});

test("historical structured tool arguments and output survive the Carbon bridge", async () => {
  const args = JSON.stringify({query: "diagnostic", capabilities: [null, {name: "People"}]});
  const {captured} = await roundtrip({model: "gemini-4-carbon", stream: false, store: false,
    tools: [{type: "namespace", name: "workiq", tools: [{type: "function", name: "retrieve", parameters: schema}]}],
    input: [{role: "user", content: "find it"}, {type: "function_call", name: "retrieve", namespace: "workiq", call_id: "call-history", arguments: args},
      {type: "function_call_output", call_id: "call-history", output: JSON.stringify({diagnostic: true})}, {role: "user", content: "OK only"}]});
  assert.equal(captured.wire.messages.find(message => message.tool_calls).tool_calls[0].function.arguments, args);
  assert.equal(captured.wire.messages.find(message => message.role === "tool").content, JSON.stringify({diagnostic: true}));
});

test("deferred definitions loaded from tool_search_output are normalized after the bridge", async () => {
  const loaded = {type: "function", namespace: "workiq", name: "retrieve", parameters: schema};
  const {captured} = await roundtrip({model: "gemini-4-carbon", stream: false, store: false,
    tools: [{...loaded, defer_loading: true}, {type: "tool_search", execution: "client", parameters: {type: "object", properties: {query: {type: "string"}}}}],
    input: [{role: "user", content: "find it"}, {type: "tool_search_call", execution: "client", call_id: "search-history", arguments: {query: "retrieve"}},
      {type: "tool_search_output", execution: "client", call_id: "search-history", tools: [loaded]}, {role: "user", content: "OK only"}]});
  assert.deepEqual(captured.wire.tools.find(tool => tool.function.name === "workiq__retrieve").function.parameters, normalized);
  const discovery = JSON.parse(captured.wire.messages.find(message => message.role === "tool").content);
  assert.deepEqual(discovery.tools[0].parameters, schema);
});
