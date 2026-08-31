import { Worker } from "node:worker_threads";
import { anthropicTokenText } from "./anthropic.mjs";
import { debugLog } from "./log.mjs";

export const DEFAULT_TOKEN_COUNTER_TIMEOUT_MS = 120 * 1000;
export const DEFAULT_TOKEN_COUNTER_MAX_QUEUED = 16;

function serviceError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

const DIAGNOSTIC_PHASES = new Set(["create", "worker", "error", "exit", "postMessage"]);
const DIAGNOSTIC_ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "WorkerExit"]);

export function tokenCounterWorkerDiagnostic(phase, error) {
  const safePhase = DIAGNOSTIC_PHASES.has(phase) ? phase : "unknown";
  let rawName;
  let rawCode;
  try { rawName = error?.name; } catch {}
  try { rawCode = error?.code; } catch {}
  const safeName = DIAGNOSTIC_ERROR_NAMES.has(rawName) ? rawName : "Error";
  if (typeof rawCode === "number") rawCode = String(rawCode);
  const safeCode = typeof rawCode === "string" && /^(?:\d+|[A-Z][A-Z0-9_]{0,63})$/.test(rawCode)
    ? rawCode
    : "unknown";
  return `Token counter worker failure: phase=${safePhase} name=${safeName} code=${safeCode}`;
}

function positiveInteger(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

export function tokenCounterWorkerExecArgv(execArgv = process.execArgv) {
  const filtered = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const value = execArgv[index];
    if (value === "--input-type") {
      index += 1;
      continue;
    }
    if (value.startsWith("--input-type=")) continue;
    filtered.push(value);
  }
  return filtered;
}

function createTokenCounterWorker() {
  const execArgv = tokenCounterWorkerExecArgv();
  const options = execArgv.length === process.execArgv.length ? undefined : { execArgv };
  return new Worker(new URL("./token-counter-worker.mjs", import.meta.url), options);
}

export function createTokenCounterService({
  timeoutMs = DEFAULT_TOKEN_COUNTER_TIMEOUT_MS,
  maxQueued = DEFAULT_TOKEN_COUNTER_MAX_QUEUED,
  workerFactory = createTokenCounterWorker,
} = {}) {
  timeoutMs = positiveInteger(timeoutMs, DEFAULT_TOKEN_COUNTER_TIMEOUT_MS);
  maxQueued = positiveInteger(maxQueued, DEFAULT_TOKEN_COUNTER_MAX_QUEUED);
  const queue = [];
  let worker = null;
  let active = null;
  let nextId = 1;
  let closed = false;

  const finish = (job, callback, value) => {
    if (job.finished) return;
    job.finished = true;
    if (job.timer) clearTimeout(job.timer);
    job.signal?.removeEventListener("abort", job.onAbort);
    callback(value);
  };

  const retireWorker = () => {
    const retired = worker;
    worker = null;
    if (!retired) return;
    retired.removeAllListeners();
    retired.on("error", () => {});
    Promise.resolve(retired.terminate()).catch(() => {});
  };

  const pump = () => {
    if (closed || active || queue.length === 0) return;
    if (!worker) {
      try {
        worker = workerFactory();
      } catch (error) {
        debugLog(tokenCounterWorkerDiagnostic("create", error));
        const job = queue.shift();
        if (job) finish(job, job.reject, serviceError("Token counter worker failed", 500));
        queueMicrotask(pump);
        return;
      }
      worker.on("message", (message) => {
        if (!active || message?.id !== active.id) return;
        const job = active;
        active = null;
        if (message.error) {
          debugLog(tokenCounterWorkerDiagnostic("worker", message.error));
          retireWorker();
          finish(job, job.reject, serviceError("Token counter worker failed", 500));
        } else {
          finish(job, job.resolve, message.result);
        }
        pump();
      });
      worker.on("error", (error) => {
        debugLog(tokenCounterWorkerDiagnostic("error", error));
        const job = active;
        active = null;
        retireWorker();
        if (job) finish(job, job.reject, serviceError("Token counter worker failed", 500));
        pump();
      });
      worker.on("exit", (code) => {
        if (active) debugLog(tokenCounterWorkerDiagnostic("exit", { name: "WorkerExit", code }));
        const job = active;
        active = null;
        worker = null;
        if (job) finish(job, job.reject, serviceError("Token counter worker failed", 500));
        pump();
      });
      worker.unref?.();
    }
    const job = queue.shift();
    if (!job || job.finished) return pump();
    active = job;
    try {
      worker.postMessage({ id: job.id, text: job.text });
      job.text = null;
    } catch (error) {
      debugLog(tokenCounterWorkerDiagnostic("postMessage", error));
      active = null;
      retireWorker();
      finish(job, job.reject, serviceError("Token counter worker failed", 500));
      pump();
    }
  };

  const cancel = (job, error) => {
    if (job.finished) return;
    const queuedIndex = queue.indexOf(job);
    if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
    if (active === job) {
      active = null;
      retireWorker();
    }
    finish(job, job.reject, error);
    pump();
  };

  return {
    count(body, { signal, deadlineMs = timeoutMs } = {}) {
      if (closed) return Promise.reject(serviceError("Token counter service is closed", 503));
      if (signal?.aborted) return Promise.reject(abortError(signal));
      let text;
      try {
        text = anthropicTokenText(body);
      } catch {
        return Promise.reject(serviceError("Invalid count_tokens request", 400));
      }
      if (active && queue.length >= maxQueued) {
        return Promise.reject(serviceError(`Token counter queue is full (${maxQueued} waiting)`, 503));
      }
      return new Promise((resolve, reject) => {
        deadlineMs = positiveInteger(deadlineMs, timeoutMs);
        const job = {
          id: nextId++,
          text,
          signal,
          resolve,
          reject,
          finished: false,
          timer: null,
          onAbort: null,
        };
        job.onAbort = () => cancel(job, abortError(signal));
        signal?.addEventListener("abort", job.onAbort, { once: true });
        job.timer = setTimeout(() => {
          cancel(job, serviceError(`Token counting timed out after ${deadlineMs}ms`, 504));
        }, deadlineMs);
        queue.push(job);
        if (signal?.aborted) job.onAbort();
        else pump();
      });
    },
    close() {
      if (closed) return;
      closed = true;
      const error = serviceError("Token counter service is closed", 503);
      if (active) {
        const job = active;
        active = null;
        finish(job, job.reject, error);
      }
      for (const job of queue.splice(0)) finish(job, job.reject, error);
      retireWorker();
    },
    stats() {
      return { active: active ? 1 : 0, queued: queue.length, worker: worker ? 1 : 0 };
    },
  };
}
