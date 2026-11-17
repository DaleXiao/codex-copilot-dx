import { createHash } from "node:crypto";
import { isDisturbed } from "node:stream";
import { currentRequestContext } from "./request-context.mjs";
import { readSafeUpstreamReason } from "./safe-upstream-error.mjs";

const MAX_LIMIT = 128;
const MAX_QUEUE_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BYTES = 4096;
const BODY_METHODS = new Set(["arrayBuffer", "blob", "bytes", "formData", "json", "text", "clone"]);
const immediate = value => value;
const abortError = signal => signal?.reason || Object.assign(new Error("Request cancelled"), { name: "AbortError" });
const failure = (code, message, retryAfterMs = 1000, statusCode = 503) => Object.assign(new Error(message), { code, statusCode, retryAfterMs,
  sourceQueue: true, origin: "source_admission", jsonBody: { type: "error", error: { type: statusCode === 429 ? "rate_limit_error" : "api_error", code, message } } });
const fingerprint = value => createHash("sha256").update(value).digest("hex");
const validLimit = value => value === null || Number.isSafeInteger(value) && value >= 1 && value <= MAX_LIMIT;
export const SOURCE_ADMISSION = Symbol("source admission");
export const SOURCE_LIMIT_EVIDENCE = Symbol("source limit evidence");
const SOURCE_STREAM_LIMIT = Symbol("source stream limit");
export function observeSourceStreamFailure(response, error) {
  const code = error?.details?.error_code || error?.upstream_code || error?.code || error?.type;
  if (["rate_limit_error", "rate_limit_exceeded", "ramp_limit_exceeded", "concurrency_limit", "concurrency_limit_exceeded", "too_many_concurrent_requests",
    "insufficient_quota", "credit_balance_exhausted", "quota_exceeded", "model_quota_exceeded", "enforced_spend_limit_reached"].includes(code)) response?.[SOURCE_STREAM_LIMIT]?.(error);
}
export function admittedSource(source, scheduler) {
  return source?.client && scheduler ? { ...source, client: scheduler.wrap(source.client, () => ({ source: source.id, account: source.profileId() })) } : source;
}

export function sourceLimitFeedback(status, headers, body, now = Date.now()) {
  if (status !== 429) return null;
  const retry = headers?.get?.("retry-after");
  let delay = /^\d{1,8}$/.test(retry || "") ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - now);
  if (!Number.isFinite(delay)) delay = 0;
  const error = body?.error;
  const code = String(error?.details?.error_code || error?.upstream_code || error?.code || error?.type || "");
  const message = typeof error?.message === "string" ? error.message.slice(0, MAX_ERROR_BYTES) : "";
  const modelScoped = error?.details?.scope === "model" || error?.param === "model" || /^model_.*quota/.test(code);
  if (/insufficient_quota|credit_balance_exhausted|quota_exceeded|quota_exhausted|enforced_spend_limit_reached/.test(code)
    || /\b(?:individual quota reached|exhausted your capacity on this model)\b/i.test(message)) {
    const reset = /\b(?:quota will reset after|resets in)\s+((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)/i.exec(message)?.[1];
    if (reset) {
      const duration = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(reset);
      if (duration) delay = Math.max(delay, (Number(duration[1] || 0) * 3600 + Number(duration[2] || 0) * 60 + Number(duration[3] || 0)) * 1000);
    }
    const accountQuota = /insufficient_quota|credit_balance_exhausted|enforced_spend_limit_reached/.test(code)
      || ["source", "account", "organization", "project"].includes(error?.details?.scope);
    return { kind: "quota", scope: modelScoped || /on this model/i.test(message) || !accountQuota ? "model" : "source", delay: delay || 300000 };
  }
  if (/concurr|parallel_requests/.test(code) || /\b(?:concurrent requests|concurrency limit|too many parallel)\b/i.test(message)) {
    const limit = error?.limit;
    return { kind: "concurrency", scope: modelScoped ? "model" : "source", delay: delay || 1000,
      ...(Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_LIMIT ? { limit } : {}) };
  }
  const knownRate = /rate_limit|ramp_limit/.test(code);
  const sourceScoped = ["source", "account", "organization", "project"].includes(error?.details?.scope);
  return { kind: knownRate ? "rate" : "unknown", scope: sourceScoped ? "source" : "model", delay: delay || 1000 };
}

