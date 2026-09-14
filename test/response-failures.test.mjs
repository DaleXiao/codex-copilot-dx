import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createResponseFailureDiagnostics,
  formatResponseFailureLog,
  responseFailureDetails,
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
