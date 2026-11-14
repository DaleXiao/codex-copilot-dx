import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAdapterHandler } from "../src/adapter.mjs";
import { createGithubProvider } from "../src/providers/github.mjs";
import { startClaudeGateway } from "../src/claude-gateway.mjs";
import { createContextCompactionService, compactionScope, protectNativeCompactionResult, resolveGatewayCompactionItem } from "../src/context-compaction.mjs";
import { maskPrivacyRequest, privacySessionMappings, restorePrivacyMappings } from "../src/privacy-transform.mjs";
import { createLocalPrivacy } from "../src/local-privacy.mjs";
import { clearResponseHistoryForTests } from "../src/response-history.mjs";
import { userSettingsPath } from "../src/user-settings.mjs";
import { createStreamPerformanceMetrics } from "../src/stream-performance.mjs";

const key = "a".repeat(64), model = "gateway-model";
const event = value => new Response("data: " + JSON.stringify(value) + "\n\n", { headers: { "content-type": "text/event-stream" } });
const message = text => ({ id: "msg_test", type: "message", model, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 0 } });
async function adapter(t, client, options = {}) {
  const provider = createGithubProvider({ client, profileId: "test-owner" }), records = [], compaction = options.compaction || createContextCompactionService({ recordUsageFn: value => records.push(value) });
  const handler = createAdapterHandler({ codexClient: client, provider, compaction, compactionKey: () => key,
    modelRegistry: { models: { data: [{ id: model, capabilities: { limits: { max_context_window_tokens: 16000 } } }] } }, ...options });
  const server = http.createServer(handler);await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections();await new Promise(resolve => server.close(resolve));handler.cleanup?.();clearResponseHistoryForTests(); });
  const call = (url, body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { call, provider, records, compaction };
}

test("Responses JSON and SSE tool metadata stops waiting on the matching next input", async t => {
  for (const stream of [false, true]) {
    const metrics = createStreamPerformanceMetrics();let first = true;
    const client = { getCachedModelEndpoints: () => ["/responses"], async responses() {
      const output = first ? [{ type: "function_call", id: "item_one", call_id: "call_one", name: "read_file", arguments: "{}", status: "completed" }] : [];
      first = false;const response = { id: "observed_response", object: "response", status: "completed", model, output };
      return stream ? event({ type: "response.completed", response }) : Response.json(response);
    } };
    const f = await adapter(t, client, { streamPerformanceMetrics: metrics });
    const headers = { session_id: `tool-session-${stream}`, "x-ccdx-client": "codex-app" };
    const base = { model, stream, tools: [{ type: "function", name: "read_file", parameters: { type: "object", properties: {} } }] };
    const response = await f.call("/v1/responses", { ...base, input: "observe tools" }, headers);assert.equal(response.status, 200);await response.text();
    assert.equal(metrics.snapshot().tool_activity.items[0].state, "waiting");
    const next = await f.call("/v1/responses", { ...base, input: [{ type: "function_call_output", call_id: "call_one", output: "not retained" }] }, headers);
    assert.equal(next.status, 200);await next.text();assert.equal(metrics.snapshot().tool_activity.items[0].state, "returned");
  }
});

test("Codex compact fallback produces resumable local state and expands it before the source", async t => {
  const sent = [];let native = 0;
  const client = { getCachedModelEndpoints: () => ["/responses"], async responsesCompact() { native++;return new Response(null, { status: 404 }); },
    async responses(body) { sent.push(structuredClone(body));return body.stream ? event({ type: "response.completed", response: { id: "summary", status: "completed", model,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "a.mjs verified; b.mjs unresolved" }] }], usage: { input_tokens: 7, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } } } })
      : Response.json({ id: "continued", object: "response", status: "completed", model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "continued" }] }] }); } };
  const f = await adapter(t, client), input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "retain the requirements" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "a.mjs verified; b.mjs unresolved" }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }];
  const response = await f.call("/v1/responses/compact", { model, input, max_output_tokens: 1024, reasoning: { effort: "high" } });assert.equal(response.status, 200);
  const compacted = await response.json();assert.ok(compacted.output.some(item => item.type === "compaction" && item.encrypted_content.startsWith("ccdx-compaction-v1:")));
  assert.equal(native, 1);assert.equal(f.records.length, 1);assert.equal(f.records[0].purpose, "compaction");assert.equal(sent[0].reasoning.effort, "high");
  const continuation = await f.call("/v1/responses", { model, input: [...compacted.output, { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }], stream: false });
  assert.equal(continuation.status, 200);await continuation.text();assert.doesNotMatch(JSON.stringify(sent.at(-1)), /ccdx-compaction-v1:/);
  assert.match(JSON.stringify(sent.at(-1)), /a.mjs verified/);assert.match(JSON.stringify(sent.at(-1)), /retain the requirements/);
});

