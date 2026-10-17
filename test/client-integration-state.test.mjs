import { test } from "node:test";
import assert from "node:assert/strict";
import { createPredictionState } from "../src/native-prediction-state.mjs";
import { errorEvidenceText, operationErrorDetails } from "../src/operation-error.mjs";

test("prediction diagnostics distinguish preference, bridge, observed routing and unknown UI", () => {
  const state = createPredictionState({ now: () => "fixture" });
  assert.equal(state.snapshot().candidate, "unknown");
  state.configure(true); state.running({ source: "HTTPS_PROXY", type: "http" });
  assert.equal(state.snapshot().client_route, "unknown");
  state.event({ type: "configuration", route: "bootstrap", status: 200, changed: true });
  state.event({ type: "configuration", route: "prediction", status: 200, official: true });
  const result = state.snapshot();
  assert.equal(result.client_route, "observed"); assert.equal(result.candidate, "unknown");
  assert.equal(result.counters.modified, 1); assert.equal(result.configuration.prediction.official, true);
  result.configuration.bootstrap.status = 500;
  assert.equal(state.snapshot().configuration.bootstrap.status, 200);
  state.stopped(); assert.equal(state.snapshot().bridge, "stopped");
});

test("failure events have bounded counters and redacted error details", () => {
  const state = createPredictionState();
  state.event({ type: "tls_error" }); state.event({ type: "upstream_error" });
  state.unavailable(Object.assign(new Error("Proxy refused https://alice:secret@proxy.test"), { code: "proxy_config" }));
  const result = state.snapshot();
  assert.equal(result.error.source, "proxy"); assert.ok(!result.reason.includes("secret"));
  assert.equal(result.counters.tls_errors, 1); assert.equal(result.counters.upstream_errors, 1);
  assert.equal(operationErrorDetails({ code: "ENOTFOUND" }).source, "network");
});

test("escaped JSON errors provide decoded evidence without rewriting their response", () => {
  const raw = '{"error":{"message":"\\u7528\\u91cf\\u5df2\\u7528\\u5b8c"}}';
  assert.match(errorEvidenceText(raw), /用量已用完/); assert.ok(errorEvidenceText(raw).startsWith(raw));
  for (const value of ["ordinary error", "{bad\\u", "x".repeat(17000) + "\\u1234"]) assert.equal(errorEvidenceText(value), value);
});

test("error facts separate cancellation, timeout, access denial and unknown aborts", () => {
  for (const [error, options, source, status] of [
    [{ name: "AbortError" }, { reason: "client_closed" }, "cancelled", null],
    [{ name: "AbortError" }, { reason: "upstream_timeout" }, "timeout", null],
    [{ name: "AbortError" }, {}, "aborted", null],
    [{ code: "HTTP_403", statusCode: 403 }, {}, "access_denied", 403],
    [{ code: "HTTP_401", status: 401 }, {}, "authentication", 401],
    [{ code: "ECONNRESET" }, {}, "network", null],
  ]) { const detail = operationErrorDetails(error, options);assert.equal(detail.source, source);assert.equal(detail.status, status); }
});
