import { createHash } from "node:crypto";
import { privacyFailure } from "./privacy-model.mjs";
import { validatePrivacyFindings } from "./privacy-findings.mjs";

export const PRIVACY_BATCH_BYTES = 16 * 1024;

// Whole-text memoization remains compatible with older components. The new
// component reuses its natural token windows, without extra text overlaps.
export function createPrivacyDetection(model, {
  batchBytes = PRIVACY_BATCH_BYTES, maxCacheBytes = 4 * 1024 * 1024, maxCacheEntries = 5000,
  maxPendingBytes = 16 * 1024 * 1024, maxPendingEntries = 8192, maxConcurrent = 2,
} = {}) {
  if (!Number.isSafeInteger(batchBytes) || batchBytes < 1) throw new Error("Invalid privacy batch budget");
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new Error("Invalid privacy concurrency budget");
  const cache = new Map(), flights = new Map(), turns = [];
  let cacheBytes = 0, pendingBytes = 0, running = 0, closed = false;
  const stats = { submitted_batches: 0, submitted_bytes: 0, cache_hits: 0, shared_hits: 0, skipped_texts: 0, window_evaluations: 0, window_hits: 0, window_shared: 0 };
  const copy = value => value.map(span => ({ ...span }));
  function get(key) {
    const entry = cache.get(key);if (!entry) return undefined;
    cache.delete(key);cache.set(key, entry);stats.cache_hits++;return copy(entry.found);
  }
  function put(key, found) {
    if (closed) return;
    const bytes = Buffer.byteLength(JSON.stringify(found)) + 128;
    if (bytes > 1024 * 1024 || bytes > maxCacheBytes) return;
    const before = cache.get(key);if (before) cacheBytes -= before.bytes;
    cache.delete(key);cache.set(key, { found: copy(found), bytes });cacheBytes += bytes;
    while (cache.size > maxCacheEntries || cacheBytes > maxCacheBytes) {
      const oldest = cache.keys().next().value;cacheBytes -= cache.get(oldest).bytes;cache.delete(oldest);
    }
  }
  function finish(entry, found, error) {
    if (entry.done) return;
    entry.done = true;entry.text = null;entry.batch = null;entry.plans.clear();
    if (flights.get(entry.key) === entry) { flights.delete(entry.key);pendingBytes -= entry.bytes; }
    if (error) entry.reject(error);else entry.resolve(found);
  }
  async function pump() {
    if (running >= maxConcurrent || closed || !turns.length) return;
    running++;const turn = turns.shift(), batch = [];let bytes = 0;
    const lease = { controller: new AbortController(), entries: batch };
    try {
      while (turn.at < turn.entries.length && batch.length < 64) {
        const entry = turn.entries[turn.at];
        if (entry.done) { turn.at++;continue; }
        if (!entry.waiters) { stats.skipped_texts++;finish(entry, null, privacyFailure("cancelled"));turn.at++;continue; }
        if (batch.length && bytes + entry.bytes > batchBytes) break;
        batch.push(entry);bytes += entry.bytes;entry.submitted = true;entry.batch = lease;turn.at++;
      }
      if (batch.length) {
        let submitted = false;
        const onSubmitted = () => { if (!submitted) { submitted = true;stats.submitted_batches++;stats.submitted_bytes += bytes; } };
        const input = batch.map(entry => entry.text), result = await model.find(input, {
          isNeeded: () => batch.some(entry => entry.waiters > 0), workSignal: lease.controller.signal, onSubmitted,
          onWindowWork(work) { stats.window_evaluations += work.evaluated || 0;stats.window_hits += work.hits || 0;stats.window_shared += work.shared || 0; },
          onPlan(plan) {
            const entry = batch[plan.text_index];if (!entry || entry.done) return;
            entry.nativePlan = { pending_windows: plan.pending_windows, total_windows: plan.total_windows };
            for (const notify of entry.plans) notify(entry.nativePlan);
          },
        });
        onSubmitted();const found = validatePrivacyFindings(input, result);
        for (let index = 0; index < batch.length; index++) { put(batch[index].key, found[index]);finish(batch[index], found[index]); }
      }
    } catch (error) {
      for (const entry of batch.length ? batch : turn.entries) {
        // A new waiter that joined a canceling native job resumes only after
        // physical acknowledgement; completed native windows remain reusable.
        if (!closed && error.code === "ccdx_privacy_cancelled" && entry.waiters > 0) {
          entry.submitted = false;entry.batch = null;turn.entries.push(entry);
        } else finish(entry, null, error);
      }
    } finally {
      running--;
      if (!closed && turn.at < turn.entries.length) turns.push(turn);
      if (!closed && turns.length) setImmediate(() => { for (let worker = running; worker < maxConcurrent && turns.length; worker++) void pump(); });
    }
  }
  async function find(texts, { signal, onPlan } = {}) {
    if (closed) throw privacyFailure("engine_unavailable");if (signal?.aborted) throw signal.reason;
    const staged = new Map(), waiters = new Set(), results = [];let newBytes = 0, waitingBytes = 0;
    for (const text of texts) {
      const key = createHash("sha256").update(text).digest("hex"), known = get(key);
      if (known !== undefined) { results.push(Promise.resolve(known));continue; }
      let entry = flights.get(key) || staged.get(key);
      if (!entry) {
        entry = Promise.withResolvers();Object.assign(entry, { key, text, bytes: Buffer.byteLength(text), waiters: 0, done: false, submitted: false, batch: null, plans: new Set(), nativePlan: null });
        staged.set(key, entry);newBytes += entry.bytes;
      } else stats.shared_hits++;
      if (!waiters.has(entry)) waitingBytes += entry.bytes;
      waiters.add(entry);results.push(entry.promise);
    }
    if (pendingBytes + newBytes > maxPendingBytes || flights.size + staged.size > maxPendingEntries) throw privacyFailure("busy");
    onPlan?.({ pending_bytes: waitingBytes, new_bytes: newBytes, texts: waiters.size });
    for (const entry of staged.values()) { flights.set(entry.key, entry);pendingBytes += entry.bytes; }
    for (const entry of waiters) {
      entry.waiters++;
      if (onPlan) { entry.plans.add(onPlan);if (entry.nativePlan) onPlan(entry.nativePlan); }
    }
    const work = Promise.all(results);
    if (staged.size) { turns.push({ entries: [...staged.values()], at: 0 });void pump(); }
    let listener;
    const aborted = new Promise((_, reject) => { listener = () => reject(signal.reason);if (signal?.aborted) listener();else signal?.addEventListener("abort", listener, { once: true }); });
    try { return await (signal ? Promise.race([work, aborted]) : work); }
    finally {
      signal?.removeEventListener("abort", listener);
      for (const entry of waiters) {
        if (onPlan) entry.plans.delete(onPlan);
        entry.waiters--;const lease = entry.batch;
        if (lease && lease.entries.every(item => !item.waiters)) lease.controller.abort(privacyFailure("cancelled"));
      }
    }
  }
  function cancelQueued() {
    for (const entry of flights.values()) if (!entry.submitted) finish(entry, null, privacyFailure("cancelled"));turns.length = 0;
  }
  return {
    find, cancelQueued,
    snapshot: () => ({ ...stats, cache_entries: cache.size, cache_bytes: cacheBytes, pending_texts: flights.size, pending_bytes: pendingBytes,
      max_cache_bytes: maxCacheBytes, max_pending_bytes: maxPendingBytes, batch_bytes: batchBytes, max_concurrent: maxConcurrent }),
    busy: () => running > 0 || flights.size > 0,
    close() { closed = true;cancelQueued();for (const entry of flights.values()) finish(entry, null, privacyFailure("engine_unavailable"));cache.clear();cacheBytes = 0; },
  };
}
