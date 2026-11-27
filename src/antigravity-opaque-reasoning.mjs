import { createHash } from "node:crypto";

export const MAX_OPAQUE_LENGTH = 1024 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_AGE_MS = 60 * 60 * 1000;

function toolPayload({ name, args }) {
  if (typeof name !== "string" || !name || !args || typeof args !== "object" || Array.isArray(args)) return null;
  return JSON.stringify([name, args], (_key, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || JSON.isRawJSON(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
  });
}

const digest = payload => createHash("sha256").update(payload).digest("hex");

function toolTurnFingerprint(calls, issued) {
  if (new Set(calls.map(call => call.id)).size !== calls.length) return null;
  const hash = createHash("sha256");
  let size = 0;
  for (const call of [...calls].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const payload = toolPayload(call);
    if (!payload) return null;
    const encodedId = JSON.stringify(call.id);
    size += Buffer.byteLength(encodedId) + Buffer.byteLength(payload);
    if (size > MAX_OPAQUE_LENGTH) return null;
    hash.update(encodedId).update("\0").update(payload).update("\0");
    if (issued) issued.push({ id: call.id, payload: digest(payload) });
  }
  return hash.digest("hex");
}

const missingId = id => id === undefined || id === "";
function payloadFingerprint(call) {
  const payload = toolPayload(call);
  return payload && Buffer.byteLength(payload) <= MAX_OPAQUE_LENGTH ? digest(payload) : null;
}

// Explicit IDs reserve their issued slots first. Missing IDs then require a
// unique payload match among all remaining members of the same complete group.
function matchWithoutIds(calls, fingerprints, issued) {
  const recovered = new Map(), used = new Set();
  const byId = new Map(issued.map(member => [member.id, member]));
  for (const [index, call] of calls.entries()) {
    if (missingId(call.id)) continue;
    const member = byId.get(call.id);
    if (!member || used.has(member.id) || member.payload !== fingerprints[index]) return null;
    used.add(member.id);
  }
  const available = new Map();
  for (const member of issued) {
    if (!used.has(member.id)) available.set(member.payload, available.has(member.payload) ? null : member.id);
  }
  for (const [index, call] of calls.entries()) {
    if (!missingId(call.id)) continue;
    const payload = fingerprints[index], id = available.get(payload);
    if (!id) return null;
    available.delete(payload);
    recovered.set(call, id);
  }
  return recovered;
}

export function createAntigravityOpaqueReasoning({ now = Date.now } = {}) {
  const entries = new Map();
  let bytes = 0;
  const remove = key => {
    bytes -= entries.get(key).bytes;
    entries.delete(key);
  };
  // Match the entire parallel tool turn in the same conversation and account.
  const keyFor = (scope, ids) => ids.length && ids.length <= 256
    && ids.every(id => typeof id === "string" && id.length && id.length <= 256)
    ? JSON.stringify([scope, [...new Set(ids)].sort()]) : null;
  const matchesToolTurn = (scope, calls) => {
    if (!entries.size) return false;
    const key = keyFor(scope, calls.map(call => call?.id)), entry = entries.get(key);
    if (!entry?.fingerprint) return false;
    if (entry.expires <= now()) { remove(key);return false; }
    return entry.fingerprint === toolTurnFingerprint(calls);
  };
  return {
    hasToolTurns: () => entries.size > 0,
    attach(scope, body) {
      if (!entries.size) return body;
      const time = now();
      let messages;
      for (const [index, message] of body.messages.entries()) {
        if (message.role !== "assistant" || Object.hasOwn(message, "reasoning_opaque") || !message.tool_calls?.length) continue;
        const key = keyFor(scope, message.tool_calls.map(call => call.id));
        const entry = entries.get(key);
        if (!entry?.value) continue;
        if (entry.expires <= time) { remove(key);continue; }
        messages ||= body.messages.slice();
        messages[index] = { ...message, reasoning_opaque: entry.value };
      }
      return messages ? { ...body, messages } : body;
    },
    matchesToolTurn,
    recoverToolTurn(scope, calls) {
      if (!entries.size || !calls.length || calls.length > 256) return null;
      if (calls.every(call => !missingId(call.id))) return matchesToolTurn(scope, calls) || null;
      const fingerprints = calls.map(payloadFingerprint);
      if (fingerprints.some(value => !value)) return null;
      const scopeKey = JSON.stringify(scope), time = now();
      let found;
      for (const entry of entries.values()) {
        if (entry.expires <= time || entry.scopeKey !== scopeKey || entry.issued?.length !== calls.length) continue;
        const recovered = matchWithoutIds(calls, fingerprints, entry.issued);
        if (!recovered) continue;
        if (found) return null;
        found = recovered;
      }
      return found || null;
    },
    remember(scope, calls, opaque) {
      const ids = calls.map(call => call.id);
      const key = keyFor(scope, ids);
      if (!key) return;
      const callProofs = [];
      const fingerprint = toolTurnFingerprint(calls, callProofs);
      const value = typeof opaque?.value === "string" && opaque.value.length <= MAX_OPAQUE_LENGTH
        && keyFor(scope, opaque.ids) === key ? opaque.value : null;
      if (entries.has(key)) remove(key);
      if (!value && !fingerprint) return;
      const scopeKey = JSON.stringify(scope);
      const issued = fingerprint ? callProofs : null;
      const size = Buffer.byteLength(value || "") + Buffer.byteLength(key) + (fingerprint?.length || 0)
        + Buffer.byteLength(scopeKey) + (issued?.reduce((total, call) => total + Buffer.byteLength(call.id) + (call.payload?.length || 0), 0) || 0);
      const time = now();
      while (entries.size) {
        const [oldest, entry] = entries.entries().next().value;
        if (entry.expires > time && bytes + size <= MAX_CACHE_BYTES && entries.size < 256) break;
        remove(oldest);
      }
      entries.set(key, { value, fingerprint, scopeKey, issued, bytes: size, expires: time + MAX_AGE_MS });
      bytes += size;
    },
  };
}
