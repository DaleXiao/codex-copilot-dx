// Notifications carry no request payloads and cannot interrupt inference.
export function createChangeSignal() {
  const listeners = new Set();
  return {
    subscribe(listener) { listeners.add(listener);return () => listeners.delete(listener); },
    changed() { for (const listener of listeners) { try { listener(); } catch {} } },
  };
}

export const ACTIVITY_EVENTS_PATH = "/_ccdx/activity";

export function createActivityEvents({ snapshot, sources, timers = { setTimeout, clearTimeout, setInterval, clearInterval } }) {
  const listeners = new Set(), streams = new Set();
  let pending = null, subscriptions = [], closed = false;
  function publish() {
    pending = null;
    if (!listeners.size || closed) return;
    try {
      const value = snapshot();
      for (const listener of listeners) { try { listener(value); } catch {} }
    } catch { /* The next change or reconnect reads a fresh snapshot. */ }
  }
  function changed() {
    if (closed || !listeners.size || pending) return;
    pending = timers.setTimeout(publish, 50);pending?.unref?.();
  }
  function subscribe(listener) {
    if (closed) return () => {};
    listeners.add(listener);
    if (listeners.size === 1) subscriptions = sources.filter(Boolean).map(source => source.subscribe?.(changed)).filter(Boolean);
    try { listener(snapshot()); } catch {}
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        for (const unsubscribe of subscriptions) unsubscribe();subscriptions = [];
        if (pending) timers.clearTimeout(pending);pending = null;
      }
    };
  }
  function serve(req, res) {
    if (closed || streams.size >= 8) { res.writeHead(503, { "Retry-After": "5" });res.end();return; }
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.flushHeaders?.();
    let blocked = false, latest = null, disposed = false, unsubscribe = () => {};
    const write = (event, value) => {
      if (disposed) return;
      if (blocked) { latest = value;return; }
      try { blocked = !res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); }
      catch { close(); }
    };
    const drain = () => { blocked = false;if (latest) { const value = latest;latest = null;write("activity", value); } };
    const heartbeat = timers.setInterval(() => {
      if (blocked) { close();return; }
      write("heartbeat", { at: Date.now() });
    }, 15000);heartbeat?.unref?.();
    function close() {
      if (disposed) return;
      disposed = true;streams.delete(close);unsubscribe();latest = null;
      timers.clearInterval(heartbeat);res.off?.("drain", drain);res.off?.("close", close);res.off?.("error", close);
      if (blocked) res.destroy?.();
      else if (!res.destroyed) res.end();
    }
    streams.add(close);res.on("drain", drain);res.once("close", close);res.once("error", close);
    unsubscribe = subscribe(value => write("activity", value));
    if (disposed) unsubscribe();
  }
  return {
    subscribe, serve,
    close() {
      closed = true;for (const close of streams) close();
      for (const unsubscribe of subscriptions) unsubscribe();subscriptions = [];listeners.clear();
      if (pending) timers.clearTimeout(pending);pending = null;
    },
  };
}
