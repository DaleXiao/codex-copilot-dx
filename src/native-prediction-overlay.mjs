export const NATIVE_PREDICTION_GATE = "4290031608";

const LOCAL_PREDICTION_CONFIG = Object.freeze({
  is_enabled: true,
  prompt: 'Predict one useful next message the user may send, based on the conversation. Write from the user\'s perspective and use the user\'s language. Do not answer the message, call tools, or invent new requests, consent, or permission. Prefer a short, natural follow-up. If no useful follow-up is apparent, use an empty string. Return only a JSON object with exactly one key: {"suggestion":"the predicted user message"}.',
  prompt_version: "ccdx-native-prediction-v1",
  prediction_reasoning_effort: "low",
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseBody(body) {
  if (typeof body !== "string" && !Buffer.isBuffer(body)) return null;
  try { return JSON.parse(body.toString()); } catch { return null; }
}

function encodeBody(value, original) {
  const text = JSON.stringify(value);
  return Buffer.isBuffer(original) ? Buffer.from(text) : text;
}

export function classifyNativePredictionPath({ hostname, pathname } = {}) {
  const host = typeof hostname === "string" ? hostname.toLowerCase() : "";
  if (host === "chatgpt.com") {
    if (pathname === "/backend-api/wham/statsig/bootstrap") return "bootstrap";
    if (pathname === "/backend-api/wham/predictions/config") return "config";
  }
  if (host === "ab.chatgpt.com" && pathname === "/v1/initialize") return "refresh";
  return null;
}

function enablePredictionGate(payload) {
  if (!isObject(payload) || (payload.response_mode === "live_overlay" ? payload.has_updates === false : payload.has_updates !== true) ||
      (payload.is_delta !== undefined && payload.is_delta !== false) ||
      (payload.response_mode !== undefined && !["full", "live_overlay"].includes(payload.response_mode)) ||
      !isObject(payload.feature_gates)) return false;
  // Statsig V1 first resolves the literal name, then its djb2 lookup key.
  let hash = 0;
  for (const char of NATIVE_PREDICTION_GATE) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  const hashedKey = String(hash >>> 0);
  const key = Object.hasOwn(payload.feature_gates, NATIVE_PREDICTION_GATE) ? NATIVE_PREDICTION_GATE
    : Object.hasOwn(payload.feature_gates, hashedKey) ? hashedKey : NATIVE_PREDICTION_GATE;
  const gate = payload.feature_gates[key];
  if (gate !== undefined && (!isObject(gate) || typeof gate.value !== "boolean" || gate.value === true)) return false;
  if (payload.response_mode === "live_overlay" && !Array.isArray(payload.live_entity_names?.feature_gates)) return false;
  if (gate) gate.value = true;
  else payload.feature_gates[key] = { name: key, value: true, rule_id: "ccdx-local-compatibility", secondary_exposures: [] };
  if (payload.response_mode === "live_overlay" && !payload.live_entity_names.feature_gates.includes(key)) {
    payload.live_entity_names.feature_gates.push(key);
  }
  return true;
}

// No-op results retain the original bytes; callers own HTTP headers and decoding.
export function applyNativePredictionOverlay({ hostname, pathname, statusCode, body, enabled = false } = {}) {
  const kind = classifyNativePredictionPath({ hostname, pathname });
  const result = { body, statusCode, changed: false, official: false, kind };
  if (!enabled || !kind) return result;
  if (kind === "config" && statusCode === 404) {
    return { ...result, statusCode: 200, body: encodeBody(LOCAL_PREDICTION_CONFIG, body), changed: true };
  }
  if (statusCode !== 200) return result;
  const parsed = parseBody(body);
  if (!isObject(parsed)) return result;
  if (kind === "config") {
    if (parsed.is_enabled === true) return { ...result, official: true };
    if (parsed.is_enabled !== false || typeof parsed.prompt !== "string" || !parsed.prompt.trim()) return result;
    parsed.is_enabled = true;
  } else if (kind === "bootstrap") {
    const stringPayload = typeof parsed.statsigPayload === "string";
    const payload = stringPayload ? parseBody(parsed.statsigPayload) : parsed.statsigPayload;
    if (!enablePredictionGate(payload)) return result;
    if (stringPayload) parsed.statsigPayload = JSON.stringify(payload);
  } else if (!enablePredictionGate(parsed)) return result;
  return { ...result, body: encodeBody(parsed, body), changed: true };
}

// Overlaying a delta would invalidate its checksum. Ask for a full response instead.
export function normalizeStatsigRequest({ hostname, pathname, body, enabled = false } = {}) {
  const result = { body, changed: false };
  if (!enabled || classifyNativePredictionPath({ hostname, pathname }) !== "refresh") return result;
  const parsed = parseBody(body);
  if (!isObject(parsed) || !isObject(parsed.user) ||
      (parsed.responseMode !== undefined && !["full", "live_overlay"].includes(parsed.responseMode))) return result;
  if (parsed.deltasResponseRequested === false && parsed.full_checksum === null && parsed.sinceTime === 0) return result;
  parsed.deltasResponseRequested = false;
  parsed.full_checksum = null;
  parsed.sinceTime = 0;
  return { body: encodeBody(parsed, body), changed: true };
}
