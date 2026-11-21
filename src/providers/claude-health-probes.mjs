import { createHash } from "node:crypto";
import { createAbortAwareSingleflight } from "../bounded-result-cache.mjs";
import { MAX_UPSTREAM_ERROR_BODY_BYTES, readBoundedResponseText } from "../http-transport.mjs";
import { safeUpstreamResponseHeaders } from "../upstream-headers.mjs";

const REUSE_MS = 250;
const MAX_RETAINED_BYTES = 8 * 1024;
const MAX_RETAINED_RESULTS = 16;
const SESSION_HEADERS = ["session_id", "session-id", "x-conversation-id", "x-claude-code-session-id"];

export function isClaudeHealthProbe(body, headers) {
  const message = body.messages[0];
  return body.max_tokens === 1 && Object.keys(body).length === 3 && body.messages.length === 1
    && message?.role === "user" && message.content === "." && Object.keys(message).length === 2
    && SESSION_HEADERS.every(name => !headers[name]);
}

function reusableMessage(status, text) {
  if (status !== 200 || Buffer.byteLength(text) > MAX_RETAINED_BYTES) return false;
  try {
    const message = JSON.parse(text);
    return message?.type === "message" && message.role === "assistant" && !message.error
      && ["end_turn", "max_tokens"].includes(message.stop_reason)
      && Array.isArray(message.content) && message.content.some(part => part?.type === "text" && typeof part.text === "string");
  } catch { return false; }
}

function responseHeaders(response) {
  const headers = safeUpstreamResponseHeaders(response.headers);
  if (headers["X-Upstream-Request-Id"]) {
    headers["X-Request-Id"] = headers["X-Upstream-Request-Id"];
    delete headers["X-Upstream-Request-Id"];
  }
  for (const [name, value] of response.headers) if (/^anthropic-ratelimit-[a-z0-9-]+$/.test(name)) headers[name] = value;
  return headers;
}

export function createClaudeHealthProbes({ now = () => performance.now() } = {}) {
  const flights = createAbortAwareSingleflight(), recent = new Map();
  function remove(key) {
    clearTimeout(recent.get(key)?.expiry);
    recent.delete(key);
  }

  return {
    clear() { for (const key of recent.keys()) remove(key); },
    async run({ url, headers, bodyText, maxResponseBytes, signal, record }, send) {
      signal?.throwIfAborted();
      // The prepared header set includes the effective credential. The cache
      // retains only a digest, never any request bytes or header values.
      const key = createHash("sha256").update(JSON.stringify([url, headers, bodyText])).digest("hex");
      const at = now();
      for (const [id, result] of recent) if (at - result.at >= REUSE_MS) remove(id);
      const owner = Symbol();
      const result = recent.get(key) || await flights.run(key, async signal => {
        const response = await send(signal);
        const text = await readBoundedResponseText(response, { signal, label: "Claude health check response",
          maxBytes: response.ok ? maxResponseBytes : MAX_UPSTREAM_ERROR_BODY_BYTES });
        const result = { owner, status: response.status, headers: responseHeaders(response), text, at: now(), usageRecorded: false };
        if (reusableMessage(result.status, text)) {
          remove(key);
          result.expiry = setTimeout(() => remove(key), REUSE_MS);
          result.expiry.unref?.();
          recent.set(key, result);
          if (recent.size > MAX_RETAINED_RESULTS) remove(recent.keys().next().value);
        }
        return result;
      }, { signal });
      signal?.throwIfAborted();
      record({
        reused: owner !== result.owner,
        claimUsage() {
          if (result.usageRecorded) return false;
          result.usageRecorded = true;
          return true;
        },
      });
      return new Response(result.text || null, { status: result.status, headers: result.headers });
    },
  };
}
