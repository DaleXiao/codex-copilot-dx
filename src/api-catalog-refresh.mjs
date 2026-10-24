import { accessError } from "./access-settings.mjs";

// Network work never holds the configuration transaction. Only publication
// enters the caller's short, version-checked commit boundary.
export function createApiCatalogRefresh({ config, source, track, revision, commit, onState, now = Date.now }) {
  const reads = new Map(), flights = new Map(), pending = new Set();let closed = false, batch;
  const current = (id, version) => !closed && config(id)?.enabled && revision(config(id)) === version;
  function cancel(id) {
    const flight = flights.get(id);if (!flight) return;
    flights.delete(id);flight.controller.abort();
    onState(id, { state: "cancelled", checked_at: new Date(now()).toISOString() });
  }
  function invalidate() {
    for (const [id, flight] of flights) if (!current(id, flight.revision)) { cancel(id);onState(id, null); }
    for (const [id, read] of reads) if (!current(id, read.revision)) { reads.delete(id);onState(id, null); }
  }
  async function refresh(id, force = false) {
    const selected = config(id);
    if (closed || !selected?.enabled) throw accessError("ccdx_client_source_disabled", 503);
    const version = revision(selected), old = flights.get(id);
    if (old?.revision === version && !old.controller.signal.aborted) return old.promise;
    if (old) cancel(id);
    const cached = reads.get(id), age = cached ? now() - cached.at : Infinity;
    if (cached?.revision === version && age >= 0 && age < (force || cached.error ? 60000 : 30 * 60000)) {
      if (cached.error) throw cached.error;
      await commit(id, cached.models, version, new Date(cached.at).toISOString(), () => current(id, version));
      onState(id, { state: "ready", checked_at: new Date(cached.at).toISOString() });return cached.models;
    }
    const savedAge = now() - Date.parse(selected.checked_at);
    if (!force && !cached && savedAge >= 0 && savedAge < 30 * 60000 && selected.models.every(model => model.metadata?.state && model.metadata.deployment === version)) return selected.models;
    const flight = { revision: version, controller: new AbortController() };
    flights.set(id, flight);
    const active = () => current(id, version) && flights.get(id) === flight && !flight.controller.signal.aborted;
    onState(id, { state: "checking", checked_at: new Date(now()).toISOString() });
    pending.add(flight);
    flight.promise = (async () => {
      let finish;
      try {
        const provider = source(id);finish = track(provider);
        const models = await provider.discover({ signal: AbortSignal.any([flight.controller.signal, AbortSignal.timeout(20000)]) });
        if (!active()) throw accessError("ccdx_connections_conflict", 409);
        const at = now();await commit(id, models, version, new Date(at).toISOString(), active);
        if (!active()) throw accessError("ccdx_connections_conflict", 409);
        reads.set(id, { revision: version, at, models });
        onState(id, { state: "ready", checked_at: new Date(at).toISOString() });return models;
      } catch (error) {
        if (!active()) throw accessError("ccdx_connections_conflict", 409);
        const code = /^ccdx_[a-z0-9_]+$/.test(error.code || "") ? error.code : "ccdx_api_catalog_unavailable";
        const failure = accessError(code, [401, 403, 409].includes(error.statusCode) ? error.statusCode : 502);
        if (active()) {
          reads.set(id, { revision: version, at: now(), error: failure });
          onState(id, { state: "stale", code, checked_at: new Date(now()).toISOString() });
        }
        throw failure;
      } finally { finish?.();pending.delete(flight);if (flights.get(id) === flight) flights.delete(id); }
    })();
    return flight.promise;
  }
  return {
    refresh, cancel, invalidate,
    refreshAll(ids) {
      if (closed) return Promise.resolve();
      batch ||= (async () => { for (const id of ids) { if (closed) break;await refresh(id).catch(() => {}); } })().finally(() => { batch = null; });
      return batch;
    },
    async close() {
      closed = true;const jobs = [...pending].map(flight => flight.promise);
      for (const flight of pending) flight.controller.abort();
      await Promise.allSettled(jobs);await batch;
    },
  };
}
