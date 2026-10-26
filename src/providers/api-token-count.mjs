import { createHash } from "node:crypto";
import { createAbortAwareSingleflight } from "../bounded-result-cache.mjs";
import { readBoundedResponseText } from "../http-transport.mjs";

// One API/key configuration owns these bounded observations and operations.
// Unknown capabilities share their first real count, not another inference.
export function createApiTokenCounter({ request, now = Date.now }) {
  const flights = new Map(), capabilities = new Map(), shared = createAbortAwareSingleflight();let bytes = 0;
  const missed = () => new Response(JSON.stringify({ type: "error", error: { type: "api_error", code: "ccdx_api_count_tokens_unavailable",
    message: "This source's token-count endpoint returned HTTP 404. Message generation is separate." } }), { status: 404, headers: { "Content-Type": "application/json" } });
  const observe = (scope, status) => { capabilities.delete(scope);capabilities.set(scope, { status, at: now() });while (capabilities.size > 128) capabilities.delete(capabilities.keys().next().value); };
  return {
    async count(body, options = {}) {
      if (options.signal?.aborted) throw options.signal.reason;
      const headers = Object.fromEntries(["anthropic-version", "anthropic-beta"].map(name => [name, options.headers?.[name] || ""]));
      const scope = createHash("sha256").update(JSON.stringify([body.model, headers])).digest("hex"), known = capabilities.get(scope), at = now();
      if (known?.status === 404 && at >= known.at && at - known.at < 60000) { options.onCountObservation?.({ cached: true });return missed(); }
      if (known?.status === 404) capabilities.delete(scope);
      const serialized = JSON.stringify(body), size = Buffer.byteLength(serialized), hash = size <= 1024 * 1024 ? createHash("sha256").update(scope).update(serialized).digest("hex") : null;
      const identity = hash || {};
      async function run(probe) {
        const key = probe ? "probe:" + scope : "body:" + hash, waiter = { start: options.onUpstreamStart, observe: options.onCountObservation, signal: options.signal, identity };
        let flight = flights.get(key);
        if (flight && [...flight.waiters].every(item => item.signal?.aborted)) { flights.delete(key);bytes -= flight.bytes;flight = null; }
        const joinable = (probe || hash !== null) && (Boolean(flight) || flights.size < 16 && (probe || bytes + size <= 4 * 1024 * 1024));
        if (!flight || !joinable) {
          flight = { key: {}, identity, bytes: probe ? 0 : size, waiters: new Set(), started: false, shared: false };
          if (joinable) { flights.set(key, flight);bytes += flight.bytes; }
        } else if (flight.identity === identity) flight.shared = true;
        flight.waiters.add(waiter);
        const start = item => {
          item.start?.();
          item.observe?.(item.identity === flight.identity ? { upstream: true, shared: flight.shared } : { waited: true });
        };
        if (flight.started) start(waiter);
        const task = async signal => {
          try {
            if (signal?.aborted) throw signal.reason;
            const response = await request(body, { ...options, bodyText: serialized, signal, observeUpstream: false,
              onUpstreamStart() { flight.started = true;for (const item of flight.waiters) if (!item.signal?.aborted) start(item); } });
            if (signal?.aborted) { await response.body?.cancel();throw signal.reason; }
            if (response.status === 404) {
              await response.body?.cancel();observe(scope, 404);const result = missed();
              return { identity: flight.identity, status: 404, headers: [...result.headers], text: await result.text() };
            }
            const text = await readBoundedResponseText(response, { maxBytes: 64 * 1024, label: "API token count", signal });
            if (response.ok) observe(scope, 200);
            return { identity: flight.identity, status: response.status, headers: [...response.headers], text };
          } finally { if (joinable && flights.get(key) === flight) { flights.delete(key);bytes -= flight.bytes; } }
        };
        try {
          const result = joinable ? await shared.run(flight.key, task, { signal: options.signal }) : await task(options.signal);
          if (result.identity !== identity) {
            options.onCountObservation?.({ waited: true, ...(result.status === 404 ? { cached: true } : {}) });
            if (result.status !== 404) return run(false);
          } else options.onCountObservation?.({ shared: flight.shared });
          return new Response(result.text || null, { status: result.status, headers: result.headers });
        } finally {
          flight.waiters.delete(waiter);
          if (!flight.waiters.size && joinable && flights.get(key) === flight) { flights.delete(key);bytes -= flight.bytes; }
        }
      }
      return run(!capabilities.has(scope));
    },
  };
}
