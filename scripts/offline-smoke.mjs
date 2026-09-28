import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CCDX_DISABLE_USAGE = "1";

const { startAdapter } = await import("../src/adapter.mjs");
const { closeHttpServer } = await import("../src/shutdown.mjs");

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function streamingChatResponse() {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"id":"chat_stream","model":"gpt-4o","choices":[{"delta":{"content":"OK"}}]}\n\n',
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
    "data: [DONE]\n\n",
  ];
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

let chatCalls = 0;
const dashboardHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-dashboard-smoke-"));
const options = {
  dashboardOptions: {
    env: {},
    home: dashboardHome,
    liveModelsFn: async () => ({ advertised: 1, upstreamHost: "smoke.test", models: [{ id: "gpt-5.6-sol", vendor: "OpenAI", endpoints: ["responses"], preview: false }] }),
    usageSummaryFn: async () => ({ requests: 1, totals: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }, byModel: { "gpt-5.6-sol": { requests: 1, input_tokens: 2, output_tokens: 1, total_tokens: 3 } } }),
  },
  listModelsFn: async () => ({
    status: 200,
    body: JSON.stringify({ data: [{ id: "gpt-5.6-sol", supported_endpoints: ["/responses"] }] }),
  }),
  responsesFn: async (body) => jsonResponse({
    id: "resp_direct",
    object: "response",
    status: "completed",
    model: body.model,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
  }),
  chatCompletionsFn: async (body) => {
    chatCalls += 1;
    if (body.stream) return streamingChatResponse();
    return jsonResponse({
      id: "chat_json",
      model: body.model,
      choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
  },
};

let server;
try {
  server = await startAdapter(0, "127.0.0.1", options);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const health = await fetch(`${baseUrl}/_ccdx/health`).then((response) => response.json());
  assert.equal(health.name, "codex-copilot-dx");

  const dashboard = await fetch(`${baseUrl}/`);
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get("content-type"), /^text\/html/);
  assert.match(await dashboard.text(), /CCDX · Local dashboard/);
  const themeScript = await fetch(`${baseUrl}/theme.js`);
  assert.equal(themeScript.status, 200);
  assert.match(await themeScript.text(), /ccdx\.dashboard\.theme/);
  const dashboardScript = await fetch(`${baseUrl}/ui.js`);
  assert.equal(dashboardScript.status, 200);
  assert.match(await dashboardScript.text(), /\/_ccdx\/status/);
  const animation = await fetch(`${baseUrl}/_ccdx/ui/animation`, { headers: { "X-CCDX-Dashboard": "1" } }).then((response) => response.json());
  assert.equal(animation.theme, "comet");
  const savedAnimation = await fetch(`${baseUrl}/_ccdx/ui/animation`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json", "X-CCDX-Dashboard": "1" },
    body: JSON.stringify({ theme: "twin" }),
  });
  assert.equal(savedAnimation.status, 200);
  assert.equal((await savedAnimation.json()).theme, "twin");
  const liveModels = await fetch(`${baseUrl}/_ccdx/ui/models/live`, { headers: { "X-CCDX-Dashboard": "1" } }).then((response) => response.json());
  assert.equal(liveModels.source, "live");
  assert.equal(liveModels.models[0].id, "gpt-5.6-sol");
  const usage = await fetch(`${baseUrl}/_ccdx/ui/usage`, { headers: { "X-CCDX-Dashboard": "1" } }).then((response) => response.json());
  assert.equal(usage.total.total_tokens, 3);

  const models = await fetch(`${baseUrl}/v1/models`).then((response) => response.json());
  assert.equal(models.data[0].id, "gpt-5.6-sol");

  const directResponse = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: false }),
  });
  assert.match(directResponse.headers.get("x-request-id"), /^[a-f0-9-]{36}$/);
  const direct = await directResponse.json();
  assert.equal(direct.id, "resp_direct");
  assert.equal(direct.output[0].content[0].text, "OK");

  const stream = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o", input: "hello", stream: true }),
  });
  assert.equal(stream.status, 200);
  const streamText = await stream.text();
  assert.match(streamText, /event: response\.output_text\.delta/);
  assert.match(streamText, /event: response\.completed/);

  const messagesResponse = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4.6", max_tokens: 16, messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(messagesResponse.status, 410);
  const messages = await messagesResponse.json();
  assert.equal(messages.error.code, "ccdx_claude_retired");

  const countResponse = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4.6", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(countResponse.status, 410);
  const count = await countResponse.json();
  assert.equal(count.error.code, "ccdx_claude_retired");
  assert.equal(chatCalls, 1);

  const runtimeStatus = await fetch(`${baseUrl}/_ccdx/status`).then((response) => response.json());
  assert.equal(runtimeStatus.name, "codex-copilot-dx");
  assert.equal(runtimeStatus.requests.total, 5);
  assert.equal(runtimeStatus.requests.active, 0);
  assert.equal(runtimeStatus.admission.activeRequests, 0);
  assert.equal(runtimeStatus.stream_performance.by_route.responses.preparation_ms.body.samples, 2);
  assert.ok(runtimeStatus.stream_performance.by_route.responses.preparation_ms.serialization.samples >= 1);
  assert.equal(runtimeStatus.stream_performance.by_route.responses.request_ttft_ms.samples, 1);
  assert.equal(Object.hasOwn(runtimeStatus.copilot, "token"), false);

  console.log("[OK] Offline HTTP smoke test passed");
} finally {
  await closeHttpServer(server);
  fs.rmSync(dashboardHome, { recursive: true, force: true });
}
