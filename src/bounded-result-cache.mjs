function byteLength(value) {
  return Buffer.byteLength(String(value));
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

export function createByteLruCache({ maxBytes }) {
  const limit = Math.max(0, Number.parseInt(maxBytes, 10) || 0);
  const entries = new Map();
  let bytes = 0;
  let hits = 0;
  let misses = 0;
  let evictions = 0;

  const remove = (key) => {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    bytes -= entry.bytes;
    return true;
  };

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) {
        misses += 1;
        return undefined;
      }
      hits += 1;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      if (typeof key !== "string" || typeof value !== "string") return false;
      const entry = { value, bytes: byteLength(key) + byteLength(value) };
      if (entry.bytes > limit) return false;
      remove(key);
      entries.set(key, entry);
      bytes += entry.bytes;
      while (bytes > limit && entries.size) {
        remove(entries.keys().next().value);
        evictions += 1;
      }
      return entries.has(key);
    },
    clear() {
      entries.clear();
      bytes = 0;
      hits = 0;
      misses = 0;
      evictions = 0;
    },
    stats() {
      return {
        entries: entries.size,
        bytes,
        max_bytes: limit,
        hits,
        misses,
        evictions,
      };
    },
  };
}

export function createAbortAwareSingleflight() {
  const flights = new Map();

  const createFlight = (key, task) => {
    const controller = new AbortController();
    const flight = {
      controller,
      settled: false,
      waiters: 0,
      promise: null,
    };
    flight.promise = Promise.resolve()
      .then(() => task(controller.signal))
      .finally(() => {
        flight.settled = true;
        if (flights.get(key) === flight) flights.delete(key);
      });
    // The shared task can outlive every cancelled waiter. Keep its eventual
    // rejection observed even when no caller remains to await it.
    flight.promise.catch(() => {});
    flights.set(key, flight);
    return flight;
  };

  const waitForFlight = (key, flight, signal) => new Promise((resolve, reject) => {
    let done = false;
    flight.waiters += 1;

    const finish = () => {
      if (done) return false;
      done = true;
      signal?.removeEventListener("abort", onAbort);
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) {
        if (flights.get(key) === flight) flights.delete(key);
        flight.controller.abort(abortError());
      }
      return true;
    };
    const onAbort = () => {
      if (!finish()) return;
      reject(abortError(signal));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    flight.promise.then(
      (value) => {
        if (!finish()) return;
        resolve(value);
      },
      (error) => {
        if (!finish()) return;
        reject(error);
      },
    );
  });

  return {
    run(key, task, { signal } = {}) {
      try {
        throwIfAborted(signal);
      } catch (error) {
        return Promise.reject(error);
      }
      const flight = flights.get(key) || createFlight(key, task);
      return waitForFlight(key, flight, signal);
    },
    stats() {
      return { inflight: flights.size };
    },
  };
}

export function createBoundedResultCache({ maxBytes }) {
  const cache = createByteLruCache({ maxBytes });
  const singleflight = createAbortAwareSingleflight();

  return {
    async getOrCreate(key, createValue, { signal } = {}) {
      throwIfAborted(signal);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      return singleflight.run(key, async (sharedSignal) => {
        const value = await createValue(sharedSignal);
        throwIfAborted(sharedSignal);
        if (typeof value === "string") cache.set(key, value);
        return value;
      }, { signal });
    },
    set(key, value) {
      return cache.set(key, value);
    },
    clear() {
      cache.clear();
    },
    stats() {
      return { ...cache.stats(), ...singleflight.stats() };
    },
  };
}
