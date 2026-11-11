import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adaptMessagesToolSchemas, isRootToolSchemaError } from "../src/messages-tool-schema.mjs";
import { createApiProvider } from "../src/providers/api.mjs";
import { startClaudeGateway } from "../src/claude-gateway.mjs";
import { createLocalPrivacy } from "../src/local-privacy.mjs";
import { userSettingsPath } from "../src/user-settings.mjs";

const schema = { oneOf: [
  { type: "object", properties: { code: { type: "string" }, timeout_ms: { type: "number" } }, required: ["code"], additionalProperties: false },
  { type: "object", properties: { completion_summary: { type: "string" } }, required: ["completion_summary"], additionalProperties: false },
], $schema: "http://json-schema.org/draft-07/schema#" };
const tool = { name: "browser", input_schema: schema };
const errorText = "tools.0.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level";
const message = input => ({ id: "msg_test", type: "message", role: "assistant", model: "fixture", content: [{ type: "tool_use", id: "tool_1", name: "browser", input }], stop_reason: "tool_use" });
const event = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
function stream(input) {
  const parts = [event({ type: "message_start", message: { id: "msg_test", type: "message", model: "fixture" } }),
    event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool_1", name: "browser", input: {} } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: input } }),
    event({ type: "content_block_stop", index: 0 }), event({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
    event({ type: "message_stop" })];
  return parts.join("");
}
async function fixture(t, response, { firstError = true, privacy } = {}) {
  const calls = [];
  const provider = createApiProvider({ config: { id: "api_test", name: "test", base_url: "https://example.test/v1",
    endpoints: { messages: "https://example.test/v1/messages" }, secret_ref: "fixture", auth_header: "bearer",
    models: [{ id: "fixture", protocols: ["messages"] }] }, env: {}, secrets: { get: async () => "synthetic-only" },
    networkFactory: async () => ({ close() {}, async fetch(_url, init) {
      calls.push(JSON.parse(init.body));
      if (firstError && calls.length === 1) return Response.json({ error: { message: errorText } }, { status: 400 });
      return response(calls.at(-1));
    } }) });
  const apiKey = "fixture-" + "a".repeat(32);
  const gateway = await startClaudeGateway({ port: 0, provider, apiKey, privacy, env: { CCDX_DISABLE_USAGE: "1" }, record: () => {} });
  t.after(async () => { await gateway.close();provider.close(); });
  const send = async (streamed = false, requestedTool = tool, content = "test") => fetch(`http://127.0.0.1:${gateway.port}/v1/messages`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "fixture", max_tokens: 32, messages: [{ role: "user", content }], tools: [requestedTool], stream: streamed }) });
  return { calls, send };
}

test("schema compatibility keeps original oneOf validation, including exclusive alternatives", async () => {
  const original = { tools: [tool] }, result = await adaptMessagesToolSchemas(original);
  assert.ok(result);assert.equal(result.body.tools[0].input_schema.type, "object");
  assert.equal(Object.hasOwn(result.body.tools[0].input_schema, "oneOf"), false);assert.deepEqual(original.tools[0], tool);
  for (const input of [{ code: "run", timeout_ms: 20 }, { completion_summary: "done" }]) assert.deepEqual(result.guard.validateMessage(JSON.stringify(message(input))).content[0].input, input);
  for (const input of [{}, { code: "run", completion_summary: "done" }, { code: 4 }, { code: "run", extra: true }]) {
    assert.throws(() => result.guard.validateMessage(JSON.stringify(message(input))), { code: "ccdx_tool_input_invalid" });
  }
  assert.equal(await adaptMessagesToolSchemas({ tools: [{ name: "unsafe", input_schema: { oneOf: [{ type: "object", properties: { x: { type: "string", pattern: "a+" } } }] } }] }), null);
  assert.equal(isRootToolSchemaError(400, JSON.stringify({ error: { message: errorText } })), true);
  assert.equal(isRootToolSchemaError(500, JSON.stringify({ error: { message: errorText } })), false);
});

test("the provider-facing object does not reject inputs accepted by supported original schemas", async () => {
  const variants = [schema, { anyOf: [
    { type: "object", properties: { x: { type: "string" } }, required: ["x"], additionalProperties: false },
    { type: "object", properties: { y: { type: "boolean" } }, required: ["y"] },
  ] }, { allOf: [
    { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
    { type: "object", properties: { y: { type: "boolean" } }, required: ["y"] },
  ] }];
  const values = [undefined, "text", 12, true], candidates = [{}];
  for (const x of values) for (const y of values) {
    candidates.push({ ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }) });
  }
  for (const original of variants) {
    const result = await adaptMessagesToolSchemas({ tools: [{ name: "browser", input_schema: original }] });assert.ok(result);
    const validator = new Ajv({ strict: false }), before = validator.compile(original), after = validator.compile(result.body.tools[0].input_schema);
    for (const candidate of candidates) if (before(candidate)) assert.equal(after(candidate), true, JSON.stringify({ original, candidate }));
  }
});