// Request-body reservations and source slots have different owners. A source
// slot ends when its actual upstream body ends/cancels, never at its headers.
export function createSourceAdmission({ now = Date.now, initialLimit = MAX_LIMIT, maxQueued = 16,
  maxQueuedBytes = MAX_QUEUE_BYTES, waitTimeoutMs = 30000, stableMs = 60000, onStable = () => {}, learned = {} } = {}) {
  const groups = new Map(), limits = new Map(), clients = new WeakMap();
  let closed = false, queuedBytes = 0;
  const groupFor = ({ source, account = source }) => {
    const identity = source + "\0" + account;
    let group = groups.get(identity);
    if (!group) {
      if (groups.size >= 64) {
        const idle = [...groups].find(([, value]) => !value.active && !value.queue.length);
        if (!idle) throw failure("ccdx_source_capacity", "Source scheduler is busy. Retry shortly.");
        clearTimeout(idle[1].timer);groups.delete(idle[0]);
      }
      const key = fingerprint(identity), saved = learned[key], restored = validLimit(saved?.limit) && saved?.limit !== null && now() >= saved.at && now() - saved.at < 86400000;
      group = { source, key, limit: restored ? saved.limit : initialLimit, active: 0, queue: [], models: new Map(), lastClient: null,
        epoch: 0, stableAt: now(), successes: 0, pausedUntil: 0, reason: null, timer: null, completed: 0, rejected: 0 };
      groups.set(identity, group);
    }
    return group;
  };
  const capacity = group => Math.min(group.limit, limits.get(group.source) || MAX_LIMIT);
  const modelState = (group, model) => {
    if (!group.models.has(model)) {
      if (group.models.size >= 128) {
        const idle = [...group.models].find(([id, value]) => !value.active && value.until <= now() && !group.queue.some(entry => entry.model === id));
        if (!idle) return null;
        group.models.delete(idle[0]);
      }
      group.models.set(model, { active: 0, limit: MAX_LIMIT, maximum: MAX_LIMIT, maximumUntil: 0, until: 0, reason: null, epoch: 0, successes: 0, stableAt: now() });
    }
    return group.models.get(model);
  };
  const readyAt = (group, entry) => Math.max(group.pausedUntil, group.models.get(entry.model)?.until || 0);
  const fits = (group, entry) => group.active < capacity(group)
    && (group.models.get(entry.model)?.active || 0) < (group.models.get(entry.model)?.limit || MAX_LIMIT)
    && readyAt(group, entry) <= now();
  function arm(group) {
    clearTimeout(group.timer);group.timer = null;
    if (!group.queue.length) return;
    const times = group.queue.map(entry => readyAt(group, entry)).filter(at => at > now());
    if (times.length) { group.timer = setTimeout(() => drain(group), Math.max(1, Math.min(...times) - now()));group.timer.unref?.(); }
  }
  function drain(group) {
    if (closed) return;
    if (!group.queue.length) { if (group.timer) { clearTimeout(group.timer);group.timer = null; }return; }
    while (group.queue.length && group.active < capacity(group)) {
      let index = group.queue.findIndex(entry => entry.client !== group.lastClient && fits(group, entry));
      if (index < 0) index = group.queue.findIndex(entry => fits(group, entry));
      if (index < 0) break;
      const [entry] = group.queue.splice(index, 1);queuedBytes -= entry.bytes;entry.cleanup();activate(group, entry);
    }
    arm(group);
  }
  function feedback(group, entry, value) {
    if (!value) return;
    const until = now() + Math.min(7 * 86400000, value.delay);
    const model = modelState(group, entry.model);
    if (value.scope === "source") { group.pausedUntil = Math.max(group.pausedUntil, until);group.reason = value.kind; }
    else if (model) { model.until = Math.max(model.until, until);model.reason = value.kind; }
    // Unknown 429s briefly space the account, without inventing a permanent
    // account-wide quota rejection from one model's response.
    if (value.scope === "model") group.pausedUntil = Math.max(group.pausedUntil, Math.min(until, now() + 1000));
    if (value.kind === "concurrency" && (value.scope === "model" ? model && entry.modelEpoch === model.epoch : entry.epoch === group.epoch)) {
      const next = value.limit || Math.max(1, Math.floor((value.scope === "model" ? entry.modelInflight : entry.inflight) / 2));
      if (value.scope === "model" && model) {
        model.limit = Math.min(model.limit, next);if (value.limit) { model.maximum = value.limit;model.maximumUntil = now() + stableMs; }
        model.epoch++;model.successes = 0;model.stableAt = now();
      } else {
        group.limit = Math.min(group.limit, next);if (value.limit) { group.advertised = value.limit;group.advertisedUntil = now() + stableMs; }
        group.epoch++;group.successes = 0;group.stableAt = now();
      }
    }
    arm(group);
  }
  function activate(group, entry) {
    group.active++;group.lastClient = entry.client;
    const model = modelState(group, entry.model);if (model) model.active++;
    entry.epoch = group.epoch;entry.modelEpoch = model?.epoch;entry.inflight = group.active;entry.modelInflight = model?.active || 1;
    let released = false, observed = false;
    return entry.resolve({
      limit(value) { observed = true;feedback(group, entry, value); },
      observe(status, headers, body) {
        const declared = headers?.get?.("x-ratelimit-concurrency-limit");
        if (/^\d{1,3}$/.test(declared || "") && validLimit(Number(declared))) {
          group.advertised = Number(declared);group.advertisedUntil = now() + stableMs;group.limit = Math.min(group.limit, group.advertised);
        }
        observed ||= status === 429;
        feedback(group, entry, sourceLimitFeedback(status, headers, body, now()));
      },
      release(success = false) {
        if (released) return;released = true;group.active--;if (model) model.active--;group.completed++;
        if (success && !observed) {
          group.successes++;
          if (group.successes >= 8 && now() - group.stableAt >= stableMs) {
            const ceiling = limits.get(group.source) || MAX_LIMIT;
            if (group.queue.length && group.limit < ceiling) group.limit = Math.min(group.advertisedUntil > now() ? group.advertised : MAX_LIMIT, group.limit + 1);
            group.stableAt = now();group.successes = 0;
            if (group.limit <= ceiling && (group.epoch || group.limit !== initialLimit)) try { onStable(group.key, group.limit); } catch { /* Optional metadata persistence cannot fail inference. */ }
          }
          if (model) {
            model.successes++;
            if (group.queue.some(waiter => waiter.model === entry.model) && model.limit < capacity(group) && model.successes >= 8 && now() - model.stableAt >= stableMs) {
              model.limit = Math.min(model.maximumUntil > now() ? model.maximum : MAX_LIMIT, model.limit + 1);model.stableAt = now();model.successes = 0;
            }
          }
        }
        drain(group);
      },
    });
  }
  function acquire(descriptor, { signal, model = "unknown", client = "other", bytes = () => 1 } = {}) {
    if (closed) throw failure("ccdx_source_closed", "The source scheduler is stopping.");
    if (signal?.aborted) throw abortError(signal);
    const group = groupFor(descriptor), entry = { model, client, epoch: group.epoch, bytes: 0 };
    if (!group.queue.length && fits(group, entry)) { entry.resolve = immediate;return activate(group, entry); }
    const delay = Math.max(0, readyAt(group, entry) - now());
    if (delay >= waitTimeoutMs) throw failure("ccdx_source_limited", "The source is limited. Retry after its recovery time.", delay, 429);
    const size = bytes();
    entry.bytes = Number.isSafeInteger(size) && size > 0 ? size : maxQueuedBytes + 1;
    if (group.queue.length >= maxQueued || entry.bytes + queuedBytes > maxQueuedBytes) {
      group.rejected++;throw failure("ccdx_source_queue_full", "The source is busy and its waiting queue is full. Retry shortly.", Math.max(1000, delay));
    }
    const started = now(), tracker = currentRequestContext()?.streamPerformance;
    return new Promise((resolve, reject) => {
      const remove = () => { const index = group.queue.indexOf(entry);if (index >= 0) { group.queue.splice(index, 1);queuedBytes -= entry.bytes; } };
      const fail = error => { remove();entry.cleanup();reject(error);drain(group); };
      const cancelled = () => fail(Object.assign(new Error("Waiting for the source was cancelled."), { name: "AbortError", code: "ccdx_source_queue_cancelled", sourceQueue: true, origin: "source_admission" }));
      const timer = setTimeout(() => fail(failure("ccdx_source_queue_timeout", "Waiting for the source timed out. Retry shortly.")), waitTimeoutMs);
      timer.unref?.();
      entry.cleanup = () => { clearTimeout(timer);signal?.removeEventListener("abort", cancelled); };
      entry.resolve = value => { tracker?.observeContext?.({ source_queue_ms: Math.max(0, Math.round(now() - started)) });resolve(value); };
      entry.reject = fail;queuedBytes += entry.bytes;group.queue.push(entry);
      signal?.addEventListener("abort", cancelled, { once: true });
      if (signal?.aborted) cancelled();else drain(group);
    });
  }
  async function run(descriptor, perform, options = {}) {
    const acquired = acquire(descriptor, options), lease = acquired instanceof Promise ? await acquired : acquired;
    let response;
    try { if (options.signal?.aborted) throw abortError(options.signal);response = await perform(); }
    catch (error) { lease.release();throw error; }
    if (!(response instanceof Response)) { lease.release();return response; }
    lease.observe(response.status, response.headers);
    const observedLimit = response[SOURCE_LIMIT_EVIDENCE];if (observedLimit) lease.limit(observedLimit);
    if (!response.body) { lease.release(response.ok);return response; }
    if (response.status === 429 && !observedLimit) await readSafeUpstreamReason(response.clone(), { signal: options.signal, maxBytes: MAX_ERROR_BYTES,
      onSourceLimit: value => lease.limit(sourceLimitFeedback(response.status, response.headers, value, now())) });
    const reader = response.body.getReader();let ended = false, errorBytes = 0, fragments = [];
    const finish = success => {
      if (ended) return;ended = true;options.signal?.removeEventListener("abort", cancel);
      if (fragments.length) { try { lease.observe(response.status, response.headers, JSON.parse(Buffer.concat(fragments).toString())); } catch {}fragments = []; }
      try { reader.releaseLock(); } catch {}lease.release(success);
    };
    const cancel = () => { void reader.cancel(options.signal?.reason).catch(() => {}).finally(() => finish(false)); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { finish(response.ok);controller.close();return; }
          if (response.status === 429 && !observedLimit && errorBytes <= MAX_ERROR_BYTES) {
            errorBytes += next.value.byteLength;
            if (errorBytes <= MAX_ERROR_BYTES) fragments.push(Buffer.from(next.value));else fragments = [];
          }
          controller.enqueue(next.value);
        } catch (error) { finish(false);controller.error(error); }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { finish(false); } },
    });
    if (options.signal?.aborted) cancel();
    // Streaming callers need only the observed body. Keep native metadata and
    // policy markers without rebuilding Headers for every stream. Native body
    // convenience methods and clone share one lazily created consumption view.
    let consumption;
    const result = new Proxy(response, { get(target, key) {
      if (key === "body") return consumption ? consumption.body : body;
      if (key === "bodyUsed") return consumption ? consumption.bodyUsed : isDisturbed(body);
      if (BODY_METHODS.has(key) && typeof target[key] === "function") return (...args) => {
        consumption ||= new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        return consumption[key](...args);
      };
      return Reflect.get(target, key, target);
    } });
    Object.defineProperty(result, SOURCE_STREAM_LIMIT, { value: error => {
      const value = sourceLimitFeedback(429, response.headers, { error }, now());if (value?.kind !== "unknown") lease.limit(value);
    } });
    return result;
  }
  return {
    run,
    wrap(client, descriptor) {
      if (!client || clients.has(client) || client[SOURCE_ADMISSION]?.scheduler === this) return clients.get(client) || client;
      const wrapped = { ...client };
      for (const method of ["responses", "responsesCompact", "messages", "chatCompletions", "images"]) {
        if (typeof client[method] !== "function") continue;
        wrapped[method] = (...args) => {
          const index = method === "images" ? 1 : 0, body = args[index], options = args[index + 1] || {};
          if (options.countTokens) return client[method](...args);
          return run(descriptor(), () => client[method](...args), { signal: options.signal, model: body?.model,
            client: currentRequestContext()?.application || "other", bytes: () => Buffer.byteLength(options.bodyText || JSON.stringify(body || {})) });
        };
      }
      wrapped[SOURCE_ADMISSION] = { scheduler: this, descriptor };
      clients.set(client, wrapped);return wrapped;
    },
    configure(source, limit) {
      if (!validLimit(limit)) throw failure("ccdx_source_limit_invalid", "Choose Auto or a maximum concurrency from 1 to 128.", 0, 400);
      if (limit === null) limits.delete(source);else limits.set(source, limit);
      for (const group of groups.values()) if (group.source === source) drain(group);
    },
    snapshot() {
      return [...groups.values()].map(group => ({ source: group.source, active: group.active, queued: group.queue.length,
        limit: capacity(group), maximum: limits.get(group.source) || null, mode: "auto", retry_after_ms: Math.max(0, group.pausedUntil - now()),
        reason: group.pausedUntil > now() ? group.reason : null, completed: group.completed, rejected: group.rejected,
        model_limits: [...group.models].filter(([, state]) => state.until > now() || state.limit < MAX_LIMIT)
          .map(([model, state]) => ({ model, limit: state.limit, retry_after_ms: Math.max(0, state.until - now()), reason: state.until > now() ? state.reason : null })) }));
    },
    close() { closed = true;for (const group of groups.values()) { clearTimeout(group.timer);for (const entry of [...group.queue]) entry.reject(failure("ccdx_source_closed", "The source scheduler is stopping.")); } },
  };
}
