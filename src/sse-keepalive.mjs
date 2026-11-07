import { requestApplication } from "./request-application.mjs";

export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;
export const SSE_KEEPALIVE_COMMENT = ": ccdx keepalive\n\n";
export const CODEX_RESPONSE_KEEPALIVE = 'event: response.in_progress\ndata: {"type":"response.in_progress"}\n\n';

export function responseKeepaliveFrame(headers) {
  return ["codex_app", "codex_cli", "codex"].includes(requestApplication(headers)) ? CODEX_RESPONSE_KEEPALIVE : SSE_KEEPALIVE_COMMENT;
}

// Downstream-only SSE heartbeats. Never read upstream, alter its deadlines, or
// write before valid stream headers / between pieces of a partially written frame.
export function createSseKeepalive({
  res, signal, canWrite = () => true, intervalMs = SSE_KEEPALIVE_INTERVAL_MS,
  frame = SSE_KEEPALIVE_COMMENT,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let timer = null;
  let stopped = false;
  let lastWrite = now();
  const stop = () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    signal?.removeEventListener("abort", stop);
  };
  const schedule = (delay) => {
    timer = setTimer(tick, Math.max(1, delay));
    timer?.unref?.();
  };
  const tick = () => {
    timer = null;
    if (stopped || signal?.aborted || res?.destroyed || res?.writableEnded) return stop();
    const idle = Math.max(0, now() - lastWrite);
    try {
      if (idle >= intervalMs && res?.headersSent && !res.writableNeedDrain && canWrite()) {
        // One small, complete frame is bounded even if this write reaches the
        // high-water mark; no further heartbeats are sent while backpressured.
        res.write(frame);
        lastWrite = now();
      }
    } catch { return stop(); }
    const elapsed = Math.max(0, now() - lastWrite);
    schedule(elapsed >= intervalMs ? intervalMs : intervalMs - elapsed);
  };
  if (Number.isFinite(intervalMs) && intervalMs > 0 && !signal?.aborted) {
    signal?.addEventListener("abort", stop, { once: true });
    schedule(intervalMs);
  }
  return { activity: () => { lastWrite = now(); }, stop };
}
