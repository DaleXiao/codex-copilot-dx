import { test } from "node:test";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { fetchWithBodyWriteTiming } from "../src/copilot-send-timing.mjs";
import { createStreamPerformanceMetrics } from "../src/stream-performance.mjs";

const emit = (event, request, extra) => channel(`undici:request:${event}`).publish({ request, ...extra });

function attempt(clientId) {
  let time = 10;
  const obs = createStreamPerformanceMetrics({ now: () => time, routeNames: ["antigravity"] }).begin("antigravity");
  obs.upstreamStarted();
  return { callback: obs.observeUpstreamBodyWrite(clientId), advance(value) { time += value; }, values: () => obs.attemptTimings()[0] };
}

test("request write bytes and the send completion event remain separate", async () => {
  const outboundId = "05a8745c-b7e6-437d-ba45-82f0c9c5e2f5";
  const trace = attempt(outboundId);
  await fetchWithBodyWriteTiming("unused", {}, trace.callback, async () => {
    const request = {};
    emit("create", request);
    emit("bodyChunkSent", {}, { chunk: new Uint8Array(100) });
    emit("bodyChunkSent", request, { chunk: "中文" });
    emit("bodyChunkSent", request, { chunk: new Uint8Array(2) });
    assert.equal(trace.values().body_written_bytes, 8);
    assert.equal(trace.values().client_request_id, outboundId);
    assert.equal(trace.values().body_sent_ms, undefined);
    trace.advance(23);
    emit("bodySent", request);
    assert.equal(trace.values().body_sent_ms, 23);
    return undefined;
  });
});

test("an independent transport error preserves partial bytes without marking a completed send", async () => {
  const trace = attempt();
  const err = Object.assign(new Error("not part of the receipt"), { code: "ECONNRESET" });
  await assert.rejects(fetchWithBodyWriteTiming("unused", {}, trace.callback, async () => {
    const request = {};
    emit("create", request);
    emit("bodyChunkSent", request, { chunk: new Uint8Array(23) });
    emit("error", request, { error: err });
    throw err;
  }), { code: "ECONNRESET" });
  assert.equal(trace.values().body_written_bytes, 23);
  assert.equal(trace.values().body_sent_ms, undefined);
  assert.equal(trace.values().transport_error, "ECONNRESET");
  assert.doesNotMatch(JSON.stringify(trace.values()), /not part of the receipt/);
});

test("a local deadline does not become an upstream socket error", async () => {
  const trace = attempt();
  const controller = new AbortController();
  await fetchWithBodyWriteTiming("unused", { signal: controller.signal }, trace.callback, async () => {
    const request = {};
    emit("create", request);
    controller.abort();
    emit("error", request, { error: { code: "UND_ERR_SOCKET" } });
    return undefined;
  });
  assert.equal(trace.values().body_written_bytes, 0);
  assert.equal(trace.values().transport_error, undefined);
});