test("Messages retries only an explicit schema rejection and returns a valid tool input unchanged", async t => {
  const f = await fixture(t, () => Response.json(message({ code: "run", timeout_ms: 20 })));
  const response = await f.send();assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).content[0].input, { code: "run", timeout_ms: 20 });
  assert.equal(f.calls.length, 2);assert.deepEqual(f.calls[0].tools[0].input_schema, schema);
  assert.equal(f.calls[1].tools[0].input_schema.type, "object");assert.equal(Object.hasOwn(f.calls[1].tools[0].input_schema, "oneOf"), false);
});

test("Messages does not change a schema accepted by its source", async t => {
  const f = await fixture(t, () => Response.json(message({ code: "run" })), { firstError: false });
  const response = await f.send();assert.equal(response.status, 200);await response.arrayBuffer();
  assert.equal(f.calls.length, 1);assert.deepEqual(f.calls[0].tools[0].input_schema, schema);
});

test("Messages blocks invalid adapted tool input before a JSON response reaches the client", async t => {
  const f = await fixture(t, () => Response.json(message({ code: "run", completion_summary: "both" })));
  const response = await f.send();assert.equal(response.status, 502);
  const result = await response.json();assert.equal(result.error.code, "ccdx_tool_input_invalid");
  assert.equal(result.content, undefined);
});

test("Messages buffers adapted tool frames until the complete input is validated", async t => {
  for (const [input, valid] of [['{"code":"run"}', true], ['{"code":"run","completion_summary":"both"}', false]]) {
    const wire = stream(input), f = await fixture(t, () => new Response(wire, { headers: { "content-type": "text/event-stream" } }));
    const response = await f.send(true), text = await response.text();
    assert.equal(response.status, 200);assert.equal(f.calls.length, 2);
    if (valid) assert.equal(text, wire);
    else { assert.match(text, /event: error/);assert.doesNotMatch(text, /content_block_start|content_block_delta|content_block_stop|message_stop/); }
  }
});

test("adapted Messages keep SSE bytes and validate tool input across fragmented line endings", async t => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    for (const valid of [true, false]) {
      const input = valid ? '{"code":"run"}' : '{"code":"run","completion_summary":"both"}';
      const wire = (": synthetic comment\n\n" + stream(input)).replaceAll("\n", ending), bytes = Buffer.from(wire);
      const f = await fixture(t, () => {
        let at = 0;
        return new Response(new ReadableStream({ pull(controller) {
          if (at === bytes.length) { controller.close();return; }
          const end = Math.min(bytes.length, at + 3);controller.enqueue(bytes.subarray(at, end));at = end;
        } }), { headers: { "content-type": "text/event-stream" } });
      });
      const response = await f.send(true), text = await response.text();
      assert.equal(response.status, 200);
      if (valid) assert.equal(text, wire);
      else { assert.match(text, /event: error/);assert.doesNotMatch(text, /content_block_start|content_block_delta|content_block_stop|message_stop/); }
    }
  }
});

test("Messages never rounds an unsafe integer when validating an adapted stream", async t => {
  const numeric = { ...tool, input_schema: { oneOf: [{ type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false }] } };
  const f = await fixture(t, () => new Response(stream('{"value":9007199254740993}'), { headers: { "content-type": "text/event-stream" } }));
  const response = await f.send(true, numeric), text = await response.text();
  assert.equal(response.status, 200);assert.equal(f.calls.length, 2);
  assert.match(text, /event: error/);assert.doesNotMatch(text, /content_block_start|content_block_delta|content_block_stop|message_stop/);
});

test("adapted Messages tool input is validated after privacy restoration", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-schema-privacy-")), env = {}, file = userSettingsPath({ home, env });
  fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, '{"privacy_enabled":true}');
  const model = { load: async () => {}, find: async texts => texts.map(() => []), snapshot: () => ({ state: "ready" }), close() {}, busy: () => false };
  const privacy = createLocalPrivacy({ home, env, model }), secret = "ghp_" + "e".repeat(36);
  t.after(() => { privacy.close();fs.rmSync(home, { recursive: true, force: true }); });
  const privateTool = { name: "browser", input_schema: { oneOf: [{ type: "object", properties: { code: { type: "string", minLength: 40 } }, required: ["code"], additionalProperties: false }] } };
  for (const streamed of [false, true]) {
    const f = await fixture(t, sent => streamed
      ? new Response(stream(JSON.stringify({ code: sent.messages[0].content })), { headers: { "content-type": "text/event-stream" } })
      : Response.json(message({ code: sent.messages[0].content })), { privacy });
    const response = await f.send(streamed, privateTool, secret), text = await response.text();
    assert.equal(response.status, 200);assert.equal(f.calls.length, 2);
    assert.equal(JSON.stringify(f.calls).includes(secret), false);assert.equal(text.includes(secret), true);
  }
});