test("Claude compaction is classified structurally and all recovery calls stay inside masking", async t => {
  const sent = [], records = [];let main = 0;
  const provider = { id: "api_test", configuredModels: true, profileId: () => "owner", models: () => [{ id: model, capability: { values: { context_window: 16000 } } }], client: {
    async messages(body, options) {
      sent.push(structuredClone(body));
      if (body.system) return Response.json(message("condensed historical facts"));
      if (main++ === 0) { options.onUpstreamErrorHeaders?.(400);return Response.json({ error: { type: "invalid_request_error", message: "Range of input length should be [1, 16000]" } }, { status: 400 }); }
      return Response.json(message("<summary>completed</summary>"));
    },
  } };
  const privacy = { wrap: fn => async (body, options) => fn(JSON.parse(JSON.stringify(body).replaceAll("private-value", "masked-value")), options) };
  const compaction = createContextCompactionService({ recordUsageFn: value => records.push(value) });
  const gateway = await startClaudeGateway({ provider, compaction, privacy, apiKey: key, port: 0, record() {} });t.after(() => gateway.close());
  const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "x-claude-code-request-class": "compaction" },
    body: JSON.stringify({ model, max_tokens: 1024, output_config: { effort: "high" }, thinking: { type: "adaptive" }, messages: [
      { role: "user", content: "keep requirements" }, { role: "assistant", content: "private-value: verified result" }, { role: "user", content: "compact" }] }) });
  assert.equal(response.status, 200);assert.match(await response.text(), /completed/);assert.equal(main, 2);assert.equal(sent.length, 3);
  assert.ok(sent.every(body => !JSON.stringify(body).includes("private-value")));assert.ok(sent.every(body => body.output_config.effort === "high"));
  assert.equal(records.length, 1);assert.equal(gateway.snapshot().performance.recent_requests.at(-1).purpose, "compaction");
});

test("native opaque state retains private mappings across requests without exposing them upstream", async t => {
  const privateValue = "sk-" + "x".repeat(28), session = await maskPrivacyRequest({ input: privateValue }, { protocol: "responses", secret: Buffer.alloc(32, 1), find: async texts => texts.map(() => []) });
  const mappings = privacySessionMappings(session);assert.ok(mappings.length);const placeholder = mappings[0][0];
  const client = { getCachedModelEndpoints: () => ["/responses"], async responses(body) {
    assert.equal(body.input.find(item => item.type === "compaction").encrypted_content, "vendor-opaque");assert.ok(!JSON.stringify(body).includes(privateValue));
    return Response.json({ id: "restored", object: "response", status: "completed", model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: placeholder }] }] });
  } };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-compaction-private-")), privacy = createLocalPrivacy({ home, env: {} });t.after(() => { privacy.close();session.release();fs.rmSync(home, { recursive: true, force: true }); });
  const f = await adapter(t, client, { privacy, dashboardOptions: { home }, env: {} });
  const protectedResult = protectNativeCompactionResult({ output: [{ type: "compaction", encrypted_content: "vendor-opaque" }] }, { key, scope: compactionScope(f.provider, "codex", "responses"), mappings });
  assert.ok(!JSON.stringify(protectedResult).includes(privateValue));
  const altered = { ...protectedResult.output[0], encrypted_content: protectedResult.output[0].encrypted_content.replace("vendor-opaque", "another-source-state") };
  assert.throws(() => resolveGatewayCompactionItem(altered, { key, scope: compactionScope(f.provider, "codex", "responses") }), { code: "ccdx_compaction_state_invalid" });
  const response = await f.call("/v1/responses", { model, input: [...protectedResult.output, { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }], stream: false });
  assert.equal(response.status, 200);assert.ok((await response.text()).includes(privateValue));
  const restored = await restorePrivacyMappings(mappings);assert.equal(restored.restoreText(placeholder), privateValue);restored.release();
});

test("inline native compression uses the same protected state in item and terminal events", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-compaction-stream-private-")), file = userSettingsPath({ home, env: {} });
  fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, JSON.stringify({ privacy_enabled: true }));
  const privacy = createLocalPrivacy({ home, env: {}, model: { snapshot: () => ({ state: "ready" }), load: async () => {}, find: async texts => texts.map(() => []), close() {}, stop() {}, busy: () => false } });
  t.after(() => { privacy.close();fs.rmSync(home, { recursive: true, force: true }); });
  const secret = "sk-" + "z".repeat(28), vendor = "source-native-opaque";let placeholder;
  const client = { getCachedModelEndpoints: () => ["/responses"], async responses(body) {
    assert.ok(!JSON.stringify(body).includes(secret));
    if (body.input.at(-1)?.type === "compaction_trigger") {
      placeholder = JSON.stringify(body).match(/\{\{CCDX_[a-f0-9]{24}\}\}/)?.[0];assert.ok(placeholder);
      const item = { type: "compaction", id: "cmp_source", encrypted_content: vendor }, response = { id: "native_compacted", object: "response", status: "completed", model, output: [item] };
      return new Response([{ type: "response.created", response: { ...response, output: [], status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, encrypted_content: "" } }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }]
        .map(event => "data: " + JSON.stringify(event) + "\n\n").join(""), { headers: { "content-type": "text/event-stream" } });
    }
    assert.equal(body.input.find(item => item.type === "compaction").encrypted_content, vendor);
    return Response.json({ id: "native_followup", object: "response", status: "completed", model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: placeholder }] }] });
  } };
  const f = await adapter(t, client, { privacy, env: {}, dashboardOptions: { home } });
  const response = await f.call("/v1/responses", { model, stream: true, input: [{ type: "message", role: "user", content: "keep requirements" },
    { type: "message", role: "assistant", content: secret }, { type: "message", role: "user", content: "compact" }, { type: "compaction_trigger" }] });
  assert.equal(response.status, 200);const wire = await response.text(), events = wire.split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  const item = events.find(event => event.type === "response.output_item.done").item, terminal = events.find(event => event.type === "response.completed").response;
  assert.ok(item.encrypted_content.startsWith("ccdx-native-compaction-v1:"));assert.equal(terminal.output[0].encrypted_content, item.encrypted_content);assert.ok(!wire.includes(secret));
  const continued = await f.call("/v1/responses", { model, stream: false, input: [...terminal.output, { type: "message", role: "user", content: "continue" }] });
  assert.equal(continued.status, 200);assert.ok((await continued.text()).includes(secret));
});
