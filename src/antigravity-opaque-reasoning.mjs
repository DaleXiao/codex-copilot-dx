export const MAX_OPAQUE_LENGTH = 1024 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_AGE_MS = 60 * 60 * 1000;

export function createAntigravityOpaqueReasoning() {
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
      const now = Date.now();
      let messages;
      for (const [index, message] of body.messages.entries()) {
        if (message.role !== "assistant" || Object.hasOwn(message, "reasoning_opaque") || !message.tool_calls?.length) continue;
        const key = keyFor(scope, message.tool_calls.map(call => call.id));
        const entry = entries.get(key);
        if (!entry) continue;
        if (entry.expires <= now) { remove(key);continue; }
        messages ||= body.messages.slice();
        messages[index] = { ...message, reasoning_opaque: entry.value };
      }
      return messages ? { ...body, messages } : body;
    },
    remember(scope, value, ids) {
      if (typeof value !== "string" || !value || value.length > MAX_OPAQUE_LENGTH) return;
      const key = keyFor(scope, ids);
      if (!key) return;
      if (entries.has(key)) remove(key);
      const size = Buffer.byteLength(value) + Buffer.byteLength(key);
      const now = Date.now();
      while (entries.size) {
        const [oldest, entry] = entries.entries().next().value;
        if (entry.expires > now && bytes + size <= MAX_CACHE_BYTES && entries.size < 256) break;
        remove(oldest);
      }
      entries.set(key, { value, bytes: size, expires: now + MAX_AGE_MS });
      bytes += size;
    },
  };
}
