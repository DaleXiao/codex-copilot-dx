// Runtime evidence only. No prompts, image paths, credentials or raw chat IDs.
export function createImageHostState({ now = Date.now, alive = pid => { try { process.kill(pid, 0);return true; } catch { return false; } } } = {}) {
  const hosts = new Map();
  return {
    report(value) {
      if (!value || Object.keys(value).some(key => !["id", "pid", "event", "thread"].includes(key))
        || !/^[a-f0-9-]{36}$/.test(value.id || "") || !Number.isSafeInteger(value.pid) || value.pid < 1
        || !["connected", "registered", "generated", "failed", "closed"].includes(value.event)
        || value.thread !== undefined && !/^[a-f0-9]{32}$/.test(value.thread)) throw new Error("Invalid image host evidence");
      const previous = hosts.get(value.id);
      if (previous && previous.pid !== value.pid) throw new Error("Image host identity changed");
      const host = previous || { id: value.id, pid: value.pid, connected: false, threads: [] };
      // A later tool event also proves this host is live, including when CCDX
      // restarted after the host's initial connection report.
      if (["connected", "registered", "generated", "failed"].includes(value.event)) host.connected = true;
      if (value.event === "closed") host.connected = false;
      if (value.event === "registered" && value.thread && !host.threads.includes(value.thread)) host.threads = [...host.threads, value.thread].slice(-32);
      host.event = value.event;host.updated_at = now();
      hosts.delete(value.id);hosts.set(value.id, host);
      if (hosts.size > 16) hosts.delete(hosts.keys().next().value);
    },
    snapshot() {
      const values = [...hosts.values()].map(host => ({ ...host, threads: [...host.threads], connected: host.connected && alive(host.pid) }));
      const connected = values.filter(host => host.connected);
      return { connected: connected.length > 0, tool_registration: connected.some(host => host.threads.length) ? "observed" : "unconfirmed", hosts: values };
    },
  };
}
