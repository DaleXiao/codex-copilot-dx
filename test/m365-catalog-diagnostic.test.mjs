import test from "node:test";
import assert from "node:assert/strict";
import { catalogFailure, m365CatalogDiagnostic, m365CatalogMessage, m365CatalogRead } from "../src/providers/m365-catalog-diagnostic.mjs";

test("catalog failures expose fixed causes and safe evidence without echoing the server body", () => {
  const checkedAt = "2026-10-22T08:00:00.000Z", lastSuccessAt = "2026-10-22T07:00:00.000Z";
  for (const [http, message, expected] of [[401, "secret", "sign_in_rejected"], [403, "Copilot CLI Entra access is not enabled for this user.", "entra_access_disabled"],
    [403, "private user@example.test secret", "access_denied"], [429, "secret", "rate_limited"], [502, "secret", "service_unavailable"], [404, "secret", "catalog_rejected"]]) {
    const result = catalogFailure(new Response(null, { status: http, headers: { "request-id": "service-request_1" } }), JSON.stringify({ error: { message } }), { checkedAt, lastSuccessAt });
    assert.equal(result.cause_code, expected);assert.equal(result.http_status, http);
    assert.equal(result.request_id, "service-request_1");assert.equal(result.checked_at, checkedAt);assert.equal(result.last_success_at, lastSuccessAt);
    assert.doesNotMatch(JSON.stringify(result), /secret|user@example/);assert.ok(m365CatalogMessage(result));
  }
  const result = catalogFailure(new Response(null, { status: 403, headers: { "request-id": "Bearer secret" } }), "<html>private server page</html>");
  assert.equal(result.request_id, null);assert.equal(result.cause_code, "access_denied");
  assert.equal(m365CatalogDiagnostic({ ...result, request_id: "github_pat_synthetic_secret" }).request_id, null);
  for (const value of [null, {}, { ...result, cause_code: "constructor" }, { ...result, http_status: "403" }, { ...result, stage: "inference" }]) assert.equal(m365CatalogDiagnostic(value), null);
});

test("successful directory receipts contain only bounded cache and network facts", () => {
  const value = { source: "network", checked_at: "2026-10-27T08:00:00.000Z", total: 5, claude: 0, gpt: 5, filtered: 0,
    http_status: 200, request_id: "ghp_synthetic_secret", client_correlation_id: "Bearer secret", response_age_seconds: 12, http_revalidation_requested: true,
    token: "secret", body: "private response", account: "private@example.test" };
  const result = m365CatalogRead(value);assert.equal(result.source, "network");assert.equal(result.local_cache_used, false);assert.equal(result.request_id, null);
  assert.equal(result.client_correlation_id, null);assert.equal(result.response_age_seconds, 12);assert.doesNotMatch(JSON.stringify(result), /secret|private/);
  const cached = m365CatalogRead({ ...value, source: "cache" });assert.equal(cached.local_cache_used, true);assert.equal(cached.http_status, null);assert.equal(cached.http_revalidation_requested, false);
  for (const bad of [{ ...value, checked_at: "invalid" }, { ...value, total: 6 }, { ...value, claude: -1 }, { ...value, gpt: 1001 }]) assert.equal(m365CatalogRead(bad), null);
});
