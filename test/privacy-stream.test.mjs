import test from "node:test";
import assert from "node:assert/strict";
import { createPrivacyStream } from "../src/privacy-stream.mjs";
import { protectPrivacyResponse } from "../src/privacy-transform.mjs";
import { createStreamPerformanceMetrics } from "../src/stream-performance.mjs";
import { runWithRequestContext } from "../src/request-context.mjs";

const placeholder = "{{CCDX_" + "a".repeat(24) + "}}";
const restored = 'a"b\\c\n中文😀';
const session = () => ({
  count: 1, release() {},
  restoreText: value => value.replaceAll(placeholder, restored),
  restoreValue: value => value,
});
const wire = event => Buffer.from("data: " + JSON.stringify(event) + "\n\n");
const events = output => output.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
const argsFor = (output, index) => events(output).filter(event => event.type === "response.function_call_arguments.delta" && event.output_index === index).map(event => event.delta).join("");

test("JSON argument fragments stream early and escape restored strings without changing scalar types", () => {
  const stream = createPrivacyStream(session()), encoded = JSON.stringify({ value: placeholder, number: 42, flag: true, absent: null });
  let output = stream.push(wire({ type: "response.function_call_arguments.delta", output_index: 0, item_id: "call", delta: encoded.slice(0, 5) }));
  assert.ok(output.length > 0, "Do not wait for a whole argument document");
  for (let at = 5; at < encoded.length; at++) output += stream.push(wire({ type: "response.function_call_arguments.delta", output_index: 0, item_id: "call", delta: encoded[at] }));
  output += stream.push(wire({ type: "response.function_call_arguments.done", output_index: 0, item_id: "call", arguments: encoded }));
  assert.deepEqual(JSON.parse(argsFor(output, 0)), { value: restored, number: 42, flag: true, absent: null });
  assert.equal(stream.finish(), "");
});

test("initial nonempty argument snapshots seed the same string context as later deltas", () => {
  const stream = createPrivacyStream(session()), encoded = JSON.stringify({ value: placeholder });
  const split = 15;
  let output = stream.push(wire({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "seed", arguments: encoded.slice(0, split) } }));
  output += stream.push(wire({ type: "response.function_call_arguments.delta", output_index: 0, item_id: "seed", delta: encoded.slice(split) }));
  output += stream.push(wire({ type: "response.function_call_arguments.done", output_index: 0, item_id: "seed", arguments: encoded }));
  const prefix = events(output).find(event => event.type === "response.output_item.added").item.arguments;
  assert.deepEqual(JSON.parse(prefix + argsFor(output, 0)), { value: restored });
  assert.equal(stream.finish(), "");
});

test("output indices keep interleaved argument channels independent when upstream item IDs vary", () => {
  const stream = createPrivacyStream(session()), encoded = JSON.stringify({ value: placeholder });
  let output = "";
  for (const index of [0, 1]) output += stream.push(wire({ type: "response.function_call_arguments.delta", output_index: index, item_id: "first-" + index, delta: encoded.slice(0, 17) }));
  for (const index of [1, 0]) {
    output += stream.push(wire({ type: "response.function_call_arguments.delta", output_index: index, item_id: "later-" + index, delta: encoded.slice(17) }));
    output += stream.push(wire({ type: "response.function_call_arguments.done", output_index: index, item_id: "done-" + index, arguments: encoded }));
  }
  for (const index of [0, 1]) assert.deepEqual(JSON.parse(argsFor(output, index)), { value: restored });
  assert.ok(events(output).some(event => event.item_id === "later-0"), "Do not rewrite opaque upstream tool IDs");
  assert.equal(stream.finish(), "");
});

test("parallel content parts of one message keep separate placeholder tails and stop boundaries", () => {
  const stream = createPrivacyStream(session());let output = "";
  for (const index of [0, 1]) output += stream.push(wire({ type: "response.output_text.delta", output_index: 0, content_index: index, item_id: "one-message", delta: "part" + index + " " + placeholder.slice(0, 15) }));
  for (const index of [1, 0]) {
    output += stream.push(wire({ type: "response.output_text.delta", output_index: 0, content_index: index, item_id: "one-message", delta: placeholder.slice(15) }));
    output += stream.push(wire({ type: "response.content_part.done", output_index: 0, content_index: index, item_id: "one-message", part: { type: "output_text", text: "part" + index + " " + placeholder } }));
  }
  for (const index of [0, 1]) {
    const text = events(output).filter(event => event.type === "response.output_text.delta" && event.content_index === index).map(event => event.delta).join("");
    assert.equal(text, "part" + index + " " + restored);
  }
  assert.equal(stream.finish(), "");
});

