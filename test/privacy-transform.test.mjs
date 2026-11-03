import test from "node:test";
import assert from "node:assert/strict";
import { maskPrivacyRequest, createPrivacyStream, protectPrivacyResponse, createPrivacyRuleCache } from "../src/privacy-transform.mjs";

const secret = Buffer.alloc(32, 7), noModel = async texts => texts.map(() => []);
const key = "ghp_" + "a".repeat(36);
const options = { protocol: "messages", client: "claude_app", secret, find: noModel };
const body = text => ({ model: "model", messages: [{ role: "user", content: text }], max_tokens: 64 });
test("tool argument buffering scans input linearly rather than rescanning the accumulated prefix", t => {
  const argument = JSON.stringify({ value: "x".repeat(128 * 1024) }), frames = [];
  const frame = event => Buffer.from(`data: ${JSON.stringify(event)}\n\n`);
  for (let at = 0; at < argument.length; at += 512) frames.push(frame({ type: "response.function_call_arguments.delta", item_id: "tool", delta: argument.slice(at, at + 512) }));
  frames.push(frame({ type: "response.function_call_arguments.done", item_id: "tool", arguments: argument }));
  const original = Buffer.byteLength;let scanned = 0;
  t.mock.method(Buffer, "byteLength", (value, ...args) => { const size = original(value, ...args);scanned += size;return size; });
  const stream = createPrivacyStream({ restoreValue: value => value, restoreToolValue: value => value }), output = frames.map(bytes => stream.push(bytes)).join("") + stream.finish();
  const delta = output.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))).filter(event => event.type === "response.function_call_arguments.delta").map(event => event.delta).join("");
  assert.equal(delta, argument);assert.ok(scanned <= frames.reduce((sum, bytes) => sum + bytes.length, 0) * 5, `scanned ${scanned} bytes for a bounded input`);
});

test("UTF-8 buffer accounting keeps surrogate pairs split across tool deltas within their true byte budget", () => {
  const argument = JSON.stringify({ text: "😀".repeat(128) }), stream = createPrivacyStream({ restoreValue: value => value, restoreToolValue: value => value }, { maxBufferedBytes: 800 });
  let output = "";
  for (let at = 0; at < argument.length; at++) output += stream.push(Buffer.from(`data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "u", delta: argument[at] })}\n\n`));
  output += stream.push(Buffer.from('data: {"type":"response.function_call_arguments.done","item_id":"u"}\n\n'));
  const delta = output.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))).filter(event => event.type === "response.function_call_arguments.delta").map(event => event.delta).join("");
  assert.equal(delta, argument);assert.equal(stream.finish(), "");
});
test("parallel tool buffers obey an aggregate budget and release unfinished values on failure", () => {
  const session = { restoreText: value => value, restoreValue: value => value, restoreToolValue: value => value };
  const wire = (id, value) => Buffer.from(`data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: id, delta: value, opaque: "x".repeat(1100) })}\n\n`);
  const stream = createPrivacyStream(session, { maxBufferedBytes: 4096 });
  const partial = JSON.stringify({ value: "{{CCD" }).slice(0, -2);
  assert.ok(stream.push(wire("one", partial)).length > 0, "Safe argument prefixes stream immediately");
  assert.throws(() => stream.push(wire("two", partial)), { code: "ccdx_privacy_stream_limit" });
  assert.equal(stream.finish(), "");
  const channels = createPrivacyStream(session, { maxChannels: 2 });
  channels.push(wire("one", "{}"));channels.push(wire("two", "{}"));
  assert.throws(() => channels.push(wire("three", "{}")), { code: "ccdx_privacy_stream_limit" });
});

test("a large emitted text delta retains only its unfinished placeholder suffix", () => {
  const stream = createPrivacyStream({ restoreText: value => value, restoreValue: value => value }, { maxBufferedBytes: 1024 });
  const wire = text => Buffer.from(`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "text", delta: text })}\n\n`);
  assert.ok(stream.push(wire("x".repeat(1024 * 1024) + "{{CCD")).length > 1024 * 1024);
  assert.ok(stream.push(wire("X_012345678901234567890123}}")).includes("{{CCDX_"));assert.equal(stream.finish(), "");
});

