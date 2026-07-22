import assert from "node:assert/strict";

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

const options = {
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

  const messages = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4.6", max_tokens: 16, messages: [{ role: "user", content: "hello" }] }),
  }).then((response) => response.json());
  assert.equal(messages.type, "message");
  assert.equal(messages.content[0].text, "OK");

  const count = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4.6", messages: [{ role: "user", content: "hello" }] }),
  }).then((response) => response.json());
  assert.ok(count.input_tokens > 0);

  const runtimeStatus = await fetch(`${baseUrl}/_ccdx/status`).then((response) => response.json());
  assert.equal(runtimeStatus.name, "codex-copilot-dx");
  assert.equal(runtimeStatus.requests.total, 5);
  assert.equal(runtimeStatus.requests.active, 0);
  assert.equal(runtimeStatus.admission.activeRequests, 0);
  assert.equal(Object.hasOwn(runtimeStatus.copilot, "token"), false);

  console.log("[OK] Offline HTTP smoke test passed");
} finally {
  await closeHttpServer(server);
}
