import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createAdapterHandler } from "../src/adapter.mjs";

async function invokeMessages(chatCompletionsFn) {
  const req = Readable.from([Buffer.from(JSON.stringify({
    model: "claude-sonnet-4.6",
    max_tokens: 64,
    messages: [{ role: "user", content: "use the tool" }],
  }))]);
  req.headers = { "content-type": "application/json" };
  req.method = "POST";
  req.url = "/v1/messages";
  req.socket = { remoteAddress: "127.0.0.1" };

  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.headersSent = false;
  res.statusCode = 200;
  const chunks = [];
  res.writeHead = (statusCode) => {
    res.statusCode = statusCode;
    res.headersSent = true;
    return res;
  };
  res.write = (chunk) => {
    chunks.push(Buffer.from(chunk));
    return true;
  };
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  res.end = (chunk) => {
    if (chunk !== undefined) chunks.push(Buffer.from(chunk));
    res.writableEnded = true;
    finish();
    return res;
  };

  const pending = createAdapterHandler({ chatCompletionsFn })(req, res);
  await Promise.all([pending, finished]);
  return { status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") };
}

test("HTTP Messages rejects malformed and non-object upstream tool arguments without leaking them", async () => {
  const cases = [
    "{\"private\":\"raw-invalid-secret\"",
    '"raw-scalar-secret"',
  ];

  for (const rawArguments of cases) {
    const result = await invokeMessages(async () => Response.json({
      model: "claude-sonnet-4.6",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [{
            id: "call_dangerous",
            type: "function",
            function: { name: "dangerous_tool", arguments: rawArguments },
          }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    }));

    assert.equal(result.status, 502);
    const payload = JSON.parse(result.text);
    assert.equal(payload.error.code, "upstream_tool_arguments_json_invalid");
    assert.equal(payload.error.type, "upstream_protocol_error");
    assert.doesNotMatch(result.text, /tool_use|"input"\s*:\s*\{\}/);
    assert.doesNotMatch(result.text, /raw-(?:invalid|scalar)-secret/);
    assert.equal(result.text.includes(rawArguments), false);
  }
});