test("literal placeholder prefixes at a text end are delivered with increasing response sequence numbers", () => {
  const stream = createPrivacyStream(session());
  let output = stream.push(wire({ type: "response.output_text.delta", output_index: 0, item_id: "text", sequence_number: 0, delta: "literal {{CCD" }));
  output += stream.push(wire({ type: "response.output_text.done", output_index: 0, item_id: "text", sequence_number: 1, text: "literal {{CCD" }));
  output += stream.push(wire({ type: "response.completed", sequence_number: 2, response: { id: "r", status: "completed", output: [] } }));
  const values = events(output);
  assert.equal(values.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join(""), "literal {{CCD");
  assert.deepEqual(values.map(event => event.sequence_number), [0, 1, 2, 3]);
  assert.equal(stream.completed(), true);assert.equal(stream.finish(), "");
});

test("unmodified event frames keep their wire metadata and bytes", () => {
  const stream = createPrivacyStream(session()), frame = "event: response.output_text.delta\r\nid: opaque\r\nretry: 1000\r\n: keepalive\r\ndata: " + JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "ordinary", sequence_number: 9 }) + "\r\n\r\n";
  assert.equal(stream.push(Buffer.from(frame)), frame);assert.equal(stream.finish(), "");
});

test("privacy restores streamed values with CR, CRLF and LF framing", () => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    const stream = createPrivacyStream(session());
    const delta = { type: "response.output_text.delta", output_index: 0, delta: placeholder };
    const done = { type: "response.completed", response: { id: "r", status: "completed", output: [] } };
    const input = [delta, done].map(event => `event: ${event.type}${ending}id: opaque${ending}data: ${JSON.stringify(event)}${ending}${ending}`).join("");
    const bytes = Buffer.from(input);let output = "";
    for (let at = 0; at < bytes.length; at += 3) output += stream.push(bytes.subarray(at, at + 3));
    output += stream.finish();
    const parsed = output.split(/\r\n|\r|\n/).filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
    assert.equal(parsed[0].delta, restored);assert.equal(parsed.at(-1).type, "response.completed");
    assert.equal(stream.completed(), true);assert.match(output, /id: opaque/);assert.doesNotMatch(output, /\{\{CCDX_/);
  }
});

