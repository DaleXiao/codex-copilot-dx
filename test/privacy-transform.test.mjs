import test from "node:test";
import assert from "node:assert/strict";
import { maskPrivacyRequest, createPrivacyStream, protectPrivacyResponse } from "../src/privacy-transform.mjs";

const secret = Buffer.alloc(32, 7), noModel = async texts => texts.map(() => []);
const key = "ghp_" + "a".repeat(36);
const options = { protocol: "messages", client: "claude_app", secret, find: noModel };
const body = text => ({ model: "model", messages: [{ role: "user", content: text }], max_tokens: 64 });
test("masking leaves protocol fields and signed blocks intact, restores values and preserves the source object", async () => {
  const input = body(`API key: ${key} and PASSWORD="a\\\"b"`);
  input.messages.push({ role: "assistant", content: [{ type: "thinking", thinking: key, signature: "sealed" }] });
  input.tools = [{ name: "schema", input_schema: { type: "object", properties: { [key]: { type: "string" } } } }];
  const saved = structuredClone(input), session = await maskPrivacyRequest(input, options);
  assert.deepEqual(input, saved);assert.equal(session.count, 2);assert.doesNotMatch(session.body.messages[0].content, /ghp_/);
  assert.deepEqual(session.body.messages[1], saved.messages[1]);assert.deepEqual(session.body.tools, input.tools);
  assert.equal(session.restoreText(session.body.messages[0].content), input.messages[0].content);
  assert.equal((await maskPrivacyRequest(input, options)).body.messages[0].content, session.body.messages[0].content);
  assert.notEqual((await maskPrivacyRequest(input, { ...options, client: "codex" })).body.messages[0].content, session.body.messages[0].content);
});
test("personal information is opt-in; examples remain unchanged, byte spans preserve Chinese and emoji", async () => {
  const text = "你好😀 王小明 writes to user@acme.com and demo@example.com";
  const start = Buffer.byteLength("你好😀 "), end = start + Buffer.byteLength("王小明");
  const find = async () => [[{ start, end, label: "private_person", score: 0.91 }]];
  const off = await maskPrivacyRequest(body(text), { ...options, find });assert.equal(off.body.messages[0].content, text);
  const on = await maskPrivacyRequest(body(text), { ...options, find, personal: true });assert.equal(on.count, 2);
  assert.match(on.body.messages[0].content, /你好😀/);assert.match(on.body.messages[0].content, /demo@example.com/);
  assert.equal(on.restoreText(on.body.messages[0].content), text);
});
test("tool argument values are masked, ids and structure survive, and JSON-escaped replies restore exactly", async () => {
  const input = { model: "model", input: [{ type: "function_call", id: key, call_id: key, name: "tool", arguments: JSON.stringify({ name: key, items: [key] }) }] };
  const session = await maskPrivacyRequest(input, { ...options, protocol: "responses" });
  assert.equal(session.body.input[0].id, key);assert.equal(session.body.input[0].call_id, key);
  assert.deepEqual(JSON.parse(session.restoreValue({ arguments: session.body.input[0].arguments }).arguments), { name: key, items: [key] });
});
test("streaming restores placeholders across deltas and UTF-8 transport splits without corrupting events", async () => {
  const session = await maskPrivacyRequest(body(key), options), token = session.body.messages[0].content;
  const events = [
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好😀 " + token.slice(0, 5) } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: token.slice(5) + " done" } },
    { type: "content_block_stop", index: 0 }, { type: "message_stop" },
  ];
  const wire = Buffer.from(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  for (const width of [1, 7, 1024]) {
    const stream = createPrivacyStream(session);let output = "";
    for (let at = 0; at < wire.length; at += width) output += stream.push(wire.subarray(at, at + width));output += stream.finish();
    const values = output.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
    assert.equal(values.filter(event => event.type === "content_block_delta").map(event => event.delta.text).join(""), "你好😀 " + key + " done");
  }
});
test("streamed tool JSON is restored before the block stops and malformed arguments fail closed", async () => {
  const session = await maskPrivacyRequest(body(key), options), token = session.body.messages[0].content;
  const stream = createPrivacyStream(session), arg = JSON.stringify({ credential: token });
  const events = [{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: arg.slice(0, 12) } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: arg.slice(12) } }, { type: "content_block_stop", index: 1 }, { type: "message_stop" }];
  const output = stream.push(Buffer.from(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(""))) + stream.finish();
  const values = output.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
  const args = values.filter(value => value.delta?.type === "input_json_delta").map(value => value.delta.partial_json).join("");
  assert.deepEqual(JSON.parse(args), { credential: key });
  assert.throws(() => createPrivacyStream(session).push(Buffer.from('data: {"bad"\n\n')), { code: "ccdx_privacy_stream_invalid" });
});
test("failed checks and invalid model offsets never return a partially masked request", async () => {
  await assert.rejects(maskPrivacyRequest(body(key), { ...options, find: async () => { throw Error("offline"); } }));
  await assert.rejects(maskPrivacyRequest(body("text"), { ...options, find: async () => [[{ start: 0, end: 99, score: 1, label: "common_secret" }]] }), { code: "ccdx_privacy_engine_invalid" });
});

test("invalid stream restoration detaches before the handler sends its terminal error; plain upstream errors remain readable", async () => {
  const session = await maskPrivacyRequest(body(key), options), written = [];
  const res = { write: value => { written.push(String(value));return true; }, end: value => { if (value) written.push(String(value)); }, writeHead() {}, removeHeader() {}, getHeader() {}, once() {} };
  protectPrivacyResponse(res, session);res.writeHead(200, { "Content-Type": "text/event-stream" });
  assert.throws(() => res.write(Buffer.from('data: {"bad"\n\n')), { code: "ccdx_privacy_stream_invalid" });
  res.end('event: error\ndata: {"error":"closed"}\n\n');assert.equal(written.length, 1);assert.match(written[0], /event: error/);
  const other = await maskPrivacyRequest(body(key), options);written.length = 0;
  protectPrivacyResponse(res, other);res.writeHead(403, { "Content-Type": "text/plain" });res.end("Access denied");assert.equal(written.join(""), "Access denied");
});
