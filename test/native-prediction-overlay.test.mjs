import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NATIVE_PREDICTION_GATE,
  applyNativePredictionOverlay,
  classifyNativePredictionPath,
  normalizeStatsigRequest,
} from "../src/native-prediction-overlay.mjs";

const routes = {
  bootstrap: { hostname: "chatgpt.com", pathname: "/backend-api/wham/statsig/bootstrap" },
  config: { hostname: "chatgpt.com", pathname: "/backend-api/wham/predictions/config" },
  refresh: { hostname: "ab.chatgpt.com", pathname: "/v1/initialize" },
};
function statsig(extra = {}) {
  return {
    has_updates: true,
    feature_gates: {
      [NATIVE_PREDICTION_GATE]: { name: NATIVE_PREDICTION_GATE, value: false, rule_id: "upstream", secondary_exposures: [] },
      other: { value: false, rule_id: "unchanged" },
    },
    dynamic_configs: { other: { value: { mode: "unchanged" } } },
    user: { userID: "test-user", customIDs: { accountId: "test-account" } },
    time: 123,
    full_checksum: "upstream-checksum",
    ...extra,
  };
}
function apply(kind, value, options = {}) {
  return applyNativePredictionOverlay({ ...routes[kind], statusCode: 200, body: Buffer.from(JSON.stringify(value)), enabled: true, ...options });
}

test("route matching allows only the exact three configuration endpoints", () => {
  for (const [kind, route] of Object.entries(routes)) assert.equal(classifyNativePredictionPath(route), kind);
  assert.equal(classifyNativePredictionPath({ ...routes.config, hostname: "CHATGPT.COM" }), "config");
  for (const route of [
    { ...routes.config, hostname: "chatgpt.com.example.test" },
    { ...routes.config, hostname: "other.chatgpt.com" },
    { ...routes.config, hostname: "chatgpt.com:443" },
    { ...routes.config, pathname: "/backend-api/wham/predictions/config/" },
    { ...routes.refresh, pathname: "/v1/rgstr" },
    { ...routes.refresh, hostname: "chatgpt.com" },
    {},
  ]) assert.equal(classifyNativePredictionPath(route), null);
});

test("disabled mode and unrelated responses retain exact input bytes", () => {
  const body = Buffer.from(' { "is_enabled": false, "prompt": "keep" }\n');
  for (const options of [
    { ...routes.config },
    { ...routes.config, enabled: false },
    { hostname: "chatgpt.com", pathname: "/backend-api/accounts/check", enabled: true },
  ]) {
    const result = applyNativePredictionOverlay({ statusCode: 200, body, ...options });
    assert.equal(result.body, body);assert.equal(result.changed, false);assert.equal(result.official, false);
  }
});

test("official enabled prediction configuration is byte-identical and marked official", () => {
  const body = Buffer.from(' { "is_enabled": true, "prompt": "official prompt", "future": [1, 2] }\n');
  const result = apply("config", null, { body });
  assert.equal(result.body, body);assert.equal(result.changed, false);assert.equal(result.official, true);
});

test("disabled upstream prediction configuration retains every field except enabled", () => {
  const original = { is_enabled: false, prompt: "Keep this upstream prompt", prompt_version: "upstream-v2", prediction_reasoning_effort: "medium", unsupported_models: ["a"], future: { retain: true } };
  const result = apply("config", original);
  assert.deepEqual(JSON.parse(result.body), { ...original, is_enabled: true });
  assert.equal(result.changed, true);assert.equal(result.official, false);assert.equal(result.statusCode, 200);
  assert.equal(original.is_enabled, false);
});