test("upstream failure releases unfinished state without manufacturing a completed tool", () => {
  const stream = createPrivacyStream(session());
  stream.push(wire({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"value":"{{CCD' }));
  const output = stream.push(wire({ type: "response.failed", response: { id: "r", status: "failed", error: { code: "fixture" } } }));
  assert.deepEqual(events(output).map(event => event.type), ["response.failed"]);
  assert.equal(stream.completed(), false);assert.equal(stream.finish(), "");
});

test("complete argument snapshots can close an incomplete delta sequence without parsing fragments as whole JSON", () => {
  const stream = createPrivacyStream(session()), encoded = JSON.stringify({ value: "ordinary" });
  stream.push(wire({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"value":"' }));
  assert.doesNotThrow(() => stream.push(wire({ type: "response.function_call_arguments.done", output_index: 0, arguments: encoded })));
  assert.equal(stream.finish(), "");
});

test("diagnostics contain codes and bounded structural fields, not invalid event content", () => {
  const stream = createPrivacyStream(session());
  assert.throws(() => stream.push(Buffer.from('data: {"private_fixture"\n\n')), error => {
    assert.equal(error.code, "ccdx_privacy_stream_invalid");
    assert.ok(!JSON.stringify(error.privacyDiagnostic).includes("private_fixture"));
    assert.ok(!error.message.includes("private_fixture"));return true;
  });
  assert.equal(stream.finish(), "");
});

test("fragment validation rejects malformed JSON even when a source omits its argument snapshot", () => {
  const invalid = ['{"x":}', '{"x" 1}', '{"x":1,}', '{"x":[1}}', '{"x":01}', '{"x":1.}', '{"x":tru}', '{"x":"\\q"}', '{"x":1 "y":2}'];
  for (const delta of invalid) {
    const stream = createPrivacyStream(session());
    stream.push(wire({ type: "response.function_call_arguments.delta", output_index: 0, delta }));
    assert.throws(() => stream.push(wire({ type: "response.function_call_arguments.done", output_index: 0 })), { code: "ccdx_privacy_stream_arguments_incomplete" });
    assert.equal(stream.finish(), "");
  }
  for (const delta of ['{"x":0}', '{"x":-2.5e+9}', '{"x":[true,false,null,{}]}', '{"x":"\\u4e2d\\n"}']) {
    const stream = createPrivacyStream(session());
    for (const c of delta) stream.push(wire({ type: "response.function_call_arguments.delta", output_index: 0, delta: c }));
    assert.doesNotThrow(() => stream.push(wire({ type: "response.function_call_arguments.done", output_index: 0 })));
    assert.equal(stream.finish(), "");
  }
});

test("independent JSON parsing verifies varied nested arguments and fragment boundaries", () => {
  let seed = 0xC0FFEE;
  const random = limit => { seed ^= seed << 13;seed ^= seed >>> 17;seed ^= seed << 5;return (seed >>> 0) % limit; };
  const strings = ["plain", "中文😀", 'quotes" and \\ paths', "\n\t\r", placeholder, "literal {{CCD", "\\u007b"];
  function value(depth) {
    const choice = random(depth ? 6 : 4);
    if (choice === 0) return strings[random(strings.length)];
    if (choice === 1) return (random(200000) - 100000) / 100;
    if (choice === 2) return Boolean(random(2));
    if (choice === 3) return null;
    if (choice === 4) return Array.from({ length: random(5) }, () => value(depth - 1));
    return Object.fromEntries(Array.from({ length: random(5) }, (_, i) => ["field" + i, value(depth - 1)]));
  }
  const expected = value => typeof value === "string" ? value.replaceAll(placeholder, restored)
    : Array.isArray(value) ? value.map(expected)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expected(item)])) : value;
  for (let trial = 0; trial < 200; trial++) {
    const input = { nested: value(4), sensitive: placeholder, [placeholder]: "key remains unchanged" }, encoded = JSON.stringify(input), stream = createPrivacyStream(session());
    let output = "";
    for (let at = 0; at < encoded.length;) {
      const length = 1 + random(11);
      output += stream.push(wire({ type: "response.function_call_arguments.delta", output_index: 0, delta: encoded.slice(at, at + length) }));at += length;
    }
    output += stream.push(wire({ type: "response.function_call_arguments.done", output_index: 0, arguments: encoded }));
    assert.deepEqual(JSON.parse(argsFor(output, 0)), expected(input));assert.equal(stream.finish(), "");
  }
});

test("a local response-restoration failure overrides an observed completion in diagnostic accounting", () => {
  const metrics = createStreamPerformanceMetrics(), tracker = metrics.begin("responses", { requestId: "fixture" }), failures = [];
  tracker.upstreamStarted();tracker.terminal("completed", { origin: "upstream_response" });
  const res = { statusCode: 200, write: () => true, end() {}, writeHead() {}, removeHeader() {}, getHeader() {}, once() {} };
  runWithRequestContext({ streamPerformance: tracker }, () => {
    protectPrivacyResponse(res, session(), { onFailure: value => failures.push(value) });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    assert.throws(() => res.write(Buffer.from('data: {"bad"\n\n')));
    tracker.finish({ failed: true, statusCode: 200 });
  });
  const result = metrics.snapshot().recent_requests[0];
  assert.equal(result.outcome, "failed");assert.equal(result.origin, "privacy");
  assert.equal(result.context.privacy_error, "ccdx_privacy_stream_invalid");assert.equal(failures.length, 1);
});

test("socket write errors keep their transport origin instead of being labelled privacy failures", () => {
  const failure = Object.assign(Error("fixture socket closed"), { code: "EPIPE" }), reported = [];
  const res = { statusCode: 200, write() { throw failure; }, end() {}, writeHead() {}, removeHeader() {}, getHeader() {}, once() {} };
  protectPrivacyResponse(res, session(), { onFailure: value => reported.push(value) });res.writeHead(200, { "Content-Type": "text/event-stream" });
  assert.throws(() => res.write(wire({ type: "response.output_text.delta", delta: "ordinary", output_index: 0 })), error => error === failure);
  assert.equal(reported.length, 0);
});

test("a failed terminal restoration never reports the protected response as completed", () => {
  const stream = createPrivacyStream(session());
  stream.push(wire({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"unfinished":' }));
  assert.throws(() => stream.push(wire({ type: "response.completed", response: { id: "r", status: "completed", output: [] } })));
  assert.equal(stream.completed(), false);
});

test("the retention budget also accounts for the incremental validator's nesting state", () => {
  const stream = createPrivacyStream(session(), { maxBufferedBytes: 1024 });
  assert.throws(() => stream.push(wire({ type: "response.function_call_arguments.delta", output_index: 0, delta: "[".repeat(40) })), { code: "ccdx_privacy_stream_limit" });
  assert.equal(stream.finish(), "");
});

test("heartbeats preserve split placeholder tool arguments", () => {
  const stream = createPrivacyStream(session()), encoded = JSON.stringify({ value: placeholder });
  let output = stream.push(wire({ type: "response.function_call_arguments.delta", output_index: 0, delta: encoded.slice(0, 20) }));
  output += stream.push(': heartbeat\n\n');
  output += stream.push(wire({ type: "response.function_call_arguments.delta", output_index: 0, delta: encoded.slice(20) }));
  output += stream.push(wire({ type: "response.function_call_arguments.done", output_index: 0, arguments: encoded }));
  assert.deepEqual(JSON.parse(argsFor(output, 0)), { value: restored });assert.equal(stream.finish(), "");
});
