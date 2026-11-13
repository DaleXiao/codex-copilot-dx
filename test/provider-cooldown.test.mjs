import test from "node:test";
import assert from "node:assert/strict";
import { createProviderCooldown, confirmedNetworkFailure } from "../src/provider-cooldown.mjs";

test("two failures cool only the selected deployment; one real request recovers it", () => {
  let now = 0;const a = createProviderCooldown({ now: () => now }), b = createProviderCooldown({ now: () => now });
  a.acquire().finish({ failed: true });assert.equal(a.snapshot().state, "ready");
  a.acquire().finish({ failed: true });assert.equal(a.snapshot().state, "cooling");
  assert.throws(() => a.acquire(), error => error.code === "ccdx_api_cooling_down" && /connection failures.*Retry shortly/.test(error.message));
  b.acquire().finish();now = 5000;
  const recovery = a.acquire();assert.equal(a.snapshot().state, "recovering");assert.throws(() => a.acquire());
  recovery.finish();assert.deepEqual(a.snapshot(), { state: "ready", failures: 0, retry_after_ms: 0 });
});
test("cancellation does not count as an outage; recovery cancellation leaves the next request available", () => {
  let now = 0;const cooldown = createProviderCooldown({ now: () => now });
  cooldown.acquire().finish({ failed: true, cancelled: true });assert.equal(cooldown.snapshot().failures, 0);
  cooldown.acquire().finish({ failed: true });cooldown.acquire().finish({ failed: true, retryAfterMs: 90000 });
  assert.equal(cooldown.snapshot().retry_after_ms, 30000);now = 30000;
  cooldown.acquire().finish({ cancelled: true });cooldown.acquire().finish();assert.equal(cooldown.snapshot().failures, 0);
  assert.equal(confirmedNetworkFailure({ cause: { code: "ECONNREFUSED" } }), true);
  for (const code of ["AbortError", "ccdx_api_http_400", "ccdx_api_http_401", "ccdx_api_http_404", "CERT_HAS_EXPIRED"]) assert.equal(confirmedNetworkFailure({ code }), false);
});
