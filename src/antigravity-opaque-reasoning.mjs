import { createHash } from "node:crypto";

export const MAX_OPAQUE_LENGTH = 1024 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_AGE_MS = 60 * 60 * 1000;

function toolTurnFingerprint(calls) {
  if (new Set(calls.map(call => call.id)).size !== calls.length) return null;
  const hash = createHash("sha256");
  let size = 0;
  for (const { id, name, args } of [...calls].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (typeof name !== "string" || !name || !args || typeof args !== "object" || Array.isArray(args)) return null;
    const wire = JSON.stringify([id, name, args], (_key, value) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || JSON.isRawJSON(value)) return value;
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    });
    size += Buffer.byteLength(wire);
    if (size > MAX_OPAQUE_LENGTH) return null;
    hash.update(wire).update("\0");
  }
  return hash.digest("hex");
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
  return {
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
    matchesToolTurn(scope, calls) {
      if (!entries.size) return false;
      const key = keyFor(scope, calls.map(call => call?.id)), entry = entries.get(key);
      if (!entry?.fingerprint) return false;
      if (entry.expires <= now()) { remove(key);return false; }
      return entry.fingerprint === toolTurnFingerprint(calls);
    },
    remember(scope, calls, opaque) {
      const ids = calls.map(call => call.id);
      const key = keyFor(scope, ids);
      if (!key) return;
      const fingerprint = toolTurnFingerprint(calls);
      const value = typeof opaque?.value === "string" && opaque.value.length <= MAX_OPAQUE_LENGTH
        && keyFor(scope, opaque.ids) === key ? opaque.value : null;
      if (entries.has(key)) remove(key);
      if (!value && !fingerprint) return;
      const size = Buffer.byteLength(value || "") + Buffer.byteLength(key) + (fingerprint?.length || 0);
      const time = now();
      while (entries.size) {
        const [oldest, entry] = entries.entries().next().value;
        if (entry.expires > time && bytes + size <= MAX_CACHE_BYTES && entries.size < 256) break;
        remove(oldest);
      }
      entries.set(key, { value, fingerprint, bytes: size, expires: time + MAX_AGE_MS });
      bytes += size;
    },
  };
}
