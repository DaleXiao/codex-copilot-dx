import { createHmac, randomBytes } from "node:crypto";
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

function responseShape(status, text) {
  if (status !== 200) return "http_status";
  if (Buffer.byteLength(text) > MAX_RETAINED_BYTES) return "too_large";
  let message;
  try {
    message = JSON.parse(text);
  } catch { return "invalid_message"; }
  if (message?.type !== "message" || message.role !== "assistant" || message.error
    || !["end_turn", "max_tokens"].includes(message.stop_reason) || !Array.isArray(message.content)) return "invalid_message";
  if (message.content.some(part => part?.type === "text" && typeof part.text === "string")) return "text";
  // The startup check uses HTTP success. A valid terminal message can have no visible text.
  if (!message.content.length) return "empty";
  if (message.content.every(part => (part?.type === "thinking" && typeof part.thinking === "string")
    || (part?.type === "redacted_thinking" && typeof part.data === "string"))) return "thinking_only";
  return "other_content";
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
  let keySecret;
  function remove(key) {
    clearTimeout(recent.get(key)?.expiry);
    recent.delete(key);
  }

  return {
    clear() { for (const key of recent.keys()) remove(key); },
    async run({ url, headers, bodyText, maxResponseBytes, signal, record }, send) {
      signal?.throwIfAborted();
      // Use the complete prepared request, including the effective credential.
      // Only a short prefix of this provider-instance keyed digest reaches diagnostics.
      keySecret ??= randomBytes(32);
      const key = createHmac("sha256", keySecret).update(JSON.stringify([url, headers, bodyText])).digest("hex");
      const at = now();
      for (const [id, result] of recent) if (at - result.at >= REUSE_MS) remove(id);
      const owner = Symbol();
      const retained = recent.get(key);
      const result = retained || await flights.run(key, async signal => {
        const response = await send(signal);
        const text = await readBoundedResponseText(response, { signal, label: "Claude health check response",
          maxBytes: response.ok ? maxResponseBytes : MAX_UPSTREAM_ERROR_BODY_BYTES });
        const shape = responseShape(response.status, text);
        const stored = ["text", "empty", "thinking_only"].includes(shape);
        const result = { owner, status: response.status, headers: responseHeaders(response), text, at: now(), shape, stored, usageRecorded: false };
        if (stored) {
          remove(key);
          result.expiry = setTimeout(() => remove(key), REUSE_MS);
          result.expiry.unref?.();
          recent.set(key, result);
          if (recent.size > MAX_RETAINED_RESULTS) remove(recent.keys().next().value);
        }
        return result;
      }, { signal });
      signal?.throwIfAborted();
      const reused = owner !== result.owner;
      record({
        reused,
        state: retained ? "reused_recent" : reused ? "reused_inflight" : result.stored ? "stored" : "not_stored",
        shape: result.shape,
        group: key.slice(0, 16),
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
