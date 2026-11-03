import { createHash } from "node:crypto";
import { privacyFailure } from "./privacy-model.mjs";
import { validatePrivacyFindings, mergePrivacyFindings } from "./privacy-findings.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
export function privacyPieces(text, { pieceBytes = 4096, overlapBytes = 1024 } = {}) {
  if (!Number.isSafeInteger(pieceBytes) || pieceBytes < 16 || !Number.isSafeInteger(overlapBytes)
    || overlapBytes < 0 || overlapBytes >= pieceBytes / 2) throw new Error("Invalid privacy piece budget");
  const bytes = Buffer.from(text), result = [];
  if (bytes.length <= pieceBytes) return [{ text, offset: 0 }];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + pieceBytes, bytes.length);
    if (end < bytes.length) {
      while ((bytes[end] & 0xC0) === 0x80) end--;
      const boundary = Math.max(bytes.lastIndexOf(10, end - 1), bytes.lastIndexOf(32, end - 1));
      if (boundary >= start + pieceBytes / 2) end = boundary + 1;
    }
    result.push({ text: bytes.subarray(start, end).toString("utf8"), offset: start });
    if (end === bytes.length) break;
    start = end - overlapBytes;
    while ((bytes[start] & 0xC0) === 0x80) start++;
  }
  return result;
}

