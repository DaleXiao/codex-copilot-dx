import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { proxyCopilotResponses } from "../src/responses-proxy.mjs";
import { RUNTIME_DEFAULTS } from "../src/runtime-config.mjs";

function message(id, text = "", status = "in_progress") {
  return {
    id,
    type: "message",
    role: "assistant",
    phase: "commentary",
    status,
    content: text ? [{ type: "output_text", text, annotations: [] }] : [],
  };
}

function frame(event, newline = "\n") {
  return `event: ${event.type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`;
}

function completed(output = []) {
  return {
    type: "response.completed",
    response: { id: "resp_message_transport", status: "completed", output },
  };
}

function parseEvents(text) {
  return text.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    return data ? [JSON.parse(data)] : [];
  });
}

function startProxy(chunks, { backpressure = false } = {}) {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      const chunk = chunks[pulls];
      pulls += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const res = new EventEmitter();
  const writes = [];
  const snapshots = [];
  res.destroyed = false;
  res.writableEnded = false;
  res.headersSent = false;
  res.writeHead = () => { res.headersSent = true; };
  res.write = (chunk) => {
    writes.push(chunk);
    snapshots.push(Buffer.from(chunk));
    return !(backpressure && writes.length === 1);
  };
  res.end = (chunk) => {
    if (chunk !== undefined) res.write(chunk);
    res.writableEnded = true;
  };
  const pending = proxyCopilotResponses({
    body: { model: "gpt-6-astra", stream: true, input: [] },
    surface: "responses",
  }, {}, res, async () => new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  }));
  return {
    pending,
    res,
    body,
    writes,
    snapshots,
    pulls: () => pulls,
    cancelled: () => cancelled,
    text: () => Buffer.concat(writes).toString("utf8"),
  };
}

test("native message transport preserves stable bytes across UTF-8, CRLF and multi-data fragments", async () => {
  const initial = message("message_stable");
  const final = message(initial.id, "我先验证 1 + 1。🛰️", "completed");
  const multiline = [
    ": keep this comment",
    "id: event-source-id",
    "retry: 1200",
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta", "output_index":0,',
    `data: "item_id":"${initial.id}", "content_index":0, "delta":"${final.content[0].text}"}`,
    "",
    "",
  ].join("\r\n");
  const input = Buffer.from([
    frame({ type: "response.output_item.added", output_index: 0, item: initial }, "\r\n"),
    multiline,
    frame({ type: "response.output_item.done", output_index: 0, item: final }, "\r\n"),
    frame(completed([final]), "\r\n"),
  ].join(""));
  const chunks = Array.from({ length: input.length }, (_, index) => input.subarray(index, index + 1));
  const run = startProxy(chunks);
  assert.deepEqual(await run.pending, { successful: true, compacted: false });
  assert.deepEqual(Buffer.concat(run.writes), input);
  assert.equal(run.cancelled(), true);
  assert.equal(run.body.locked, false);
});

test("native message transport rewrites split multi-data events while preserving their SSE metadata", async () => {
  const initial = message("message_first");
  const final = message("message_last", "中文 🛰️", "completed");
  const multiline = [
    ": before data",
    "id: event-source-id",
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta", "output_index":0,',
    ": between data",
    'data: "item_id":"message_delta", "content_index":0, "delta":"中文 🛰️"}',
    "retry: 1200",
    "",
    "",
  ].join("\r\n");
  const input = Buffer.from([
    frame({ type: "response.output_item.added", output_index: 0, item: initial }, "\r\n"),
    multiline,
    frame({ type: "response.output_item.done", output_index: 0, item: final }, "\r\n"),
    frame(completed([final]), "\r\n"),
    "event: must-not-leak\r\ndata: invalid-json\r\n\r\n",
  ].join(""));
  const chunks = Array.from({ length: input.length }, (_, index) => input.subarray(index, index + 1));
  const run = startProxy(chunks);
  assert.deepEqual(await run.pending, { successful: true, compacted: false });
  const output = run.text();
  const events = parseEvents(output);
  assert.equal(events.length, 4);
  assert.equal(events[1].item_id, initial.id);
  assert.equal(events[1].delta, "中文 🛰️");
  assert.equal(events[2].item.id, initial.id);
  assert.equal(events[3].response.output[0].id, initial.id);
  const block = output.split("\r\n\r\n")[1];
  assert.deepEqual(block.split("\r\n").filter((line) => !line.startsWith("data:")), [
    ": before data",
    "id: event-source-id",
    "event: response.output_text.delta",
    ": between data",
    "retry: 1200",
  ]);
  assert.doesNotMatch(output, /(?<!\r)\n|must-not-leak|message_delta|message_last/);
  assert.equal(run.cancelled(), true);
});

