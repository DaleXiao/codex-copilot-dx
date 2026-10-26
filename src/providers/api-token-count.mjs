import { createHash } from "node:crypto";
import { createAbortAwareSingleflight } from "../bounded-result-cache.mjs";
import { readBoundedResponseText } from "../http-transport.mjs";

// Owned by one immutable API/key configuration. No conversation or credential
// is cached; only small response envelopes and bounded in-flight hashes exist.
export function createApiTokenCounter({ request, now = Date.now }) {
  const flights = new Map(), unavailable = new Map(), shared = createAbortAwareSingleflight();
  let bytes = 0;
  const missed = () => new Response(JSON.stringify({ type: "error", error: { type: "api_error",
    code: "ccdx_api_count_tokens_unavailable", message: "This source's token-count endpoint returned HTTP 404. Message generation is separate." } }),
    { status: 404, headers: { "Content-Type": "application/json" } });
  return {
    async count(body, options = {}) {
      if (options.signal?.aborted) throw options.signal.reason;
      const headers = Object.fromEntries(["anthropic-version", "anthropic-beta"].map(name => [name, options.headers?.[name] || ""]));
      const scope = createHash("sha256").update(JSON.stringify([body.model, headers])).digest("hex");
      const at = now(), seen = unavailable.get(scope);
      if (seen !== undefined && at >= seen && at - seen < 60000) { options.onCountObservation?.({ cached: true });return missed(); }
      unavailable.delete(scope);
      const serialized = JSON.stringify(body), size = Buffer.byteLength(serialized);
      const key = size <= 1024 * 1024 ? createHash("sha256").update(scope).update(serialized).digest("hex") : null;
      const waiter = { start: options.onUpstreamStart, observe: options.onCountObservation, signal: options.signal };
      let flight = flights.get(key);
      if (flight && [...flight.waiters].every(item => item.signal?.aborted)) {
        flights.delete(key);bytes -= size;flight = null;
      }
      const joinable = Boolean(flight) || size <= 1024 * 1024 && flights.size < 16 && bytes + size <= 4 * 1024 * 1024;
      if (!flight) {
        flight = { key: {}, waiters: new Set(), started: false, shared: false };
        if (joinable) { flights.set(key, flight);bytes += size; }
      } else flight.shared = true;
      flight.waiters.add(waiter);
      const start = item => { item.start?.();item.observe?.({ upstream: true, shared: flight.shared }); };
      if (flight.started) start(waiter);
      const run = async signal => {
        try {
          if (signal?.aborted) throw signal.reason;
          const response = await request(body, { ...options, bodyText: serialized, signal, observeUpstream: false,
            onUpstreamStart() { flight.started = true;for (const item of flight.waiters) start(item); } });
          if (signal?.aborted) { await response.body?.cancel();throw signal.reason; }
          if (response.status === 404) {
            await response.body?.cancel();unavailable.set(scope, now());
            while (unavailable.size > 128) unavailable.delete(unavailable.keys().next().value);
            const result = missed();return { status: result.status, headers: [...result.headers], text: await result.text() };
          }
          const text = await readBoundedResponseText(response, { maxBytes: 64 * 1024, label: "API token count", signal });
          return { status: response.status, headers: [...response.headers], text };
        } finally { if (joinable && flights.get(key) === flight) { flights.delete(key);bytes -= size; } }
      };
      try {
        const result = joinable ? await shared.run(flight.key, run, { signal: options.signal }) : await run(options.signal);
        options.onCountObservation?.({ shared: flight.shared });
        return new Response(result.text || null, { status: result.status, headers: result.headers });
      } finally {
        flight.waiters.delete(waiter);
        if (!flight.waiters.size && joinable && flights.get(key) === flight) { flights.delete(key);bytes -= size; }
      }
    },
  };
}
