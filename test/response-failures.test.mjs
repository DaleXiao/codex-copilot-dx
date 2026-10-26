import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createResponseFailureDiagnostics,
  formatResponseFailureLog,
  responseFailureDetails,
  buildHttpFailureDetails,
  upstreamErrorEvidence,
  requestOptionsEvidence,
  createHttpFailureDiagnostics,
} from "../src/response-failures.mjs";

test("HTTP evidence is bounded technical metadata; arbitrary prose requires explicit opt-in", () => {
  const body = JSON.stringify({ error: { code: "unsupported_value", type: "invalid_request_error", param: "reasoning.effort", message: 'Rejected. prompt="private prompt" Bearer secret-token' } });
  assert.deepEqual(upstreamErrorEvidence(body), { error_body: "structured", code: "unsupported_value", error_type: "invalid_request_error", parameter: "reasoning.effort" });
  assert.doesNotMatch(JSON.stringify(upstreamErrorEvidence(body, { includeMessage: true })), /private prompt|secret-token/);
  assert.deepEqual(upstreamErrorEvidence("  "), { error_body: "empty" });
  assert.deepEqual(upstreamErrorEvidence("private html response"), { error_body: "unstructured" });
  assert.doesNotMatch(JSON.stringify(upstreamErrorEvidence('error: prompt="private html response"', { includeMessage: true })), /private html response/);
  for (const param of ['prompt=secret', 'input[0].content[1].text value', 'cookie', 'x'.repeat(300)]) {
    assert.equal(upstreamErrorEvidence(JSON.stringify({ error: { param } })).parameter, undefined);
  }
  const options = requestOptionsEvidence({ reasoning: { effort: "low", summary: "private" }, text: { format: { type: "json_schema", schema: { private: "secret" } } }, input: ["private prompt"], tools: [{ name: "secret" }], max_output_tokens: 128 });
  assert.deepEqual(options, { reasoning_effort: "low", output_format: "json_schema", max_output_tokens: 128, tools: 1, input_items: 1 });
  assert.doesNotMatch(JSON.stringify(options), /private|secret/);
});

test("inference errors survive route and MCP method noise without unbounded retention", () => {
  const diagnostics = createHttpFailureDiagnostics({ maxEntries: 2 });
  diagnostics.record({ route: "responses", http_status: 400, code: "invalid_parameter" });
  for (let i = 0; i < 30; i++) {
    diagnostics.record({ route: "not_found", http_status: 404 });
    diagnostics.record({ route: "image_mcp", http_status: 405 });
  }
  const result = diagnostics.snapshot();
  assert.equal(result.total, 61); assert.equal(result.recent.length, 2);
  assert.equal(result.actionable_recent[0].code, "invalid_parameter");
  assert.equal(result.protocol_recent.length, 8);
  assert.deepEqual(result.by_category, { inference: 1, capability: 0, protocol: 30, route: 30, other: 0 });
  result.actionable_recent[0].code = "changed";
  assert.equal(diagnostics.snapshot().actionable_recent[0].code, "invalid_parameter");
});

test("response failure diagnostics retain a bounded, redacted runtime history", () => {
  const diagnostics = createResponseFailureDiagnostics({ maxEntries: 2, now: () => "2026-09-14T00:00:00.000Z" });
  const details = responseFailureDetails({
    type: "response.failed",
    response: {
      id: "resp_failure",
      model: "gpt-5.6-sol",
      error: {
        code: "invalid_request_body",
        message: `Encrypted content ${"A".repeat(120)} could not be decrypted.\nRetry.`,
      },
    },
  }, "response.failed", {
    headers: new Headers({ "X-Request-Id": "request-123" }),
    retried: true,
    retryPolicy: "encrypted-replay-rejected",
  });

  diagnostics.record(details);
  diagnostics.record({ ...details, code: "second" });
  diagnostics.record({ ...details, code: "third", retried: false });
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.total, 3);
  assert.equal(snapshot.retried, 2);
  assert.deepEqual(snapshot.recent.map(({ code }) => code), ["second", "third"]);
  assert.doesNotMatch(details.message, /A{24}|\n/);
  assert.match(details.message, /\[redacted\]/);
  assert.equal(details.upstream_request_id, "request-123");
  assert.match(formatResponseFailureLog(details), /retry=encrypted-replay-rejected/);
});

test("HTTP diagnostics retain status and safe codes but no original error body", () => {
  for (const code of ["quota_exceeded", "prompt=private input", undefined, { toString: "hostile code" }]) {
    const details = buildHttpFailureDetails({ statusCode: 429, route: "responses", requestId: "local-id", model: "gpt-6.1-sol",
      code, origin: "upstream_http", headers: new Headers({ "x-request-id": "upstream-id" }) });
    assert.equal(details.http_status, 429);assert.equal(details.route, "responses");assert.equal(details.request_id, "local-id");
    assert.equal(details.upstream_request_id, "upstream-id");assert.equal(details.origin, "upstream_http");
    assert.equal(details.code, code === "quota_exceeded" ? code : "http_429");
    assert.doesNotMatch(JSON.stringify(details), /private input/);
  }
});

test("failure diagnostics redact short credential forms and labelled upstream input echoes", () => {
  for (const message of [
    'Bearer fixture-private-token', 'api_key="fixture-private-key"',
    `ghp_${'A'.repeat(36)}`, 'prompt="fixture-private-prompt"', 'input=fixture-private-input',
  ]) {
    const details = responseFailureDetails({ type: "response.failed", response: {
      id: "resp_fixture", error: { code: "invalid_request", message },
    } });
    assert.match(details.message, /redacted/);
    assert.doesNotMatch(JSON.stringify(details), /fixture-private|ghp_A/);
    assert.equal(details.code, "invalid_request");
    assert.equal(details.response_id, "resp_fixture");
  }
});

test('count endpoint absence is a separate capability notice while access and server failures stay actionable',()=>{
 const d=createHttpFailureDiagnostics();
 for(const status of [404,405,401,403,429,503])d.record(buildHttpFailureDetails({statusCode:status,route:'messages_count_tokens',model:'example-model',origin:'upstream_http'}));
 const s=d.snapshot();assert.equal(s.by_category.inference,0);assert.equal(s.by_category.capability,6);assert.equal(s.capability_recent.length,6);
 assert.deepEqual(s.actionable_recent.map(x=>x.http_status),[401,403,429,503]);
});
