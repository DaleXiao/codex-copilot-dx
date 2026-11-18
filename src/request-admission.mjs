import { loadRuntimeConfig, parsePositiveInteger } from "./runtime-config.mjs";
import { httpError } from "./http-errors.mjs";
import { currentRequestContext } from "./request-context.mjs";

const HTTP_RUNTIME_CONFIG = loadRuntimeConfig();
const MAX_INFLIGHT_BODY_BYTES = HTTP_RUNTIME_CONFIG.maxInflightBodyBytes;
const MAX_QUEUED_REQUESTS = HTTP_RUNTIME_CONFIG.maxQueuedRequests;
const REQUEST_QUEUE_TIMEOUT_MS = HTTP_RUNTIME_CONFIG.requestQueueTimeoutMs;
const COMPRESSED_BODY_WEIGHT_MULTIPLIER = 4;
const ADMISSION_ROUTES = new Set(["responses", "responses_compact", "messages", "messages_count_tokens", "search", "images", "antigravity", "antigravity_control"]);
const RECENT_WAITS = 16;

export function contentEncodings(contentEncoding) {
  return String(contentEncoding || "identity")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function requestContentLength(req) {
  return Number.parseInt(req.headers?.["content-length"] || "", 10);
}

function requestAdmissionWeight(req, maxBytes, contentLength) {
  if (!Number.isFinite(contentLength) || contentLength < 0) return maxBytes;
  const encoding = req.headers?.["content-encoding"];
  const compressed = encoding && encoding !== "identity" && contentEncodings(encoding).some(value => value !== "identity");
  const weightedLength = compressed ? contentLength * COMPRESSED_BODY_WEIGHT_MULTIPLIER : contentLength;
  return Math.max(1, Math.min(weightedLength, maxBytes));
}

export function admissionAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function createSupplementalAdmission({ maxWeight, maxQueued, waitTimeoutMs, label, blockBehindExclusive = false }) {
  const queue = [];
  let activeWeight = 0;
  let activeRequestedWeight = 0;
  let activeRequests = 0;

  const activate = (entry) => {
    entry.cleanup();
    activeWeight += entry.weight;
    activeRequestedWeight += entry.requestedWeight;
    activeRequests += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeWeight = Math.max(0, activeWeight - entry.weight);
      activeRequestedWeight = Math.max(0, activeRequestedWeight - entry.requestedWeight);
      activeRequests = Math.max(0, activeRequests - 1);
      drain();
    };
    release.resize = (requestedWeight) => {
      if (released) return 0;
      const parsedWeight = Number.isFinite(requestedWeight) && requestedWeight > 0
        ? Math.ceil(requestedWeight)
        : maxWeight;
      const requested = Math.max(1, parsedWeight);
      const weight = Math.min(requested, maxWeight);
      if (weight > entry.weight) {
        throw new RangeError(`${label} admission weight cannot grow`);
      }
      activeWeight = Math.max(0, activeWeight - (entry.weight - weight));
      activeRequestedWeight = Math.max(0, activeRequestedWeight + requested - entry.requestedWeight);
      entry.weight = weight;
      entry.requestedWeight = requested;
      drain();
      return weight;
    };
    Object.defineProperties(release, {
      weight: { get: () => released ? 0 : entry.weight },
      requestedWeight: { get: () => released ? 0 : entry.requestedWeight },
      maxWeight: { value: maxWeight },
    });
    entry.resolve(release);
  };

  const drain = () => {
    for (let index = 0; index < queue.length;) {
      const entry = queue[index];
      if (activeWeight + entry.weight > maxWeight) {
        if (blockBehindExclusive && entry.weight === maxWeight) break;
        index += 1;
        continue;
      }
      queue.splice(index, 1);
      activate(entry);
    }
  };

  const acquire = (requestedWeight, { signal } = {}) => {
    if (signal?.aborted) return Promise.reject(admissionAbortError(signal));
    const parsedWeight = Number.isFinite(requestedWeight) && requestedWeight > 0
      ? Math.ceil(requestedWeight)
      : maxWeight;
    const requested = Math.max(1, parsedWeight);
    const weight = Math.min(requested, maxWeight);
    const blockedByExclusive = blockBehindExclusive
      && queue.some((entry) => entry.weight === maxWeight);
    const mustWait = blockedByExclusive || activeWeight + weight > maxWeight;
    if (queue.length >= maxQueued && mustWait) {
      return Promise.reject(httpError(`${label} queue is full (${maxQueued} waiting)`, 503));
    }

    return new Promise((resolve, reject) => {
      let timer;
      const entry = {
        weight,
        requestedWeight: requested,
        resolve,
        cleanup: () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      const remove = () => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
      };
      const fail = (error) => {
        entry.cleanup();
        remove();
        reject(error);
        drain();
      };
      const onAbort = () => fail(admissionAbortError(signal));
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        fail(httpError(`${label} admission timed out after ${waitTimeoutMs}ms`, 503));
      }, waitTimeoutMs);
      timer.unref?.();
      queue.push(entry);
      if (signal?.aborted) onAbort();
      else drain();
    });
  };

  acquire.stats = () => ({
    activeWeight,
    activeRequestedWeight,
    activeRequests,
    queued: queue.length,
    maxWeight,
  });
  return acquire;
}