test("EOF cannot silently drop unfinished tool data in a final unterminated SSE frame", () => {
  const stream = createPrivacyStream({ restoreText: value => value, restoreValue: value => value });
  stream.push(Buffer.from('data: {"type":"response.function_call_arguments.delta","item_id":"tool","delta":"{\\"value\\":"}'));
  assert.throws(() => stream.finish(), { code: "ccdx_privacy_stream_incomplete" });
});
test("rule result cache bounds memory, isolates personal policy and returns independent spans", () => {
  const cache = createPrivacyRuleCache({ maxBytes: 512, maxEntries: 2 }), text = "long history ".repeat(30) + key;
  const one = cache.find(text, false);assert.equal(one.length, 1);one[0].start = -1;
  assert.ok(cache.find(text, false)[0].start >= 0);assert.equal(cache.stats().hits, 1);
  cache.find(text, true);assert.equal(cache.stats().scans, 2);
  for (let i = 0; i < 10; i++) cache.find(text + i, false);
  assert.ok(cache.stats().entries <= 2);assert.ok(cache.stats().bytes <= 512);cache.clear();assert.equal(cache.stats().bytes, 0);
});
test("model false-positive filters retain actual labelled numeric secrets and ordinary secret detection", async () => {
  for (const [prefix, label, value, count] of [["secret: ", "common_secret", "123456", 1], ["budget ", "common_secret", "128000", 0], ["token budget: ", "common_secret", "128000", 0], ["PIN: ", "common_secret", "123456", 1], ["密码是 ", "common_secret", "123456", 1], ["const ", "private_person", "Alice", 0], ["Contact ", "private_person", "Alice", 1], ["value ", "common_secret", "aBcd-sensitive", 1]]) {
    const text = prefix + value, start = Buffer.byteLength(prefix);
    const session = await maskPrivacyRequest(body(text), { ...options, personal: true, find: async () => [[{ start, end: start + Buffer.byteLength(value), label, score: 0.99 }]] });
    assert.equal(session.count, count, text);assert.equal(session.restoreText(session.body.messages[0].content), text);
  }
});
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
test("tool data keeps its own field meanings while protocol signatures and identities remain opaque", async () => {
  const data = { type: "thinking", id: key, name: key, signature: key, encrypted_content: key, data: key, nested: [{ arguments: JSON.stringify({ value: key }), enabled: true, count: 2, absent: null }] };
  const input = body(key);
  input.messages.push({ role: "assistant", content: [{ type: "tool_use", id: "tool_protocol", name: "fixture", input: data }] });
  const session = await maskPrivacyRequest(input, options), masked = session.body.messages[1].content[0].input;
  assert.doesNotMatch(JSON.stringify(masked), /ghp_/);
  const event = session.restoreValue({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool_protocol", name: "fixture", input: masked } });
  assert.deepEqual(event.content_block.input, data);assert.equal(event.content_block.id, "tool_protocol");
  const token = session.body.messages[0].content;
  assert.deepEqual(session.restoreValue({ type: "thinking", thinking: token, signature: token }), { type: "thinking", thinking: token, signature: token });
  assert.deepEqual(session.restoreValue({ type: "function_call", id: token, call_id: token, name: "fixture", arguments: JSON.stringify({ signature: token, data: token }) }),
    { type: "function_call", id: token, call_id: token, name: "fixture", arguments: JSON.stringify({ signature: key, data: key }) });
  session.release();
});
test("Responses Lite inline descriptions are masked while definitions and grammars stay intact", async () => {
  const input = { model: "model", input: [{ type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: [
    { type: "custom", name: "fixture", description: key, format: { type: "grammar", definition: key } },
  ] }] }] };
  const session = await maskPrivacyRequest(input, { ...options, protocol: "responses" });
  assert.notEqual(session.body.input[0].tools[0].tools[0].description, key);
  assert.equal(session.body.input[0].tools[0].tools[0].format.definition, key);assert.equal(session.body.input[0].tools[0].name, "functions");session.release();
});
test("restored tool frames preserve their wire metadata and upstream errors discard incomplete parameters", async () => {
  const session = await maskPrivacyRequest(body(key), options), token = session.body.messages[0].content;
  const stream = createPrivacyStream(session), args = JSON.stringify({ signature: token, data: token });
  const output = stream.push(Buffer.from(`event: content_block_delta\r\nid: tool-fragment\r\nretry: 1000\r\n: upstream note\r\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: args } })}\r\n\r\nevent: content_block_stop\r\ndata: {"type":"content_block_stop","index":1}\r\n\r\n`)) + stream.finish();
  assert.equal((output.match(/id: tool-fragment/g) || []).length, 1);assert.match(output, /retry: 1000\r\n: upstream note/);
  const data = output.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
  assert.deepEqual(JSON.parse(data.find(event => event.delta?.type === "input_json_delta").delta.partial_json), { signature: key, data: key });
  const failed = createPrivacyStream(session);
  failed.push(Buffer.from('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"unfinished\\":"}}\n\n'));
  const error = 'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"upstream stopped"}}\n\n';
  assert.match(failed.push(Buffer.from(error)), /upstream stopped/);assert.equal(failed.finish(), "");session.release();
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

test("numeric tool secrets remain protected independently of model false-positive filtering", async () => {
  const input = { model: "model", messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call", name: "example", input: { secret: "123456" } }] }] };
  const session = await maskPrivacyRequest(input, options);assert.equal(session.count, 1);
  assert.notEqual(session.body.messages[0].content[0].input.secret, "123456");assert.deepEqual(session.restoreToolValue(session.body.messages[0].content[0].input), { secret: "123456" });
});
