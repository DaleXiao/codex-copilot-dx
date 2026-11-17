import test from "node:test";
import assert from "node:assert/strict";
import { createSourceAdmission } from "../src/source-admission.mjs";
import { sourceResponseReader, releaseSourceReader, cloneSourceResponse, cancelSourceResponse, whenSourceReleased } from "../src/source-response.mjs";
import { readBoundedResponseText, readResponseChunk } from "../src/upstream-body.mjs";

const source = { source: "github", account: "synthetic" }, options = { sourceBodyManaged: true }, tick = () => new Promise(resolve => setImmediate(resolve));

test("managed consumers retain native response/body and release the source at EOF", async () => {
  const scheduler = createSourceAdmission(), raw = new Response("synthetic");
  const response = await scheduler.run(source, async () => raw, options);assert.strictEqual(response, raw);
  assert.equal(await readBoundedResponseText(response, { maxBytes: 1024 }), "synthetic");assert.equal(scheduler.snapshot()[0].active, 0);scheduler.close();
});

test("managed clone EOF frees upstream while another branch only retains local buffered data", async () => {
  const scheduler = createSourceAdmission(), response = await scheduler.run(source, async () => new Response("buffered"), options), clone = cloneSourceResponse(response);
  assert.equal(await readBoundedResponseText(clone, { maxBytes: 1024 }), "buffered");assert.equal(response.bodyUsed, false);assert.equal(scheduler.snapshot()[0].active, 0);
  assert.equal(await response.text(), "buffered");scheduler.close();
});

test("cancelling one managed clone retains the source; cancelling both never waits for stalled cleanup", async () => {
  let cancelled = 0;const scheduler = createSourceAdmission(), response = await scheduler.run(source, async () => new Response(new ReadableStream({ cancel() { cancelled++;return new Promise(() => {}); } })), options);
  const clone = cloneSourceResponse(response);await cancelSourceResponse(clone);assert.equal(scheduler.snapshot()[0].active, 1);
  await cancelSourceResponse(response);await whenSourceReleased(response, { timeoutMs: 20 });await tick();
  assert.equal(cancelled, 1);assert.equal(scheduler.snapshot()[0].active, 0);scheduler.close();
});

test("managed early unlock is not EOF and a released reader cannot settle its replacement", async () => {
  let controller;const scheduler = createSourceAdmission(), response = await scheduler.run(source, async () => new Response(new ReadableStream({ start(value) { controller = value; } })), options);
  const first = sourceResponseReader(response), pending = readResponseChunk(first);releaseSourceReader(first);await assert.rejects(pending, TypeError);
  assert.equal(scheduler.snapshot()[0].active, 1);const second = sourceResponseReader(response);controller.close();await readResponseChunk(second);releaseSourceReader(second);
  assert.equal(scheduler.snapshot()[0].active, 0);scheduler.close();
});

test("managed transport errors settle before caller finally unlocks", async () => {
  let controller;const scheduler = createSourceAdmission(), response = await scheduler.run(source, async () => new Response(new ReadableStream({ start(value) { controller = value; } })), options);
  const reader = sourceResponseReader(response);controller.error(new Error("synthetic source failure"));
  try { await assert.rejects(readResponseChunk(reader), /synthetic source failure/); } finally { releaseSourceReader(reader); }
  assert.equal(scheduler.snapshot()[0].active, 0);scheduler.close();
});

test("managed original-body feedback remains available after bounded clone classification times out", async () => {
  const scheduler = createSourceAdmission();let timer;
  try {
    const response = await scheduler.run(source, async () => new Response(new ReadableStream({ start(controller) { timer = setTimeout(() => { controller.enqueue(Buffer.from('{"error":{"code":"concurrency_limit","limit":1}}'));controller.close(); }, 240); } }), { status: 429 }), options);
    assert.equal(scheduler.snapshot()[0].limit, 128);await readBoundedResponseText(response, { maxBytes: 1024 });assert.equal(scheduler.snapshot()[0].limit, 1);assert.equal(scheduler.snapshot()[0].active, 0);
  } finally { clearTimeout(timer);scheduler.close(); }
});