export function createRequestAdmission({
  maxBytes = MAX_INFLIGHT_BODY_BYTES,
  maxSupplementalBytes = maxBytes,
  maxQueued = MAX_QUEUED_REQUESTS,
  waitTimeoutMs = REQUEST_QUEUE_TIMEOUT_MS,
} = {}) {
  const byteLimit = parsePositiveInteger(maxBytes, MAX_INFLIGHT_BODY_BYTES);
  const supplementalByteLimit = parsePositiveInteger(maxSupplementalBytes, byteLimit);
  const queueLimit = parsePositiveInteger(maxQueued, MAX_QUEUED_REQUESTS);
  const timeoutMs = parsePositiveInteger(waitTimeoutMs, REQUEST_QUEUE_TIMEOUT_MS);
  const acquireDecompression = createSupplementalAdmission({
    maxWeight: 1,
    maxQueued: queueLimit,
    waitTimeoutMs: timeoutMs,
    label: "Request decompression",
  });
  const acquireDecodedBody = createSupplementalAdmission({
    maxWeight: supplementalByteLimit,
    maxQueued: queueLimit,
    waitTimeoutMs: timeoutMs,
    label: "Decoded request body",
    blockBehindExclusive: true,
  });
  const acquireResponseHistory = createSupplementalAdmission({
    maxWeight: supplementalByteLimit,
    maxQueued: queueLimit,
    waitTimeoutMs: timeoutMs,
    label: "Response history",
  });
  const queue = [];
  let activeBytes = 0;
  let activeRequests = 0;
  // Only one upload per pool can retain partial data and later ask for more.
  // A blocked growth request goes before new admissions so it can make progress.
  let progressiveReader = false;
  let growth = null;
  const recentWaits = [];
  let longestWait = null;
  function recordWait(entry, outcome, waitMs) {
    const record = Object.freeze({ ...entry.evidence, outcome, wait_ms: waitMs });
    if (outcome === "admitted" && (!longestWait || waitMs > longestWait.wait_ms)) longestWait = record;
    if (recentWaits.length === RECENT_WAITS) recentWaits.shift();
    recentWaits.push(record);
    entry.tracker?.observeContext?.({ body_queue: record });
  }
  const counters = {
    total: 0,
    activated: 0,
    queued: 0,
    rejected: 0,
    timedOut: 0,
    aborted: 0,
    waitMsTotal: 0,
    waitMsMax: 0,
  };

  const remove = (entry) => {
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
  };

  const activate = (weight, progressive) => {
    activeBytes += weight;
    if (progressive) progressiveReader = true;
    let reading = progressive;
    activeRequests += 1;
    counters.activated += 1;
    let released = false;
    let supplementalReleases;
    const release = () => {
      if (released) return;
      released = true;
      if (reading) {
        growth?.cancel();
        reading = progressiveReader = false;
      }
      if (supplementalReleases) {
        for (const releaseSupplemental of supplementalReleases) releaseSupplemental();
        supplementalReleases.clear();
      }
      activeBytes = Math.max(0, activeBytes - weight);
      activeRequests = Math.max(0, activeRequests - 1);
      drain();
    };
    release.resize = bytes => {
      if (released || !Number.isSafeInteger(bytes) || bytes < 0) return;
      const next = Math.max(1, Math.min(weight, bytes));
      if (!reading && next === weight) return;
      if (reading) reading = progressiveReader = false;
      activeBytes -= weight - next;weight = next;drain();
    };
    if (progressive) release.growUpload = (bytes, signal) => {
      if (!reading || signal?.aborted) throw admissionAbortError(signal);
      // Preserve the existing exclusive handling for bodies larger than the pool.
      // The independent per-request raw and decoded limits still apply.
      const next = Math.min(byteLimit, bytes), extra = next - weight;
      if (extra <= 0) return;
      if (activeBytes + extra <= byteLimit) { weight = next;activeBytes += extra;return; }
      return new Promise((resolve, reject) => {
        const clear = () => { growth = null;signal?.removeEventListener("abort", cancel); };
        const cancel = () => { clear();reject(admissionAbortError(signal)); };
        growth = { extra, cancel, grant() { clear();weight = next;activeBytes += extra;resolve(); } };
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
      });
    };
    const reserve = async (gate, weight, options) => {
      const releaseSupplemental = await gate(weight, options);
      if (released) {
        releaseSupplemental();
        throw admissionAbortError(options?.signal);
      }
      let supplementalReleased = false;
      const releaseReservation = () => {
        if (supplementalReleased) return;
        supplementalReleased = true;
        supplementalReleases.delete(releaseReservation);
        releaseSupplemental();
      };
      releaseReservation.resize = (nextWeight) => {
        if (supplementalReleased) return 0;
        return releaseSupplemental.resize(nextWeight);
      };
      Object.defineProperties(releaseReservation, {
        weight: { get: () => supplementalReleased ? 0 : releaseSupplemental.weight },
        requestedWeight: {
          get: () => supplementalReleased ? 0 : releaseSupplemental.requestedWeight,
        },
        maxWeight: { value: releaseSupplemental.maxWeight },
      });
      (supplementalReleases ||= new Set()).add(releaseReservation);
      return releaseReservation;
    };
    release.acquireDecompression = (options) => acquireDecompression(1, options);
    release.reserveDecodedBody = (bytes, options) => reserve(acquireDecodedBody, bytes, options);
    release.reserveDecodedBody.supportsResize = true;
    release.reserveResponseHistory = (bytes, options) => reserve(acquireResponseHistory, bytes, options);
    return release;
  };

  const drain = () => {
    if (growth) {
      if (activeBytes + growth.extra > byteLimit) return;
      growth.grant();
    }
    for (let index = 0; index < queue.length;) {
      const entry = queue[index];
      if (entry.cancelled) {
        queue.splice(index, 1);
        continue;
      }
      if (activeBytes + entry.weight > byteLimit || entry.progressive && progressiveReader) {
        // Preserve queue ordering for requests that need exclusive access.
        if (!entry.progressive && entry.weight === byteLimit) break;
        index += 1;
        continue;
      }
      queue.splice(index, 1);
      entry.cleanup();
      const waitMs = Math.max(0, Date.now() - entry.startedAt);
      counters.waitMsTotal += waitMs;
      counters.waitMsMax = Math.max(counters.waitMsMax, waitMs);
      recordWait(entry, "admitted", waitMs);
      entry.resolve(activate(entry.weight, entry.progressive));
    }
  };

  const acquire = (req, { signal, streamingBody = false } = {}) => {
    counters.total += 1;
    if (signal?.aborted) {
      counters.aborted += 1;
      return Promise.reject(admissionAbortError(signal));
    }
    const length = requestContentLength(req), lengthKnown = Number.isFinite(length) && length >= 0;
    const progressive = streamingBody && !lengthKnown;
    const weight = progressive ? 1 : requestAdmissionWeight(req, byteLimit, length);
    const available = !growth && activeBytes + weight <= byteLimit && (!progressive || !progressiveReader);
    if (queue.length === 0 && available) return Promise.resolve(activate(weight, progressive));
    const blockedByExclusive = queue.some(entry => !entry.cancelled && !entry.progressive && entry.weight === byteLimit);
    if (!blockedByExclusive && available) return Promise.resolve(activate(weight, progressive));
    if (queue.length >= queueLimit) {
      counters.rejected += 1;
      return Promise.reject(httpError(`Request queue is full (${queueLimit} waiting)`, 503));
    }
    counters.queued += 1;
    const start = Date.now(), context = currentRequestContext();
    const id = context?.requestId;
    const evidence = {
      ...(typeof id === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) ? { request_id: id } : {}),
      route: ADMISSION_ROUTES.has(context?.route) ? context.route : "other",
      queued_at: new Date(start).toISOString(),
      reason: growth ? "upload_growth" : blockedByExclusive ? "exclusive_waiter" : progressive && progressiveReader ? "upload_in_progress" : "body_budget",
      requested_bytes: weight, active_bytes: activeBytes, limit_bytes: byteLimit,
      length_known: lengthKnown,
    };
    return new Promise((resolve, reject) => {
      let timer;
      const entry = {
        cancelled: false,
        startedAt: start,
        evidence,
        tracker: context?.streamPerformance,
        weight,
        progressive,
        resolve,
        cleanup: () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      const cancel = (error, reason) => {
        if (entry.cancelled) return;
        entry.cancelled = true;
        if (reason === "aborted") counters.aborted += 1;
        if (reason === "timed_out") counters.timedOut += 1;
        entry.cleanup();
        remove(entry);
        recordWait(entry, reason, Math.max(0, Date.now() - entry.startedAt));
        reject(error);
        drain();
      };
      const onAbort = () => cancel(admissionAbortError(signal), "aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        cancel(httpError(`Request admission timed out after ${timeoutMs}ms`, 503), "timed_out");
      }, timeoutMs);
      timer.unref?.();
      queue.push(entry);
      if (signal?.aborted) onAbort();
      else drain();
    });
  };

  acquire.stats = () => ({ activeBytes, queued: queue.length, maxBytes: byteLimit });
  acquire.diagnostics = () => ({
    activeBytes,
    activeRequests,
    queued: queue.length,
    maxBytes: byteLimit,
    maxQueued: queueLimit,
    waitTimeoutMs: timeoutMs,
    total: counters.total,
    activated: counters.activated,
    queuedTotal: counters.queued,
    rejected: counters.rejected,
    timedOut: counters.timedOut,
    aborted: counters.aborted,
    waitMsAvg: counters.activated > 0
      ? Number((counters.waitMsTotal / counters.activated).toFixed(1))
      : 0,
    waitMsMax: counters.waitMsMax,
    uploadWaitingForMemory: Boolean(growth),
    longestWait: longestWait ? { ...longestWait } : null,
    recentWaits: recentWaits.map(row => ({ ...row })),
    decompressionsActive: acquireDecompression.stats().activeRequests,
    decompressionsQueued: acquireDecompression.stats().queued,
    decodedBodyBytes: acquireDecodedBody.stats().activeRequestedWeight,
    decodedBodyAdmissionBytes: acquireDecodedBody.stats().activeWeight,
    decodedBodiesActive: acquireDecodedBody.stats().activeRequests,
    decodedBodiesQueued: acquireDecodedBody.stats().queued,
    responseHistoryBytes: acquireResponseHistory.stats().activeWeight,
    responseHistoriesActive: acquireResponseHistory.stats().activeRequests,
    responseHistoriesQueued: acquireResponseHistory.stats().queued,
  });
  return acquire;
}