test("missing configuration gets a local low-effort JSON suggestion prompt only on 404", () => {
  const result = apply("config", { detail: "Not Found" }, { statusCode: 404 });
  const config = JSON.parse(result.body);
  assert.equal(result.statusCode, 200);assert.equal(result.changed, true);assert.equal(result.official, false);
  assert.equal(config.is_enabled, true);assert.equal(config.prediction_reasoning_effort, "low");
  assert.equal(config.prompt_version, "ccdx-native-prediction-v1");
  assert.match(config.prompt, /user's perspective/);assert.match(config.prompt, /\{"suggestion":/);
  assert.match(config.prompt, /consent, or permission/);
  assert.deepEqual(Object.keys(config).sort(), ["is_enabled", "prediction_reasoning_effort", "prompt", "prompt_version"]);
  assert.equal(apply("config", null, { statusCode: 404, enabled: false }).statusCode, 404);
  assert.equal(apply("bootstrap", null, { statusCode: 404 }).statusCode, 404);
});

test("upstream auth, quota and server errors are unchanged", () => {
  for (const kind of Object.keys(routes)) for (const statusCode of [201, 204, 301, 400, 401, 403, 429, 500, 503]) {
    const body = Buffer.from('{"error":{"message":"preserve upstream"}}');
    const result = apply(kind, null, { body, statusCode });
    assert.equal(result.statusCode, statusCode);assert.equal(result.body, body);assert.equal(result.changed, false);
  }
});

test("malformed and unrecognized prediction configuration is unchanged", () => {
  for (const body of ["not json", "[]", "null", "{}", '{"is_enabled":"false"}', '{"is_enabled":false}', '{"is_enabled":false,"prompt":""}', '{"is_enabled":false,"prompt":42}', undefined]) {
    const result = apply("config", null, { body });
    assert.equal(result.body, body);assert.equal(result.changed, false);
  }
});

test("bootstrap changes only the prediction gate and keeps identity and all other config", () => {
  for (const stringPayload of [false, true]) {
    const payload = statsig(), original = { statsigPayload: stringPayload ? JSON.stringify(payload) : payload, account: { tier: "fixture" }, other: [1, 2] };
    const result = apply("bootstrap", original), decoded = JSON.parse(result.body);
    const expected = structuredClone(payload);expected.feature_gates[NATIVE_PREDICTION_GATE].value = true;
    assert.deepEqual(decoded, { ...original, statsigPayload: stringPayload ? JSON.stringify(expected) : expected });
    assert.equal(payload.feature_gates[NATIVE_PREDICTION_GATE].value, false);
    assert.equal(result.changed, true);assert.equal(result.official, false);
  }
});

test("full and live Statsig responses alter only the prediction gate value", () => {
  for (const extra of [{}, { response_mode: "full", is_delta: false }, { response_mode: "live_overlay", live_entity_names: { feature_gates: [NATIVE_PREDICTION_GATE], dynamic_configs: [], experiments: [], layer_configs: [] } }]) {
    const original = statsig(extra), expected = structuredClone(original);
    expected.feature_gates[NATIVE_PREDICTION_GATE].value = true;
    const result = apply("refresh", original);
    assert.deepEqual(JSON.parse(result.body), expected);assert.equal(result.changed, true);
    assert.equal(original.feature_gates[NATIVE_PREDICTION_GATE].value, false);
  }
});

test("already-enabled gates and unknown Statsig shapes are unchanged", () => {
  const enabled = statsig();enabled.feature_gates[NATIVE_PREDICTION_GATE].value = true;
  const values = [enabled, statsig({ has_updates: false }), statsig({ is_delta: true }), statsig({ is_delta: "false" }), statsig({ response_mode: "delta" }), statsig({ response_mode: "future" }), statsig({ feature_gates: [] }), statsig({ feature_gates: { [NATIVE_PREDICTION_GATE]: { value: "false" } } }), {}];
  for (const value of values) for (const kind of ["refresh", "bootstrap"]) {
    const body = Buffer.from(JSON.stringify(kind === "bootstrap" ? { statsigPayload: value } : value));
    const result = apply(kind, null, { body });
    assert.equal(result.body, body);assert.equal(result.changed, false);
  }
  for (const statsigPayload of [null, "malformed", "[]"]) assert.equal(apply("bootstrap", { statsigPayload }).changed, false);
});

test("a known full schema without the prediction entry gets only that local entry", () => {
  for (const live of [false, true]) {
    const original = statsig({ feature_gates: { unrelated: { value: false } }, hash_used: "djb2",
      ...(live ? { response_mode: "live_overlay", live_entity_names: { feature_gates: ["unrelated"], dynamic_configs: [], experiments: [], layer_configs: [] } } : {}) });
    const result = apply("refresh", original);
    assert.equal(result.changed, true);
    const value = JSON.parse(result.body);
    assert.equal(value.feature_gates[NATIVE_PREDICTION_GATE].value, true);
    assert.equal(value.feature_gates[NATIVE_PREDICTION_GATE].rule_id, "ccdx-local-compatibility");
    delete value.feature_gates[NATIVE_PREDICTION_GATE];
    if (live) value.live_entity_names.feature_gates.pop();
    assert.deepEqual(value, original);
  }
});

test("existing hashed gate is changed in place without adding a duplicate", () => {
  let hash = 0;
  for (const char of NATIVE_PREDICTION_GATE) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  const key = String(hash >>> 0);
  const original = statsig({ feature_gates: { [key]: { value: false, rule_id: "keep" } } });
  const value = JSON.parse(apply("refresh", original).body);
  assert.deepEqual(value.feature_gates, { [key]: { value: true, rule_id: "keep" } });
});

test("live-overlay protocol does not require the full-response has_updates field", () => {
  const original = { response_mode: "live_overlay", feature_gates: {}, dynamic_configs: {}, layer_configs: {},
    live_entity_names: { feature_gates: [], dynamic_configs: [], experiments: [], layer_configs: [] },
    time: 12345, hash_used: "djb2", derived_fields: {}, full_checksum: "unchanged" };
  const result = apply("refresh", original);
  assert.equal(result.changed, true);
  const value = JSON.parse(result.body);
  assert.equal(value.feature_gates[NATIVE_PREDICTION_GATE].value, true);
  assert.deepEqual(value.live_entity_names.feature_gates, [NATIVE_PREDICTION_GATE]);
  assert.equal(Object.hasOwn(value, "has_updates"), false);
  assert.equal(value.full_checksum, original.full_checksum);
});

test("changed string input remains a string; disabling immediately returns upstream values", () => {
  const body = JSON.stringify(statsig());
  const on = apply("refresh", null, { body });
  assert.equal(typeof on.body, "string");assert.equal(JSON.parse(on.body).feature_gates[NATIVE_PREDICTION_GATE].value, true);
  const off = apply("refresh", null, { body, enabled: false });
  assert.equal(off.body, body);assert.equal(off.changed, false);
});

test("refresh requests ask for complete state without changing identity or response mode", () => {
  for (const responseMode of [undefined, "full", "live_overlay"]) {
    const original = { user: { userID: "fixture-user", customIDs: { accountId: "fixture-account" } }, hash: "djb2", deltasResponseRequested: true, full_checksum: "stale", sinceTime: 123, previousDerivedFields: { keep: true }, ...(responseMode ? { responseMode } : {}) };
    const body = Buffer.from(JSON.stringify(original));
    const result = normalizeStatsigRequest({ ...routes.refresh, body, enabled: true });
    assert.equal(result.changed, true);assert.ok(Buffer.isBuffer(result.body));
    assert.deepEqual(JSON.parse(result.body), { ...original, deltasResponseRequested: false, full_checksum: null, sinceTime: 0 });
    assert.equal(original.deltasResponseRequested, true);
    const again = normalizeStatsigRequest({ ...routes.refresh, body: result.body, enabled: true });
    assert.equal(again.changed, false);assert.equal(again.body, result.body);
  }
});

test("request normalization is disabled by default and leaves unknown requests untouched", () => {
  const body = ' { "user": { "userID": "fixture" }, "deltasResponseRequested": true }\n';
  for (const options of [{}, { enabled: false }, { enabled: true, ...routes.config }, { enabled: true, hostname: "other.example.test" }]) {
    const result = normalizeStatsigRequest({ ...routes.refresh, body, ...options });
    assert.equal(result.body, body);assert.equal(result.changed, false);
  }
  for (const body of ["not json", "[]", "null", "{}", '{"user":[]}', '{"user":{},"responseMode":"future"}', undefined]) {
    const result = normalizeStatsigRequest({ ...routes.refresh, body, enabled: true });
    assert.equal(result.body, body);assert.equal(result.changed, false);
  }
  const result = normalizeStatsigRequest({ ...routes.refresh, body, enabled: true });
  assert.equal(typeof result.body, "string");assert.equal(result.changed, true);
});

test("separate response calls do not retain account or official availability state", () => {
  const official = apply("config", { is_enabled: true, prompt: "account A" });
  assert.equal(official.official, true);
  const local = apply("config", { is_enabled: false, prompt: "account B" });
  assert.equal(local.official, false);assert.equal(JSON.parse(local.body).prompt, "account B");
  const second = statsig({ user: { userID: "other-user" } });
  assert.deepEqual(JSON.parse(apply("refresh", second).body).user, { userID: "other-user" });
});
