import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { startClaudeGateway } from "../src/claude-gateway.mjs";
import { startAdapter } from "../src/adapter.mjs";
import { createLocalPrivacy } from "../src/local-privacy.mjs";
import { userSettingsPath } from "../src/user-settings.mjs";

for (const protocol of ["responses", "messages"]) test(`${protocol} privacy timeout preserves work, sends Retry-After, and recovers without an upstream retry`, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-timeout-http-")), env = {}, file = userSettingsPath({ home, env }), jobs = [];
  fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, '{"privacy_enabled":true}');
  const model = { load: async () => {}, snapshot: () => ({ state: "ready" }), find: texts => new Promise(resolve => jobs.push({ texts, resolve })), close() {}, busy: () => false };
  const privacy = createLocalPrivacy({ home, env, model, checkTimeoutMs: 5 });let upstream = 0;
  const reply = async body => { upstream++;return Response.json(protocol === "responses"
    ? { id: "synthetic", status: "completed", model: body.model, output: [], usage: { input_tokens: 1, output_tokens: 0 } }
    : { id: "synthetic", type: "message", model: body.model, role: "assistant", content: [], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 0 } }); };
  const key = "a".repeat(64), server = protocol === "responses"
    ? await startAdapter(0, "127.0.0.1", { privacy, env, dashboardOptions: { home, env }, responsesFn: reply,
      codexClient: { getCachedModelEndpoints: () => ["/responses"] }, modelRegistry: { models: { data: [{ id: "fixture", supported_endpoints: ["/responses"] }] } } })
    : await startClaudeGateway({ port: 0, apiKey: key, privacy, env, record() {}, provider: { id: "m365", models: () => [{ id: "fixture" }], client: { messages: reply } } });
  t.after(async () => { if (protocol === "responses") { server.closeAllConnections();await new Promise(resolve => server.close(resolve)); } else await server.close();privacy.close();fs.rmSync(home, { recursive: true, force: true }); });
  const port = protocol === "responses" ? server.address().port : server.port, body = protocol === "responses" ? { model: "fixture", input: "synthetic slow history", stream: false }
    : { model: "fixture", messages: [{ role: "user", content: "synthetic slow history" }], max_tokens: 1 };
  const send = () => fetch(`http://127.0.0.1:${port}/v1/${protocol}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const timed = await send();assert.equal(timed.status, 503);assert.equal(timed.headers.get("retry-after"), "5");
  assert.equal((await timed.json()).error.code, "ccdx_privacy_check_timeout");assert.equal(upstream, 0);assert.equal(jobs.length, 1);
  jobs[0].resolve(jobs[0].texts.map(() => []));await new Promise(setImmediate);
  const retry = await send();assert.equal(retry.status, 200);await retry.text();assert.equal(upstream, 1);assert.equal(jobs.length, 1);
});

for (const protocol of ["responses", "messages"]) test(`${protocol} restores masked content from CR-only SSE`, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-privacy-cr-")), env = {}, file = userSettingsPath({ home, env });
  fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, '{"privacy_enabled":true}');
  const model = { load: async () => {}, find: async texts => texts.map(() => []), snapshot: () => ({ state: "ready" }), close() {}, busy: () => false };
  const privacy = createLocalPrivacy({ home, env, model }), original = "ghp_" + "x".repeat(36), key = "a".repeat(64);
  const reply = async body => {
    assert.doesNotMatch(JSON.stringify(body), /ghp_/);
    const masked = protocol === "messages" ? body.messages[0].content : typeof body.input === "string" ? body.input : body.input[0].content[0].text;
    const events = protocol === "messages" ? [
      { type: "message_start", message: { id: "msg_cr", model: body.model, usage: { input_tokens: 1 } } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: masked } },
      { type: "content_block_stop", index: 0 }, { type: "message_stop" },
    ] : [
      { type: "response.output_text.delta", output_index: 0, item_id: "text_cr", delta: masked },
      { type: "response.output_text.done", output_index: 0, item_id: "text_cr", text: masked },
      { type: "response.completed", response: { id: "response_cr", status: "completed", output: [] } },
    ];
    return new Response(events.map(event => `event: ${event.type}\rdata: ${JSON.stringify(event)}\r\r`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  };
  const server = protocol === "responses" ? await startAdapter(0, "127.0.0.1", { privacy, env, dashboardOptions: { home, env }, responsesFn: reply,
    getCachedModelEndpointsFn: () => ["/responses"] }) : await startClaudeGateway({ port: 0, apiKey: key, privacy, env, record() {},
    provider: { id: "m365", models: () => [{ id: "fixture" }], client: { messages: reply } } });
  t.after(async () => { if (protocol === "responses") { server.closeAllConnections();await new Promise(resolve => server.close(resolve)); } else await server.close();privacy.close();fs.rmSync(home, { recursive: true, force: true }); });
  const port = protocol === "responses" ? server.address().port : server.port;
  const body = protocol === "responses" ? { model: "gpt-5.6-sol", input: original, stream: true }
    : { model: "fixture", messages: [{ role: "user", content: original }], max_tokens: 4, stream: true };
  const result = await fetch(`http://127.0.0.1:${port}/v1/${protocol}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(result.status, 200);
  const events = (await result.text()).split(/\r\n|\r|\n/).filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
  const text = events.filter(event => event.type === (protocol === "responses" ? "response.output_text.delta" : "content_block_delta"))
    .map(event => protocol === "responses" ? event.delta : event.delta.text).join("");
  assert.equal(text, original);assert.equal(events.at(-1).type, protocol === "responses" ? "response.completed" : "message_stop");
});

