import {adapterHealthPayload} from "./running-adapter.mjs";
import {activeModels} from "./observability.mjs";
import {runtimeUsageSnapshot} from "./usage.mjs";

export function runtimeStatusSummary(requests, activeImages) {
  return statusSummary({
    ...adapterHealthPayload(),
    uptime_ms: Math.round(process.uptime() * 1000),
    model_activity: { active: activeModels(requests, activeImages) },
    runtime_usage: runtimeUsageSnapshot(),
  });
}

// An explicit projection, never a partial replacement for the full diagnostic
// snapshot. Old callers keep the complete status contract by default.
export function statusSummary(snapshot) {
  return Object.fromEntries([...['ok', 'name', 'version', 'pid', 'instance_id', 'uptime_ms', 'model_activity', 'runtime_usage']
    .map(key => [key, snapshot[key]]), ['scope', 'summary']]);
}
