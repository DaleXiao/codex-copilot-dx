const APPS = new Set(["codex", "claude_app", "antigravity"]);

// Only accepted protocol metadata. No bodies, tokens, headers or raw chat IDs.
export function createApplicationEvidence({ now = Date.now } = {}) {
  const candidates = new Map(), confirmed = new Map();
  const accept = (req, app, scope, at = now()) => {
    if (!APPS.has(app) || !["catalog", "inference", "control"].includes(scope)) return;
    const peerPort = req?.socket?.remotePort, port = req?.socket?.localPort;
    if (!Number.isInteger(peerPort) || !Number.isInteger(port)) return;
    const key = `${port}:${peerPort}`;candidates.delete(key);candidates.set(key, { app, scope, peerPort, port, at });
    while (candidates.size > 256) candidates.delete(candidates.keys().next().value);
  };
  return {
    accept,
    notice(req, res, app, scope) {
      if (!APPS.has(app) || !["catalog", "inference", "control"].includes(scope)) return;
      const peerPort = req.socket?.remotePort, port = req.socket?.localPort;
      if (!Number.isInteger(peerPort) || !Number.isInteger(port)) return;
      const event = { app, scope, peerPort, port, at: now() };
      res.once("finish", () => {
      if (!Number.isInteger(res.statusCode) || res.statusCode < 200 || res.statusCode >= 300) return;
        const key = `${port}:${peerPort}`;candidates.delete(key);candidates.set(key, event);
        while (candidates.size > 256) candidates.delete(candidates.keys().next().value);
      });
    },
    inspect(app, process, connections, revision, since = 0) {
      if (!process?.pid || !process.started) { confirmed.delete(app);return { state: "pending" }; }
      const identity = `${process.pid}:${process.started}`;
      const previous = confirmed.get(app);
      if (previous?.identity === identity && previous.revision === revision && previous.at >= since && now() - previous.at < 300000) return { state: "observed", scope: previous.scope, at: new Date(previous.at).toISOString() };
      confirmed.delete(app);
      for (const [key, event] of candidates) {
        if (now() - event.at > 300000) { candidates.delete(key);continue; }
        if (event.app !== app || event.at < Math.max(since, Date.parse(process.started))) continue;
        if (!connections.some(connection => connection.port === event.port && connection.peerPort === event.peerPort)) continue;
        confirmed.set(app, { ...event, identity, revision });return { state: "observed", scope: event.scope, at: new Date(event.at).toISOString() };
      }
      return { state: "pending" };
    },
    clear(app) { confirmed.delete(app);for (const [key, event] of candidates) if (event.app === app) candidates.delete(key); },
  };
}
