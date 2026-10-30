import assert from "node:assert/strict";
import test from "node:test";
import { redactDiagnosticText, boundedDiagnosticText } from "../src/diagnostic-text.mjs";
import { responseFailureDetails, formatResponseFailureLog } from "../src/response-failures.mjs";
import { operationErrorDetails } from "../src/operation-error.mjs";

test("oversized diagnostic copies are omitted before scanning while original errors remain intact", () => {
  const message = "synthetic private diagnostic ".repeat(50000), event = { error: { code: "fixture_error", message } };
  const result = responseFailureDetails(event, "response.failed", { model: "fixture" });
  assert.equal(result.message, "Diagnostic text omitted (too long)");
  assert.equal(event.error.message, message);assert.equal(result.code, "fixture_error");
  assert.equal(operationErrorDetails({ code: "ECONNRESET", message }).message, result.message);
  assert.equal(responseFailureDetails({ error: { code: message, message: "short" } }).code, "unknown");
});

test("bounded diagnostic text keeps Unicode boundaries and normal credential cleanup", () => {
  const text = "x ".repeat(249) + "😀 end";
  const result = boundedDiagnosticText(text, { maxChars: 499 });
  assert.equal(result.length, 498);assert.ok(!/[\uD800-\uDBFF]$/.test(result));
  assert.equal(boundedDiagnosticText("汉".repeat(60), { maxChars: 50 }).length, 50);
  const secret = "ghu_syntheticOnly";
  const safe = boundedDiagnosticText(`HTTP 401 \u001b[31mBearer ${secret}\u001b[0m`);
  assert.match(safe, /HTTP 401/);assert.ok(!safe.includes(secret));assert.ok(!safe.includes("\u001b"));
});

test("diagnostics redact Basic payloads and URL userinfo without hiding the target or error", () => {
  const payload = Buffer.from("synthetic-user:synthetic-password").toString("base64");
  for (const scheme of ["Basic", "basic", "BASIC", "Bearer"]) {
    const result = redactDiagnosticText(`HTTP 401 Authorization: ${scheme} ${payload}, retry denied`);
    assert.ok(!result.includes(payload));
    assert.match(result, /HTTP 401.*retry denied/);
  }
  assert.doesNotMatch(redactDiagnosticText("Authorization: Basic opaque-private-value"), /opaque-private-value/);
  for (const url of [
    "https://synthetic-user:synthetic-password@example.test:443/path?trace=1",
    "http://synthetic-user@example.test/path", "wss://user%3Apassword@example.test/path",
  ]) {
    const result = redactDiagnosticText(`upstream rejected ${url} (HTTP 403)`);
    assert.match(result, /:\/\/\[redacted\]@example\.test/);
    assert.doesNotMatch(result, /synthetic-user|synthetic-password|user%3Apassword/);
    assert.match(result, /HTTP 403/);
  }
});

test("JSON quoting and escaped values do not expose the rest of a sensitive field", () => {
  for (const value of ['private-value', 'private-one"private-two', 'private-one\\private-two']) {
    const result = redactDiagnosticText(JSON.stringify({ access_token: value, code: "quota_exceeded", status: 429 }));
    assert.doesNotMatch(result, /private-/);
    assert.match(result, /quota_exceeded/);
    assert.match(result, /429/);
  }
  const payload = Buffer.from("synthetic-user:synthetic-password").toString("base64");
  const nested = JSON.stringify(JSON.stringify({ authorization: `Basic ${payload}` }));
  assert.ok(!redactDiagnosticText(nested).includes(payload));
});

test("failure recording and copied/logged fields use the same credential protections", () => {
  const payload = Buffer.from("synthetic-user:synthetic-password").toString("base64");
  const details = responseFailureDetails({ response: {
    id: "resp_safe", model: "gpt-6-astra", error: { code: "permission_denied",
      message: `HTTP 403 Basic ${payload} at https://synthetic-user:synthetic-password@example.test/path` },
  } });
  for (const value of [JSON.stringify(details), formatResponseFailureLog(details)]) {
    assert.ok(!value.includes(payload));
    assert.doesNotMatch(value, /synthetic-user|synthetic-password/);
    assert.match(value, /permission_denied/);
    assert.match(value, /example\.test/);
  }
});

test("ordinary diagnostics, model identities and URLs without credentials stay unchanged", () => {
  for (const value of ["gpt-6.1-sol-fast", "dingxiao_microsoft", "HTTP 429 quota_exceeded retry_after=30",
    "https://example.test/path?trace=1", "http://[::1]:2026/v1/responses", "literal {input} and {constructor}",
    "basic authentication failed", "Basic validation required"]) {
    assert.equal(redactDiagnosticText(value), value);
  }
  const text = `error ${"x".repeat(128 * 1024)}`;
  assert.match(redactDiagnosticText(text), /^error /);
});

test("long scheme-like prose does not cause unbounded scheme backtracking", () => {
  const text = `${"a-".repeat(64 * 1024)} HTTP 429`;
  assert.equal(redactDiagnosticText(text), "[redacted]- HTTP 429");
});
