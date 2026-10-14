import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createAdapterHandler } from "../src/adapter.mjs";
import { createStreamPerformanceMetrics } from "../src/stream-performance.mjs";

for (const protocol of ["native", "chat"]) for (const cancel of [false, true]) {
  test(`${protocol} delivers text before upstream completion and ${cancel ? "cancels without replay" : "finishes without buffering the whole reply"}`, { timeout: 5000 }, async t => {
    const encoder = new TextEncoder();let controller, calls = 0, ended = false, cancelled;
    const stopped = new Promise(resolve => { cancelled = resolve; });
    const frame = data => protocol === "native"
      ? `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n` : `data: ${JSON.stringify(data)}\n\n`;
    const upstream = async (_body, { signal }) => {
      calls++;
      return new Response(new ReadableStream({
        start(value) {
          controller = value;
          signal.addEventListener("abort", () => { cancelled();try { value.error(signal.reason); } catch {} }, { once: true });
          value.enqueue(encoder.encode(frame(protocol === "native"
            ? { type: "response.output_text.delta", item_id: "msg_delivery", output_index: 0, content_index: 0, delta: "first" }
            : { choices: [{ delta: { content: "first" } }] })));
        }, cancel() { cancelled(); },
      }), { headers: { "content-type": "text/event-stream" } });
    };
    const handler = createAdapterHandler({ getCachedModelEndpointsFn: () => protocol === "native" ? ["/responses"] : ["/chat/completions"],
      responsesFn: upstream, chatCompletionsFn: upstream });
    const server = http.createServer(handler);
    t.after(async () => { server.closeAllConnections();await new Promise(resolve => server.close(resolve));handler.cleanup?.(); });
    server.listen(0, "127.0.0.1");await once(server, "listening");
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "synthetic-delivery", input: "test", stream: true }), signal: AbortSignal.timeout(4000) });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();let received = "";
    while (!received.includes("response.output_text.delta")) { const part = await reader.read();assert.equal(part.done, false);received += new TextDecoder().decode(part.value); }
    assert.equal(ended, false, "the first text must reach the real HTTP client before the provider finishes");
    assert.equal(calls, 1);
    if (cancel) {
      await reader.cancel();await stopped;assert.equal(calls, 1);return;
    }
    ended = true;
    const responseBody = { id: "resp_delivery", status: "completed", output: [{ id: "msg_delivery", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "first" }] }] };
    controller.enqueue(encoder.encode(protocol === "native" ? frame({ type: "response.completed", response: responseBody })
      : frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n"));
    controller.close();
    while (true) { const part = await reader.read();if (part.done) break;received += new TextDecoder().decode(part.value); }
    assert.match(received, /response.completed/);assert.equal(calls, 1);
  });
}

test("empty stream completion is a diagnostic, not a failure or retry instruction", () => {
  const metrics = createStreamPerformanceMetrics();
  for (const kind of ["empty", "tool", "refusal", "unknown_usage", "nonstream"]) {
    const tracker = metrics.begin("responses");tracker.upstreamStarted(kind !== "nonstream");
    if (kind !== "unknown_usage") tracker.setOutputTokens(0);
    if (["tool", "refusal"].includes(kind)) tracker.firstOutput("delta");
    tracker.terminal("completed");tracker.finish({ statusCode: 200 });
  }
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.by_route.responses.empty_stream_completions, 1);
  assert.equal(snapshot.by_route.responses.terminal_outcomes.totals.completed, 5);
  assert.equal(snapshot.recent_requests.filter(row => row.empty_stream_completion).length, 1);
});
