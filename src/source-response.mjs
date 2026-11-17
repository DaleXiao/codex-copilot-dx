// Internal consumers settle source ownership in their existing read/cancel
// callbacks. No second stream, reader interception or Response facade is needed.
const responses = new WeakMap(), readers = new WeakMap();
export const SOURCE_HTTP_CONTEXT = Symbol("source HTTP admission"), SOURCE_HTTP_CLIENT = Symbol("source HTTP client");

class SourceResponse {
  constructor(response, lease, signal, bodyObserved, captureLimit, externalObserver, waitTimeoutMs) {
    this.owner = this;this.body = response.body;this.status = response.status;this.headers = response.headers;
    this.lease = lease;this.signal = signal;this.bodyObserved = bodyObserved;this.captureLimit = captureLimit;
    this.externalObserver = externalObserver;
    this.waitTimeoutMs = waitTimeoutMs;
    this.reader = null;this.cancelled = false;this.done = false;this.failed = false;this.accepted = false;
    this.branches = null;this.waiter = null;this.fragments = null;this.bytes = 0;
    if (signal) { this.abort = () => { void cancelBranches(this, this.branches ? [...this.branches] : [this]).catch(() => {}); };signal.addEventListener("abort", this.abort, { once: true }); }
  }
  finish(success) {
    if (this.done) return;this.done = true;this.signal?.removeEventListener("abort", this.abort);
    this.body = null;this.reader = null;this.fragments = null;
    if (this.branches) for (const branch of this.branches) { branch.body = null;branch.reader = null;branch.fragments = null; }
    this.branches = null;this.lease.release(success && !this.failed && !this.signal?.aborted);this.waiter?.resolve();
  }
  observe(branch, value) {
    if (this.done || branch.cancelled) return;
    if (!value.done) {
      if (this.captureLimit && !this.bodyObserved && branch.bytes <= this.captureLimit) {
        branch.bytes += value.value.byteLength;
        if (branch.bytes <= this.captureLimit) (branch.fragments ||= []).push(Buffer.from(value.value));else branch.fragments = null;
      }
      return;
    }
    if (!this.bodyObserved && branch.fragments?.length) {
      try { this.lease.observe(this.status, this.headers, JSON.parse(Buffer.concat(branch.fragments).toString()));this.bodyObserved = true; } catch {}
    }
    this.finish(this.status >= 200 && this.status < 300);
  }
  cancelledBranch(branch) {
    if (this.done) return;
    branch.cancelled = true;branch.fragments = null;
    if (!this.externalObserver && (!this.branches || [...this.branches].every(item => item.cancelled))) this.finish(this.accepted && !this.signal?.aborted);
  }
}

export function trackSourceResponse(response, lease, { signal, bodyObserved = false, captureLimit = 0, externalObserver = false, waitTimeoutMs = 30000 } = {}) {
  const state = new SourceResponse(response, lease, signal, bodyObserved, captureLimit, externalObserver, waitTimeoutMs);responses.set(response, state);
  if (lease.released) state.finish(false);
  else if (signal?.aborted) void cancelSourceResponse(response).catch(() => {});
  return state;
}

export function sourceResponseReader(response, options) {
  const reader = response?.body?.getReader?.(options), branch = responses.get(response);
  if (reader && branch && !branch.owner.done) { branch.body = response.body;branch.reader = reader;readers.set(reader, branch); }
  return reader;
}

export function observeSourceRead(reader, value) {
  const branch = readers.get(reader);
  if (branch?.reader === reader) branch.owner.observe(branch, value);
}

export function failSourceRead(reader) {
  const branch = readers.get(reader);
  if (branch?.reader === reader && !branch.cancelled) branch.owner.finish(false);
}

export function releaseSourceReader(reader) {
  const branch = readers.get(reader);
  if (branch?.reader === reader) branch.reader = null;
  readers.delete(reader);
  reader?.releaseLock();
}

export function cancelSourceReader(reader, reason) {
  const branch = readers.get(reader);
  let pending;try { pending = reader.cancel(reason); } catch (error) { return Promise.reject(error); }
  if (branch?.reader === reader && !branch.owner.done) branch.owner.cancelledBranch(branch);
  void Promise.resolve(pending).catch(() => {});return Promise.resolve();
}

export function cloneSourceResponse(response) {
  const clone = response.clone(), original = responses.get(response);
  if (original && !original.owner.done) {
    original.body = response.body;const owner = original.owner;
    const branch = { owner, body: clone.body, reader: null, cancelled: false, fragments: null, bytes: 0 };
    (owner.branches ||= new Set([owner])).add(branch);responses.set(clone, branch);
  }
  return clone;
}

export function sourceResponseAccepted(response) { const state = responses.get(response)?.owner;if (state) state.accepted = true; }
export function sourceResponseStreamLimit(response, error) { const state = responses.get(response)?.owner;state?.lease.streamFailure(error, state.headers); }
export function sourceResponseFailed(response) { const state = responses.get(response)?.owner;if (state) state.failed = true; }
export function sourceResponseFeedback(response, value) {
  const state = responses.get(response)?.owner;
  if (state && !state.bodyObserved) { state.bodyObserved = true;state.lease.observe(state.status, state.headers, value); }
}

export function cancelSourceResponse(response, reason) {
  const branch = responses.get(response), owner = branch?.owner;
  if (!owner || owner.done) { try { void Promise.resolve(response?.body?.cancel?.(reason)).catch(() => {});return Promise.resolve(); } catch (error) { return Promise.reject(error); } }
  // Cancellation is accepted synchronously by a valid native stream/reader.
  // Its cleanup promise may remain pending (notably a tee branch); it must
  // not retain a source slot after all branches have been cancelled.
  branch.body = response.body;return cancelBranches(owner, [branch], reason);
}

function cancelBranches(owner, branches, reason) {
  const pending = [];
  for (const item of branches) {
    if (item.cancelled) continue;
    try {
      if (item.reader) pending.push(Promise.resolve(cancelSourceReader(item.reader, reason)));
      else if (!item.body?.locked) { pending.push(Promise.resolve(item.body?.cancel(reason)));owner.cancelledBranch(item); }
    } catch (error) { pending.push(Promise.reject(error)); }
  }
  for (const operation of pending) void operation.catch(() => {});
  return Promise.resolve();
}

export function hasSourceReader(reader) { return readers.has(reader); }

export function whenSourceReleased(response, { signal, timeoutMs } = {}) {
  const owner = responses.get(response)?.owner;
  if (!owner || owner.done) return Promise.resolve();
  owner.waiter ||= (() => { let resolve;const promise = new Promise(done => { resolve = done; });return { resolve, promise }; })();
  return new Promise((resolve, reject) => {
    let timer;const cleanup = () => { clearTimeout(timer);signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup();reject(signal.reason); };
    owner.waiter.promise.then(() => { cleanup();resolve(); });
    const budget = Math.min(owner.waitTimeoutMs, timeoutMs ?? Number.POSITIVE_INFINITY);
    timer = setTimeout(() => { cleanup();reject(Object.assign(new Error("The previous source response did not release its slot."), { code: "ccdx_compaction_source_busy", statusCode: 503 })); }, budget);
    signal?.addEventListener("abort", abort, { once: true });if (signal?.aborted) abort();
  });
}