test("Responses restores protected error text in a synthesized failure without waiting for EOF", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-privacy-failure-")), env = {}, file = userSettingsPath({ home, env });
  fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, '{"privacy_enabled":true}');
  const model = { load: async () => {}, find: async texts => texts.map(() => []), snapshot: () => ({ state: "ready" }), close() {}, busy: () => false };
  const privacy = createLocalPrivacy({ home, env, model }), original = "ghp_" + "r".repeat(36);let cancelled = false;
  const server = await startAdapter(0, "127.0.0.1", { privacy, env, dashboardOptions: { home, env }, responsesFn: async body => {
    const masked = typeof body.input === "string" ? body.input : body.input[0].content[0].text;
    assert.notEqual(masked, original);
    const events = [{ type: "response.created", sequence_number: 0, response: { id: "resp_private", created_at: 1700000000, model: body.model, status: "in_progress", output: [] } },
      { error: { code: "fixture_failure", message: "denied " + masked } }];
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))); },
      cancel() { cancelled = true; } }), { headers: { "Content-Type": "text/event-stream" } });
  }, getCachedModelEndpointsFn: () => ["/responses"] });
  t.after(async () => { server.closeAllConnections();await new Promise(resolve => server.close(resolve));privacy.close();fs.rmSync(home, { recursive: true, force: true }); });
  const result = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-5.6-sol", input: original, stream: true }) });
  const events = (await result.text()).split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
  assert.equal(cancelled, true);assert.equal(events.at(-1).type, "response.failed");
  assert.equal(events.at(-1).response.error.message, "denied " + original);
});

test("Responses preserves precise tool arguments through privacy masking and JSON restoration", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-privacy-numbers-")), env = {}, file = userSettingsPath({ home, env });
  fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, '{"privacy_enabled":true}');
  const model = { load: async () => {}, find: async texts => texts.map(() => []), snapshot: () => ({ state: "ready" }), close() {}, busy: () => false };
  const privacy = createLocalPrivacy({ home, env, model }), original = "ghp_" + "n".repeat(36);
  const args = `{"id":9007199254740993,"decimal":0.123456789012345678901,"credential":${JSON.stringify(original)}}`;
  let upstreamArgs;
  const server = await startAdapter(0, "127.0.0.1", { privacy, env, dashboardOptions: { home, env }, responsesFn: async body => {
    upstreamArgs = body.input.find(item => item.type === "function_call").arguments;
    return Response.json({ id: "resp_numbers", status: "completed", model: body.model, output: [
      { type: "function_call", id: "out", call_id: "call_out", name: "tool", arguments: upstreamArgs },
    ] });
  }, getCachedModelEndpointsFn: () => ["/responses"] });
  t.after(async () => { server.closeAllConnections();await new Promise(resolve => server.close(resolve));privacy.close();fs.rmSync(home, { recursive: true, force: true }); });
  const result = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", stream: false, input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: original }] },
      { type: "function_call", id: "in", call_id: "call_in", name: "tool", arguments: args },
      { type: "function_call_output", call_id: "call_in", output: "done" },
    ] }) });
  assert.equal(result.status, 200);assert.ok(upstreamArgs.includes('"id":9007199254740993'));
  assert.ok(upstreamArgs.includes('"decimal":0.123456789012345678901'));assert.ok(!upstreamArgs.includes(original));
  assert.equal((await result.json()).output[0].arguments, args);
});

