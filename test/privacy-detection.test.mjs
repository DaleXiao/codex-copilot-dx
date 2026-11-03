import test from "node:test";
import assert from "node:assert/strict";
import { createPrivacyDetection, privacyPieces } from "../src/privacy-detection.mjs";
import { validatePrivacyFindings } from "../src/privacy-findings.mjs";

const tick = () => new Promise(setImmediate);
async function waitFor(check) {
  for (let at = 0; at < 60 && !check(); at++) await tick();
  assert.ok(check(), "The isolated detector did not reach the expected state");
}
const text = n => Array.from({ length: n }, (_, i) => "line " + i + ": ordinary data 中文😀\n").join("");
function model() {
  const calls = [];
  return { calls, find: async texts => { calls.push([...texts]);return texts.map(() => []); } };
}
test("pieces cover mixed UTF-8 text with bounded overlap and stable append boundaries", () => {
  const first = text(120), second = first + text(30), a = privacyPieces(first, { pieceBytes: 128, overlapBytes: 32 }), b = privacyPieces(second, { pieceBytes: 128, overlapBytes: 32 });
  const original = Buffer.from(first);
  assert.ok(a.length > 4);assert.equal(a[0].offset, 0);
  for (let i = 0; i < a.length; i++) {
    const piece = a[i], bytes = Buffer.from(piece.text);
    assert.ok(bytes.length <= 128);assert.ok(!piece.text.includes("\uFFFD"));
    assert.ok(original.subarray(piece.offset, piece.offset + bytes.length).equals(bytes));
    if (i) {
      const end = a[i - 1].offset + Buffer.byteLength(a[i - 1].text);
      assert.ok(piece.offset < end && end - piece.offset <= 32);
    }
  }
  assert.equal(a.at(-1).offset + Buffer.byteLength(a.at(-1).text), original.length);
  assert.deepEqual(a.slice(0, -1), b.slice(0, a.length - 1));
});

test("cached long histories reuse unchanged pieces after an append without changing the original input", async t => {
  const engine = model(), detection = createPrivacyDetection(engine, { pieceBytes: 128, overlapBytes: 32, batchBytes: 256 });
  t.after(() => detection.close());
  const first = text(120);await detection.find([first]);const old = new Set(engine.calls.flat());engine.calls.length = 0;
  await detection.find([first + text(10)]);
  assert.ok(engine.calls.length > 0);
  assert.ok(engine.calls.flat().every(piece => !old.has(piece)), "An unchanged cached piece was submitted again");
  const before = engine.calls.length;await detection.find([first + text(10)]);assert.equal(engine.calls.length, before);
});

test("duplicate piece work is shared while completed results retain full global byte offsets", async t => {
  let release;const calls = [];
  const detection = createPrivacyDetection({ find: texts => { calls.push(texts);return new Promise(resolve => { release = resolve; }); } });
  t.after(() => detection.close());
  const first = detection.find(["ordinary sample"]), second = detection.find(["ordinary sample"]);
  assert.equal(calls.length, 1);release([[]]);
  assert.deepEqual(await first, [[]]);assert.deepEqual(await second, [[]]);
  assert.equal(detection.snapshot().submitted_batches, 1);
});

test("cancellation commits the submitted batch and retries only pieces that were never completed", async t => {
  const calls = [], detection = createPrivacyDetection({ find: texts => new Promise(resolve => calls.push({ texts: [...texts], resolve })) },
    { pieceBytes: 128, overlapBytes: 32, batchBytes: 256 });
  t.after(() => detection.close());const input = text(80), abort = new AbortController();
  const pending = detection.find([input], { signal: abort.signal });assert.equal(calls.length, 1);
  abort.abort(Error("cancelled"));await assert.rejects(pending, /cancelled/);
  const completed = new Set(calls[0].texts);calls[0].resolve(calls[0].texts.map(() => []));await tick();await tick();
  assert.equal(calls.length, 1);
  const retry = detection.find([input]);await waitFor(() => calls.length > 1);
  const deadline = Date.now() + 2000;let at = 1;
  while (detection.busy() && Date.now() < deadline) {
    if (calls[at]) {
      assert.ok(calls[at].texts.every(piece => !completed.has(piece)));
      for (const piece of calls[at].texts) completed.add(piece);
      calls[at].resolve(calls[at].texts.map(() => []));at++;
    }
    await tick();
  }
  assert.deepEqual(await retry, [[]]);assert.equal(detection.busy(), false);
});

test("a short request gets a native turn before the rest of a long history", async t => {
  const calls = [], detection = createPrivacyDetection({ find: texts => new Promise(resolve => calls.push({ texts, resolve })) },
    { pieceBytes: 128, overlapBytes: 32, batchBytes: 256 });
  t.after(() => detection.close());
  const abort = new AbortController(), long = detection.find([text(80)], { signal: abort.signal });long.catch(() => {});
  const short = detection.find(["short new request"]);calls[0].resolve(calls[0].texts.map(() => []));
  await waitFor(() => calls.length >= 2);assert.deepEqual(calls[1].texts, ["short new request"]);
  calls[1].resolve([[]]);await short;abort.abort(Error("finished fixture"));await assert.rejects(long);
  for (const call of calls.slice(2)) call.resolve(call.texts.map(() => []));
});

test("piece overlap merges a boundary secret once at the original global offsets", async t => {
  const marker = "ABCDEFGHIJKLMNO", input = "x".repeat(120) + marker + " " + text(20);
  const detection = createPrivacyDetection({ find: async texts => texts.map(value => {
    const at = value.indexOf(marker);return at < 0 ? [] : [{ start: Buffer.byteLength(value.slice(0, at)), end: Buffer.byteLength(value.slice(0, at)) + marker.length, label: "common_secret", score: 0.99 }];
  }) }, { pieceBytes: 128, overlapBytes: 32, batchBytes: 256 });
  t.after(() => detection.close());
  assert.deepEqual(await detection.find([input]), [[{ start: 120, end: 135, label: "common_secret", score: 0.99 }]]);
});

test("invalid UTF-8 span boundaries and bad engine results never enter the reusable cache", async t => {
  assert.throws(() => validatePrivacyFindings(["中文"], [[{ start: 1, end: 3, label: "private_person", score: 0.9 }]]), { code: "ccdx_privacy_engine_invalid" });
  let calls = 0;
  const detection = createPrivacyDetection({ find: async texts => { calls++;return calls === 1 ? [[{ start: 0, end: 999, label: "common_secret", score: 0.9 }]] : texts.map(() => []); } });
  t.after(() => detection.close());
  await assert.rejects(detection.find(["short"]), { code: "ccdx_privacy_engine_invalid" });
  assert.deepEqual(await detection.find(["short"]), [[]]);assert.equal(calls, 2);
});

test("pending admission and cache limits remain bounded and diagnostics contain no text", async t => {
  const detection = createPrivacyDetection({ find: texts => new Promise(() => {}) }, { maxPendingBytes: 16, maxPendingEntries: 2 });
  t.after(() => detection.close());
  await assert.rejects(detection.find(["x".repeat(17)]), { code: "ccdx_privacy_busy" });
  assert.equal(detection.snapshot().pending_pieces, 0);
  assert.ok(!JSON.stringify(detection.snapshot()).includes("xxxxxxxx"));
  const engine = model(), small = createPrivacyDetection(engine, { maxCacheBytes: 256, maxCacheEntries: 1 });
  t.after(() => small.close());await small.find(["one"]);await small.find(["two"]);
  assert.ok(small.snapshot().cache_bytes <= 256);assert.ok(small.snapshot().cache_entries <= 1);
});