test("native message transport respects backpressure and retains buffers after later events reuse parser storage", async () => {
  const initial = message("message_backpressure");
  const added = frame({ type: "response.output_item.added", output_index: 0, item: initial });
  const delta = frame({
    type: "response.output_text.delta", output_index: 0, content_index: 0,
    item_id: "message_changed", delta: "x".repeat(10_000),
  });
  const run = startProxy([
    Buffer.from(added.slice(0, 35)),
    Buffer.from(added.slice(35) + delta.slice(0, 35)),
    Buffer.from(delta.slice(35) + frame(completed())),
  ], { backpressure: true });
  await nextTurn();
  assert.equal(run.pulls(), 2, "downstream drain must precede another upstream read");
  assert.equal(run.writes.length, 1);
  const first = Buffer.from(run.writes[0]);
  await nextTurn();
  assert.equal(run.pulls(), 2);
  assert.deepEqual(run.writes[0], first);
  run.res.emit("drain");
  assert.deepEqual(await run.pending, { successful: true, compacted: false });
  assert.deepEqual(run.writes.map((chunk) => Buffer.from(chunk)), run.snapshots,
    "buffers already handed to the writable cannot be overwritten by subsequent parsing");
  assert.deepEqual(run.writes[0], first);
  assert.equal(parseEvents(run.text())[1].item_id, initial.id);
  assert.equal(run.pulls(), 3);
  assert.equal(run.cancelled(), true);
});

test("native message transport cancels upstream when a backpressured downstream closes", async () => {
  const initial = message("message_cancel");
  const run = startProxy([
    Buffer.from(frame({ type: "response.output_item.added", output_index: 0, item: initial })),
    Buffer.from(frame(completed())),
  ], { backpressure: true });
  await nextTurn();
  assert.equal(run.pulls(), 1);
  run.res.destroyed = true;
  run.res.emit("close");
  await run.pending;
  assert.equal(run.cancelled(), true);
  assert.equal(run.body.locked, false);
  assert.equal(run.pulls(), 1);
  assert.equal(run.res.listenerCount("drain"), 0);
  assert.equal(run.res.listenerCount("close"), 0);
  assert.equal(run.res.listenerCount("error"), 0);
  assert.equal(run.writes.length, 1);
});

test("native message transport rewrites an 8 MiB boundary event with linear fragmented buffer growth", async () => {
  const limit = RUNTIME_DEFAULTS.maxSseBufferBytes;
  const added = Buffer.from(frame({ type: "response.output_item.added", output_index: 0, item: message("A") }));
  const prefix = Buffer.from('event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","output_index":0,"item_id":"B","delta":"');
  const suffix = Buffer.from('"}');
  const event = Buffer.concat([prefix, Buffer.alloc(limit - prefix.length - suffix.length, 0x78), suffix, Buffer.from("\r\n\r\n")]);
  const chunks = [added];
  for (let offset = 0; offset < event.length; offset += 4093) {
    chunks.push(event.subarray(offset, offset + 4093));
  }
  chunks.push(Buffer.from(frame(completed()) + "event: invalid\ndata: must-not-leak\n\n"));

  const originalCopy = Buffer.prototype.copy;
  const originalToString = Buffer.prototype.toString;
  let copiedBytes = 0;
  let decodedBytes = 0;
  Buffer.prototype.copy = function trackedCopy(...args) {
    const copied = originalCopy.apply(this, args);
    copiedBytes += copied;
    return copied;
  };
  Buffer.prototype.toString = function trackedDecode(encoding, start = 0, end = this.length) {
    decodedBytes += Math.max(0, end - start);
    return originalToString.call(this, encoding, start, end);
  };
  let run;
  try {
    run = startProxy(chunks);
    assert.deepEqual(await run.pending, { successful: true, compacted: false });
  } finally {
    Buffer.prototype.copy = originalCopy;
    Buffer.prototype.toString = originalToString;
  }
  const events = parseEvents(run.text());
  assert.equal(events.length, 3);
  assert.equal(events[1].item_id, "A");
  assert.equal(events[1].delta.length, limit - prefix.length - suffix.length);
  assert.ok(copiedBytes < limit * 3, `copied ${copiedBytes} bytes for one ${limit}-byte event`);
  assert.ok(decodedBytes < limit * 3, `decoded ${decodedBytes} bytes for one ${limit}-byte event`);
  assert.equal(run.cancelled(), true);
});
