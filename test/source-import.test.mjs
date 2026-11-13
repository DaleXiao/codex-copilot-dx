import test from "node:test";
import assert from "node:assert/strict";
import { previewSourceImport } from "../src/source-import.mjs";

test("explicit native provider formats yield metadata drafts without keys or permissions", () => {
  const key = "fixture-private-value";
  const cc = previewSourceImport({ name: "Example", settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://api.example.test", ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: "foreign-route", permissions: { bypass: true } } } });
  assert.equal(cc.drafts[0].config.endpoints.messages, "https://api.example.test/v1/messages");assert.equal(cc.drafts[0].config.models.length, 0);
  const magpie = previewSourceImport({ providers: [{ name: "Relay", anthropic: "https://api.example.test", responses: "https://api.example.test/v1", key, models: ["foreign-id"], keys: [{ key }], routing: "smart" }], groups: [{ models: ["foreign-id"] }] });
  assert.equal(magpie.drafts[0].config.endpoints.responses, "https://api.example.test/v1/responses");assert.ok(magpie.drafts[0].warnings.includes("account_routing_omitted"));
  for (const result of [cc, magpie]) { assert.equal(result.saved, false);assert.deepEqual(result.drafts[0].allowed, []);assert.doesNotMatch(JSON.stringify(result), /fixture-private-value|permissions|foreign-route/); }
});
test("CCDX imports keep explicit model metadata and preview conflicts, dropping stale evidence", () => {
  const config = { name: "Relay", base_url: "https://api.example.test/v1", auth_header: "bearer", key_env: "EXAMPLE_KEY", endpoints: { responses: "https://api.example.test/v1/responses" }, models: [{ id: "kimi", protocols: ["responses"], metadata: { values: { context_window: 100 }, deployment: "old" }, capabilities: { max_tool_definitions: 64 } }] };
  const result = previewSourceImport({ config, allowed: ["codex"] }, [{ name: "Relay", base_url: config.base_url }]);
  assert.deepEqual(result.drafts[0].allowed, []);assert.deepEqual(result.drafts[0].requested_access, ["codex"]);
  assert.equal(result.drafts[0].config.models[0].metadata, undefined);assert.ok(result.drafts[0].warnings.includes("name_exists"));
  assert.throws(() => previewSourceImport({ config: { ...config, models: [{ id: "ccdx/model-1", protocols: ["responses"] }] } }), /route_invalid/);
});
test("invalid URLs, mismatched origins and executable settings are not accepted as API metadata", () => {
  for (const base of ["http://localhost", "https://user:password@api.example.test", "https://api.example.test?key=secret"]) assert.throws(() => previewSourceImport({ name: "X", settingsConfig: { env: { ANTHROPIC_BASE_URL: base } } }));
  assert.throws(() => previewSourceImport({ providers: [{ name: "X", anthropic: "https://one.test", responses: "https://two.test/v1" }] }));
  assert.throws(() => previewSourceImport({ providers: { example: { name: "X", settingsConfig: { command: "execute" } } } }));
});
