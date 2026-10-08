import { loadRuntimeConfig, parsePositiveInteger } from "./runtime-config.mjs";
import { httpError } from "./http-errors.mjs";

const HTTP_RUNTIME_CONFIG = loadRuntimeConfig();
const MAX_INFLIGHT_BODY_BYTES = HTTP_RUNTIME_CONFIG.maxInflightBodyBytes;
const MAX_QUEUED_REQUESTS = HTTP_RUNTIME_CONFIG.maxQueuedRequests;
const REQUEST_QUEUE_TIMEOUT_MS = HTTP_RUNTIME_CONFIG.requestQueueTimeoutMs;
const COMPRESSED_BODY_WEIGHT_MULTIPLIER = 4;

export function contentEncodings(contentEncoding) {
  return String(contentEncoding || "identity")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function requestContentLength(req) {
  return Number.parseInt(req.headers?.["content-length"] || "", 10);
}

function requestAdmissionWeight(req, maxBytes) {
  const encodings = contentEncodings(req.headers?.["content-encoding"]);
  const contentLength = requestContentLength(req);
  if (!Number.isFinite(contentLength) || contentLength < 0) return maxBytes;
  const compressed = encodings.some((encoding) => encoding !== "identity");
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
  maxQueued = MAX_QUEUED_REQUESTS,
  waitTimeoutMs = REQUEST_QUEUE_TIMEOUT_MS,
} = {}) {
  const byteLimit = parsePositiveInteger(maxBytes, MAX_INFLIGHT_BODY_BYTES);
  const queueLimit = parsePositiveInteger(maxQueued, MAX_QUEUED_REQUESTS);
  const timeoutMs = parsePositiveInteger(waitTimeoutMs, REQUEST_QUEUE_TIMEOUT_MS);
  const acquireDecompression = createSupplementalAdmission({
    maxWeight: 1,
    maxQueued: queueLimit,
    waitTimeoutMs: timeoutMs,
    label: "Request decompression",
  });
  const acquireDecodedBody = createSupplementalAdmission({
    maxWeight: byteLimit,
    maxQueued: queueLimit,
    waitTimeoutMs: timeoutMs,
    label: "Decoded request body",
    blockBehindExclusive: true,
  });
  const acquireResponseHistory = createSupplementalAdmission({
    maxWeight: byteLimit,
    maxQueued: queueLimit,
    waitTimeoutMs: timeoutMs,
    label: "Response history",
  });
  const queue = [];
  let activeBytes = 0;
  let activeRequests = 0;
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

  const activate = (entry) => {
    entry.cleanup();
    activeBytes += entry.weight;
    activeRequests += 1;
    counters.activated += 1;
    const waitMs = Math.max(0, Date.now() - entry.startedAt);
    counters.waitMsTotal += waitMs;
    counters.waitMsMax = Math.max(counters.waitMsMax, waitMs);
    let released = false;
    const supplementalReleases = new Set();
    const release = () => {
      if (released) return;
      released = true;
      for (const releaseSupplemental of supplementalReleases) releaseSupplemental();
      supplementalReleases.clear();
      activeBytes = Math.max(0, activeBytes - entry.weight);
      activeRequests = Math.max(0, activeRequests - 1);
      drain();
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
      supplementalReleases.add(releaseReservation);
      return releaseReservation;
    };
    release.acquireDecompression = (options) => acquireDecompression(1, options);
    release.reserveDecodedBody = (bytes, options) => reserve(acquireDecodedBody, bytes, options);
    release.reserveDecodedBody.supportsResize = true;
    release.reserveResponseHistory = (bytes, options) => reserve(acquireResponseHistory, bytes, options);
    entry.resolve(release);
  };

  const drain = () => {
    for (let index = 0; index < queue.length;) {
      const entry = queue[index];
      if (entry.cancelled) {
        queue.splice(index, 1);
        continue;
      }
      if (activeBytes + entry.weight > byteLimit) {
        // Unknown-length requests reserve the whole budget. Once one is waiting,
        // do not let later arrivals keep extending its wait indefinitely.
        if (entry.weight === byteLimit) break;
        index += 1;
        continue;
      }
      queue.splice(index, 1);
      activate(entry);
    }
  };

  const acquire = (req, { signal } = {}) => {
    counters.total += 1;
    if (signal?.aborted) {
      counters.aborted += 1;
      return Promise.reject(admissionAbortError(signal));
    }
    const weight = requestAdmissionWeight(req, byteLimit);
    const blockedByExclusive = queue.some((entry) => !entry.cancelled && entry.weight === byteLimit);
    const mustWait = blockedByExclusive || activeBytes + weight > byteLimit;
    if (queue.length >= queueLimit && mustWait) {
      counters.rejected += 1;
      return Promise.reject(httpError(`Request queue is full (${queueLimit} waiting)`, 503));
    }
    if (mustWait) counters.queued += 1;

    return new Promise((resolve, reject) => {
      let timer;
      const entry = {
        cancelled: false,
        startedAt: Date.now(),
        weight,
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