// The cache and in-flight table own the same text pieces. A caller's abort
// removes only its waiter; a submitted native batch completes and stays reusable.
export function createPrivacyDetection(model, {
  batchBytes = 16 * 1024, pieceBytes = 4096, overlapBytes = 1024,
  maxCacheBytes = 4 * 1024 * 1024, maxCacheEntries = 5000,
  maxPendingBytes = 16 * 1024 * 1024, maxPendingEntries = 8192, maxConcurrent = 2,
} = {}) {
  if (!Number.isSafeInteger(batchBytes) || batchBytes < 1) throw new Error("Invalid privacy batch budget");
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new Error("Invalid privacy concurrency budget");
  const cache = new Map(), flights = new Map(), turns = [];
  let cacheBytes = 0, pendingBytes = 0, running = 0, closed = false;
  const stats = { submitted_batches: 0, submitted_bytes: 0, cache_hits: 0, shared_hits: 0, skipped_pieces: 0 };
  const copy = value => value.map(span => ({ ...span }));
  function get(key) {
    const entry = cache.get(key);
    if (!entry) return undefined;
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
    entry.done = true;entry.text = null;
    if (flights.get(entry.key) === entry) { flights.delete(entry.key);pendingBytes -= entry.bytes; }
    if (error) entry.reject(error);else entry.resolve(found);
  }
  async function pump() {
    if (running >= maxConcurrent || closed || !turns.length) return;
    running++;const turn = turns.shift();let batch = [], bytes = 0;
    try {
      while (turn.at < turn.entries.length && batch.length < 64) {
        const entry = turn.entries[turn.at];
        if (entry.done) { turn.at++;continue; }
        if (!entry.waiters) { stats.skipped_pieces++;finish(entry, null, privacyFailure("cancelled"));turn.at++;continue; }
        if (batch.length && bytes + entry.bytes > batchBytes) break;
        batch.push(entry);bytes += entry.bytes;entry.submitted = true;turn.at++;
      }
      if (batch.length) {
        const input = batch.map(entry => entry.text);
        let submitted = false;
        const onSubmitted = () => {
          if (!submitted) { submitted = true;stats.submitted_batches++;stats.submitted_bytes += bytes; }
        };
        const result = await model.find(input, { isNeeded: () => batch.some(entry => entry.waiters > 0), onSubmitted });
        onSubmitted(); // In-process detectors have no separate native submission seam.
        const found = validatePrivacyFindings(input, result);
        for (let index = 0; index < batch.length; index++) { put(batch[index].key, found[index]);finish(batch[index], found[index]); }
      }
    } catch (error) {
      for (const entry of batch.length ? batch : turn.entries) finish(entry, null, error);
    } finally {
      running--;
      if (!closed && turn.at < turn.entries.length) turns.push(turn);
      // Give waiter continuations and new short requests a turn before another
      // native batch. Completed pieces are committed before yielding.
      if (!closed && turns.length) setImmediate(() => { for (let worker = running; worker < maxConcurrent && turns.length; worker++) void pump(); });
    }
  }
  async function find(texts, { signal, onPlan } = {}) {
    if (closed) throw privacyFailure("engine_unavailable");
    if (signal?.aborted) throw signal.reason;
    const staged = new Map(), waiters = new Set(), plans = [];let newBytes = 0, waitingBytes = 0;
    for (const text of texts) {
      const fullKey = "full:" + hash(text), full = get(fullKey);
      if (full !== undefined) { plans.push({ full });continue; }
      const pieces = [], units = privacyPieces(text, { pieceBytes, overlapBytes });
      for (const piece of units) {
        const key = units.length === 1 ? fullKey : "piece:" + hash(piece.text), known = units.length === 1 ? undefined : get(key);
        if (known !== undefined) { pieces.push({ offset: piece.offset, known });continue; }
        let entry = flights.get(key) || staged.get(key);
        if (!entry) {
          entry = Promise.withResolvers();Object.assign(entry, { key, text: piece.text, bytes: Buffer.byteLength(piece.text), waiters: 0, done: false, submitted: false });
          staged.set(key, entry);newBytes += entry.bytes;
        } else stats.shared_hits++;
        if (!waiters.has(entry)) waitingBytes += entry.bytes;
        waiters.add(entry);pieces.push({ offset: piece.offset, entry });
      }
      plans.push({ fullKey, pieces, text });
    }
    if (pendingBytes + newBytes > maxPendingBytes || flights.size + staged.size > maxPendingEntries) throw privacyFailure("busy");
    onPlan?.({ pending_bytes: waitingBytes, new_bytes: newBytes, pieces: waiters.size });
    for (const entry of staged.values()) { flights.set(entry.key, entry);pendingBytes += entry.bytes; }
    for (const entry of waiters) entry.waiters++;
    const work = Promise.all(plans.map(async plan => {
      if (plan.full) return plan.full;
      const results = await Promise.all(plan.pieces.map(async piece => {
        const found = piece.known ?? await piece.entry.promise;
        return found.map(span => ({ ...span, start: span.start + piece.offset, end: span.end + piece.offset }));
      }));
      const merged = mergePrivacyFindings(results.flat());validatePrivacyFindings([plan.text], [merged]);put(plan.fullKey, merged);return merged;
    }));
    if (staged.size) { turns.push({ entries: [...staged.values()], at: 0 });void pump(); }
    let listener;
    const aborted = new Promise((_, reject) => {
      listener = () => reject(signal.reason);
      if (signal?.aborted) listener();else signal?.addEventListener("abort", listener, { once: true });
    });
    try { return await (signal ? Promise.race([work, aborted]) : work); }
    finally { signal?.removeEventListener("abort", listener);for (const entry of waiters) entry.waiters--; }
  }
  function cancelQueued() {
    for (const turn of turns) for (const entry of turn.entries) if (!entry.submitted) finish(entry, null, privacyFailure("cancelled"));
    turns.length = 0;
  }
  return {
    find, cancelQueued,
    snapshot: () => ({ ...stats, cache_entries: cache.size, cache_bytes: cacheBytes, pending_pieces: flights.size, pending_bytes: pendingBytes,
      max_cache_bytes: maxCacheBytes, max_pending_bytes: maxPendingBytes, piece_bytes: pieceBytes, batch_bytes: batchBytes, max_concurrent: maxConcurrent }),
    busy: () => running > 0 || flights.size > 0,
    close() { closed = true;cancelQueued();for (const entry of flights.values()) finish(entry, null, privacyFailure("engine_unavailable"));cache.clear();cacheBytes = 0; },
  };
}