test("Messages JSON, streaming and token counting share masking while client credentials remain unchanged", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-privacy-http-")), env = {}, file = userSettingsPath({ home, env });
  fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, '{"privacy_enabled":true}');
  const model = { load: async () => {}, find: async texts => texts.map(() => []), snapshot: () => ({ state: "ready" }), close() {}, busy: () => false };
  const privacy = createLocalPrivacy({ home, env, model }), key = "a".repeat(64), secret = "ghp_" + "b".repeat(36);let calls = 0;
  const server = await startClaudeGateway({ port: 0, apiKey: key, privacy, privacyClient: "claude_app", provider: { id: "m365", models: () => [{ id: "claude-opus-5.5" }], client: {
    messages: async (body, options) => {
      calls++;assert.doesNotMatch(JSON.stringify(body), /ghp_/);const masked = body.messages[0].content;
      if (options.countTokens) return new Response('{"input_tokens":42}', { headers: { "Content-Type": "application/json" } });
      if (!body.stream) return new Response(JSON.stringify({ type: "message", model: body.model, role: "assistant", id: "msg_1", content: [{ type: "text", text: masked }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 3 } }), { headers: { "Content-Type": "application/json" } });
      const events = [{ type: "message_start", message: { id: "msg_2", model: body.model, usage: { input_tokens: 5 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: masked.slice(0, 4) } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: masked.slice(4) } },
        { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" }];
      return new Response(events.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    } } }, record() {} });
  t.after(async () => { server.close();privacy.close();fs.rmSync(home, { recursive: true, force: true }); });
  const request = (suffix = "", stream = false, token = key) => fetch(`http://127.0.0.1:${server.port}/v1/messages${suffix}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-opus-5.5", messages: [{ role: "user", content: secret }], max_tokens: 64, stream }) });
  const json = await request();assert.equal(json.status, 200);assert.equal((await json.json()).content[0].text, secret);
  const streamed = await request("", true), events = (await streamed.text()).split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
  assert.equal(events.filter(value => value.delta?.type === "text_delta").map(value => value.delta.text).join(""), secret);
  assert.deepEqual(await (await request("/count_tokens")).json(), { input_tokens: 42 });
  assert.equal((await request("", false, "wrong")).status, 401);assert.equal(calls, 3);
});

test("Anthropic SDK executes a restored tool call through an isolated privacy gateway", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-privacy-sdk-http-")), env = {}, file = userSettingsPath({ home, env });
  fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, '{"privacy_enabled":true}');
  const model = { load: async () => {}, find: async texts => texts.map(() => []), snapshot: () => ({ state: "ready" }), close() {}, busy: () => false };
  const privacy = createLocalPrivacy({ home, env, model }), key = "d".repeat(64), original = "ghp_" + "e".repeat(36);
  const server = await startClaudeGateway({ port: 0, apiKey: key, privacy, privacyClient: "claude_app", record() {}, provider: {
    id: "m365", models: () => [{ id: "fixture" }], client: { messages: async body => {
      assert.doesNotMatch(JSON.stringify(body), /ghp_/);
      const args = JSON.stringify({ value: body.messages[0].content, flags: [true, 2, null] });
      const events = [
        { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool_fixture", name: "fixture", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args.slice(0, 12) } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args.slice(12) } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    } },
  } });
  t.after(() => { server.close();privacy.close();fs.rmSync(home, { recursive: true, force: true }); });
  const client = new Anthropic({ apiKey: key, baseURL: `http://127.0.0.1:${server.port}`, maxRetries: 0 });
  const message = await client.messages.stream({ model: "fixture", max_tokens: 32, messages: [{ role: "user", content: original }],
    tools: [{ name: "fixture", description: "Synthetic tool", input_schema: { type: "object", properties: { value: { type: "string" } } } }] }).finalMessage();
  const tool = message.content.find(block => block.type === "tool_use");
  assert.equal(tool.name, "fixture");assert.deepEqual(tool.input, { value: original, flags: [true, 2, null] });
});

test("OpenAI SDK receives restored custom tool input through an isolated Responses gateway", async t => {
  const previousUsage = process.env.CCDX_DISABLE_USAGE;process.env.CCDX_DISABLE_USAGE = "1";
  t.after(() => { if (previousUsage === undefined) delete process.env.CCDX_DISABLE_USAGE;else process.env.CCDX_DISABLE_USAGE = previousUsage; });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-privacy-responses-http-")), env = {}, file = userSettingsPath({ home, env });
  fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, '{"privacy_enabled":true}');
  const model = { load: async () => {}, find: async texts => texts.map(() => []), snapshot: () => ({ state: "ready" }), close() {}, busy: () => false };
  const privacy = createLocalPrivacy({ home, env, model }), original = "ghp_" + "f".repeat(36);
  const server = await startAdapter(0, "127.0.0.1", { privacy, env, dashboardOptions: { home, env }, responsesFn: async body => {
    assert.doesNotMatch(JSON.stringify(body), /ghp_/);
    const text = body.input[0].content[0].text;assert.equal(typeof text, "string");
    const input = `*** Begin Patch\n+value=${text}\n*** End Patch\n`;
    const item = { id: "custom_fixture", call_id: "call_fixture", type: "custom_tool_call", name: "fixture", input, status: "completed" };
    const response = { id: "response_fixture", object: "response", model: body.model, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    const at = input.indexOf("{{CCDX_") + 5;
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", input: "" } },
      { type: "response.custom_tool_call_input.delta", item_id: item.id, output_index: 0, delta: input.slice(0, at) },
      { type: "response.custom_tool_call_input.delta", item_id: item.id, output_index: 0, delta: input.slice(at) },
      { type: "response.custom_tool_call_input.done", item_id: item.id, output_index: 0, input },
      { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  } });
  t.after(() => { server.close();privacy.close();fs.rmSync(home, { recursive: true, force: true }); });
  const client = new OpenAI({ apiKey: "synthetic", baseURL: `http://127.0.0.1:${server.address().port}/v1`, maxRetries: 0 });
  const stream = await client.responses.create({ model: "gpt-5.6-sol", input: original, stream: true });
  let input = "";
  for await (const event of stream) if (event.type === "response.custom_tool_call_input.delta") input += event.delta;
  assert.equal(input, `*** Begin Patch\n+value=${original}\n*** End Patch\n`);
});
