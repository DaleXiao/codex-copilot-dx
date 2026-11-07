export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

// Downstream-only SSE comments. Never read upstream, alter its deadlines, or
// write before valid stream headers / between pieces of a partially written frame.
export function createSseKeepalive({
  res, signal, canWrite = () => true, intervalMs = SSE_KEEPALIVE_INTERVAL_MS,
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
        // One small, complete comment is bounded even if this write reaches the
        // high-water mark; no further comments are sent while backpressured.
        res.write(": ccdx keepalive\n\n");
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
