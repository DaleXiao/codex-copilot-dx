// An explicit projection, never a partial replacement for the full diagnostic
// snapshot. Old callers keep the complete status contract by default.
export function statusSummary(snapshot) {
  return Object.fromEntries([...['ok', 'name', 'version', 'pid', 'uptime_ms', 'model_activity', 'runtime_usage']
    .map(key => [key, snapshot[key]]), ['scope', 'summary']]);
}
