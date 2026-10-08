import assert from "node:assert/strict";
import http from "node:http";
import { startAdapter } from "../src/adapter.mjs";
import { clearResponseHistoryForTests } from "../src/response-history.mjs";
import { createStreamPerformanceMetrics, markUpstreamStarted } from "../src/stream-performance.mjs";

process.env.CCDX_DISABLE_USAGE = "1";
const encoder = new TextEncoder();
const results = [];
for (const scenario of [
  { name: "baseline-idle-disconnect", keepalive: 0, upstreamIdle: 1000, timeout: true },
  { name: "heartbeat-completes", keepalive: 40, upstreamIdle: 1000, timeout: false },
  { name: "heartbeat-does-not-extend-upstream-timeout", keepalive: 40, upstreamIdle: 350, timeout: false },
]) {
  let calls = 0;
  let cancelled = false;
  const metrics = createStreamPerformanceMetrics();
  const server = await startAdapter(0, "127.0.0.1", {
    terminalActivity: null, keepaliveIntervalMs: scenario.keepalive,
    streamIdleTimeoutMs: scenario.upstreamIdle, streamPerformanceMetrics: metrics,
    responsesFn: async (_body, { signal }) => {
      calls += 1;
      markUpstreamStarted(true);
      let timer;
      let onAbort;
      return new Response(new ReadableStream({
        start(controller) {
          onAbort = () => { clearTimeout(timer); cancelled = true; controller.error(signal.reason); };
          signal?.addEventListener("abort", onAbort, { once: true });
          controller.enqueue(encoder.encode('event: response.created\ndata: {"type":"response.created","response":{"id":"idle-fixture","status":"in_progress"}}\n\n'));
          timer = setTimeout(() => {
            controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK","output_index":0}\n\n'));
            controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"idle-fixture","status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":2}}}\n\n'));
            controller.close();
            signal?.removeEventListener("abort", onAbort);
          }, 600);
        },
        cancel() { clearTimeout(timer); cancelled = true; signal?.removeEventListener("abort", onAbort); },
      }), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  try {
    const received = await new Promise(resolve => {
      let body = "";
      let watchdog;
      const finish = result => { clearTimeout(watchdog); resolve(result); };
      const request = http.request({ host: "127.0.0.1", port: server.address().port, path: "/v1/responses", method: "POST",
        headers: { "Content-Type": "application/json", Connection: "close" } }, response => {
        response.setTimeout(200, () => request.destroy(new Error("downstream idle timeout")));
        response.on("data", chunk => { body += chunk; });
        response.on("end", () => finish({ body, error: null }));
        response.on("error", error => finish({ body, error: error.message }));
      });
      request.on("error", error => finish({ body, error: error.message }));
      watchdog = setTimeout(() => request.destroy(new Error("fixture watchdog")), 3000);
      request.end(JSON.stringify({ model: "gpt-5.5", input: "synthetic idle fixture", stream: true }));
    });
    assert.equal(calls, 1);
    if (scenario.timeout) {
      assert.ok(received.error);
      assert.equal(received.body.includes("response.completed"), false);
    } else if (scenario.upstreamIdle === 350) {
      assert.match(received.body, /stream_idle_timeout/);
      assert.equal(received.body.includes("response.completed"), false);
      assert.equal(cancelled, true);
    } else {
      assert.equal(received.error, null);
      assert.match(received.body, /: ccdx keepalive/);
      assert.match(received.body, /response.completed/);
      const route = metrics.snapshot().by_route.responses;
      assert.equal(route.success_with_output, 1);
      assert.ok(route.ttft_ms.avg >= 450, "heartbeats must not count as first model output");
    }
    results.push({ scenario: scenario.name, completed: received.body.includes("response.completed"),
      keepalives: received.body.split(": ccdx keepalive").length - 1, calls, error: received.error });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    clearResponseHistoryForTests();
  }
}
console.log(JSON.stringify({ scope: "synthetic downstream idle socket; no live provider or inference calls", results }, null, 2));
