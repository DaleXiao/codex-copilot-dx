import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createResponseFailureDiagnostics,
  formatResponseFailureLog,
  responseFailureDetails,
  buildHttpFailureDetails,
} from "../src/response-failures.mjs";

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
